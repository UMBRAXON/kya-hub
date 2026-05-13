// ============================================================================
// UMBRAXON KYA-Hub — Abuse Tracker (Phase 2.2)
// ============================================================================
// Centralizovaný "watchdog" pre podozrivé správanie. Funkcie:
//
//   1. recordRejection({...})    — append do rejected_requests + per-IP counter
//   2. checkIpBan(ip)            — vráti aktívny ban alebo null
//   3. checkBadSigsForKya(kya)   — počet bad sigs v okne 1h
//   4. shouldAutoBanIp(ip)       — heuristika: ban worthy?
//   5. autoBanIp(ip, reason)     — vytvorí ban v DB + invalidne cache
//   6. autoSlashAgent(kya)       — slash cez repEngine pri kritickom prahu
//
// Cache: in-memory Map pre rýchle lookup-y; ban check je hot path.
// ============================================================================
const repEngine = require('./reputation-engine');
const reputation = require('./reputation');

// === Konfigurácia (môže byť overridnutá cez .env) ===
const CFG = {
    // Auto-ban thresholds
    IP_BAN_GROSS_VIOLATIONS_10MIN: parseInt(process.env.IP_BAN_GROSS_10MIN || '20', 10),
    IP_BAN_TOTAL_REJECTIONS_10MIN: parseInt(process.env.IP_BAN_TOTAL_10MIN || '100', 10),
    IP_BAN_DURATION_HOURS: parseInt(process.env.IP_BAN_DURATION_HOURS || '1', 10),
    
    // Bad-sig auto-slash thresholds
    BAD_SIG_PER_HOUR_THRESHOLD: parseInt(process.env.BAD_SIG_PER_HOUR || '10', 10),
    BAD_SIG_AUTO_SLASH_DELTA: parseInt(process.env.BAD_SIG_AUTO_SLASH || '-100', 10),
    
    // Anomaly detection
    ANOMALY_TARGET_SPAM_THRESHOLD: parseInt(process.env.ANOMALY_TARGET_SPAM || '50', 10),  // 50+ rovnaký target za hodinu
    ANOMALY_AUTO_SLASH_DELTA: parseInt(process.env.ANOMALY_AUTO_SLASH || '-50', 10),
};

// Loopback a interné IPky sa nikdy neauto-banujú (testy, monitoring, lokálny dev).
// Manuálny admin ban tieto IPky stále môže banovať explicitne.
const IMMUNE_IPS = new Set([
    '127.0.0.1', '::1', '0.0.0.0',
    ...((process.env.IP_BAN_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)),
]);
function isImmuneIp(ip) {
    if (!ip) return false;
    return IMMUNE_IPS.has(String(ip));
}

// === Severita rejection reasons (určuje aký rýchlo eskaluje IP ban) ===
const SEVERITY = {
    // Critical — okamžitý kandidát na ban (forge/abuse pokus)
    BAD_ADMIN_KEY:          'critical',
    BAD_HMAC_SIGNATURE:     'critical',
    BAD_BOT_SIGNATURE:      'high',
    REPORTER_SIGNATURE_INVALID: 'high',
    BAD_CHALLENGE_RESPONSE: 'high',
    BAD_SIGNATURE:          'high',
    BAD_MANIFEST_SIGNATURE: 'high',
    
    // Medium — replay/protocol violations
    REPLAY:                 'medium',
    CHALLENGE_ALREADY_USED: 'medium',
    CHALLENGE_EXPIRED:      'medium',
    MANIFEST_TIMESTAMP_SKEW: 'medium',
    PUBKEY_MISMATCH:        'medium',
    REPORTER_PUBKEY_MISMATCH_DB: 'medium',
    
    // Low — protocol errors (mostly client bugs)
    MANIFEST_INVALID:       'low',
    INVALID_TIER:           'low',
    INVALID_KYA_ID:         'low',
    MISSING_FIELDS:         'low',
    INVALID_NONCE_FORMAT:   'low',
    AGENT_NOT_FOUND:        'low',
    
    // Rate limits — informational
    RATE_LIMITED:           'low',
    PROBATION_RATE_LIMIT:   'low',
};

function getSeverity(reason) {
    return SEVERITY[reason] || 'low';
}

// === In-memory ban cache pre hot path (ip → { until_ms, reason }) ===
const _banCache = new Map();
// Refresh cache každú minútu z DB
let _cacheRefreshing = false;

async function refreshBanCache(pool) {
    if (_cacheRefreshing) return;
    _cacheRefreshing = true;
    try {
        const r = await pool.query(
            `SELECT client_ip::text AS ip, reason, expires_at
             FROM ip_bans
             WHERE revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > NOW())`
        );
        _banCache.clear();
        for (const row of r.rows) {
            _banCache.set(row.ip, {
                until_ms: row.expires_at ? new Date(row.expires_at).getTime() : Infinity,
                reason: row.reason,
            });
        }
    } catch (e) {
        // best-effort
    } finally {
        _cacheRefreshing = false;
    }
}

/**
 * Synchronný check (využíva in-memory cache).
 * Pre absolútnu istotu by sa volal DB check, ale tu uprednostňujeme rýchlosť.
 */
function checkIpBan(ip) {
    if (!ip) return null;
    const entry = _banCache.get(String(ip));
    if (!entry) return null;
    if (entry.until_ms < Date.now()) {
        _banCache.delete(String(ip));
        return null;
    }
    return entry;
}

/**
 * Zaznamenaj zamietnutý request.
 */
async function recordRejection(pool, {
    path, method, reason, http_status, kya_id, client_ip, user_agent, error_detail, metadata
}) {
    if (!client_ip || !reason) return;
    const severity = getSeverity(reason);
    try {
        await pool.query(
            `INSERT INTO rejected_requests
             (path, method, reason, http_status, severity, client_ip, kya_id, user_agent, error_detail, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                path, method, reason, http_status, severity,
                client_ip, kya_id || null, user_agent || null,
                error_detail ? String(error_detail).slice(0, 500) : null,
                metadata ? JSON.stringify(metadata) : null,
            ]
        );
        
        // Trigger fail2ban check ak je severity high/critical
        if (severity === 'critical' || severity === 'high' || severity === 'medium') {
            await maybeAutoBanIp(pool, client_ip);
        }
    } catch (_) { /* never let logging break the response */ }
}

/**
 * Skontroluj či IP zaslúži ban. Ak áno, ban-ne ho.
 * Loopback IPs (127.0.0.1, ::1) sú immune — nikdy nedostanú auto-ban.
 */
async function maybeAutoBanIp(pool, client_ip) {
    if (isImmuneIp(client_ip)) return null;
    try {
        const r = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE severity IN ('critical','high') AND occurred_at > NOW() - INTERVAL '10 minutes') AS gross,
                COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '10 minutes') AS total
             FROM rejected_requests WHERE client_ip = $1`,
            [client_ip]
        );
        const { gross, total } = r.rows[0];
        const grossN = parseInt(gross, 10);
        const totalN = parseInt(total, 10);
        
        let banReason = null;
        if (grossN >= CFG.IP_BAN_GROSS_VIOLATIONS_10MIN) banReason = 'AUTO_FAIL2BAN_GROSS';
        else if (totalN >= CFG.IP_BAN_TOTAL_REJECTIONS_10MIN) banReason = 'AUTO_FAIL2BAN_VOLUME';
        if (!banReason) return null;
        
        // Skontroluj že IP ešte nie je banned
        const existing = await pool.query(
            `SELECT id FROM ip_bans WHERE client_ip = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
            [client_ip]
        );
        if (existing.rowCount > 0) return null; // už banned
        
        const expiresAt = new Date(Date.now() + CFG.IP_BAN_DURATION_HOURS * 3600 * 1000);
        await pool.query(
            `INSERT INTO ip_bans (client_ip, reason, severity, rejection_count, expires_at, notes)
             VALUES ($1, $2, 'high', $3, $4, $5)`,
            [client_ip, banReason, grossN + totalN, expiresAt,
             `Auto-ban: ${grossN} gross + ${totalN} total rejections za 10 min`]
        );
        _banCache.set(String(client_ip), { until_ms: expiresAt.getTime(), reason: banReason });
        return { banned: true, reason: banReason, expires_at: expiresAt };
    } catch (_) { return null; }
}

/**
 * Zaznamenaj signature failure pre konkrétneho agenta + skontroluj auto-slash threshold.
 */
async function recordSignatureFailure(pool, { kya_id, client_ip, endpoint, failure_type, logger }) {
    if (!kya_id) return;
    try {
        await pool.query(
            `INSERT INTO signature_failures (kya_id, client_ip, endpoint, failure_type) VALUES ($1, $2, $3, $4)`,
            [kya_id, client_ip || null, endpoint, failure_type]
        );
        
        // Check threshold
        const r = await pool.query(
            `SELECT COUNT(*) AS n FROM signature_failures
             WHERE kya_id = $1 AND occurred_at > NOW() - INTERVAL '1 hour'`,
            [kya_id]
        );
        const n = parseInt(r.rows[0].n, 10);
        if (n >= CFG.BAD_SIG_PER_HOUR_THRESHOLD) {
            // Auto-slash, len ak agent ešte nie je SUSPENDED
            const agentRow = await pool.query(
                `SELECT id, status, reputation_score FROM agents WHERE kya_id = $1`, [kya_id]
            );
            if (agentRow.rowCount === 0) return;
            if (agentRow.rows[0].status === 'SUSPENDED') return;
            
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await repEngine.applyEvent(client, {
                    agent_id: agentRow.rows[0].id, kya_id,
                    event_type: 'PROTOCOL_VIOLATION',
                    source: 'system',
                    delta: CFG.BAD_SIG_AUTO_SLASH_DELTA,
                    reason: `Auto-slash: ${n} signature failures za hodinu (threshold ${CFG.BAD_SIG_PER_HOUR_THRESHOLD})`,
                    evidence: { failures_count: n, endpoint, failure_type },
                });
                // Cleanup starých failures po slashing (aby agent po restorovaní nemal hneď duplicate slash)
                await client.query(
                    `DELETE FROM signature_failures WHERE kya_id = $1`,
                    [kya_id]
                );
                await client.query('COMMIT');
                if (logger) logger.warn({ kya_id, failures: n }, 'auto-slashed for repeated signature failures');
            } catch (e) {
                await client.query('ROLLBACK');
                if (logger) logger.error({ err: e.message, kya_id }, 'auto-slash FAIL');
            } finally {
                client.release();
            }
        }
    } catch (_) { /* never break the response */ }
}

/**
 * Admin manual ban.
 */
async function adminBanIp(pool, { client_ip, duration_hours, reason, admin_user }) {
    const expiresAt = duration_hours ? new Date(Date.now() + duration_hours * 3600 * 1000) : null;
    const r = await pool.query(
        `INSERT INTO ip_bans (client_ip, reason, severity, expires_at, banned_by, notes)
         VALUES ($1, 'ADMIN_MANUAL', 'high', $2, $3, $4)
         RETURNING id`,
        [client_ip, expiresAt, admin_user || 'admin', reason || null]
    );
    _banCache.set(String(client_ip), {
        until_ms: expiresAt ? expiresAt.getTime() : Infinity,
        reason: 'ADMIN_MANUAL',
    });
    return { ban_id: r.rows[0].id, expires_at: expiresAt };
}

async function adminUnbanIp(pool, { client_ip, admin_user, reason }) {
    const r = await pool.query(
        `UPDATE ip_bans
         SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2, revoke_reason = $3
         WHERE client_ip = $1 AND revoked_at IS NULL
         RETURNING id`,
        [client_ip, admin_user || 'admin', reason || null]
    );
    _banCache.delete(String(client_ip));
    return { unbanned_count: r.rowCount };
}

/**
 * Express middleware factory: kontrola IP banu PRED akýmkoľvek ďalším spracovaním.
 */
function buildIpBanMiddleware({ poolGetter, exemptPaths = [] }) {
    return async function ipBanCheck(req, res, next) {
        const ip = req.ip;
        if (!ip) return next();
        if (exemptPaths.some(p => req.path === p || req.path.startsWith(p))) return next();
        
        const ban = checkIpBan(ip);
        if (ban) {
            // Audit aj samotný attempt prísť keď banned
            await recordRejection(poolGetter(), {
                path: req.path, method: req.method, reason: 'IP_BANNED',
                http_status: 403, client_ip: ip, user_agent: req.headers['user-agent'],
                error_detail: `Ban reason: ${ban.reason}`,
            });
            return res.status(403).json({
                error: 'IP_BANNED',
                ban_reason: ban.reason,
                expires_at: ban.until_ms === Infinity ? null : new Date(ban.until_ms).toISOString(),
                message: 'Vaša IP je dočasne zablokovaná pre opakované violations.',
            });
        }
        next();
    };
}

/**
 * Anomaly detection: hľadanie target spam-u (rovnaký target 50+ za hodinu).
 * Volaný z decay-worker periodicky.
 */
async function detectAnomalies(pool, logger) {
    const stats = { scanned: 0, flagged: 0, slashed: 0 };
    try {
        // Nájdi (kya_id, target) páry s 50+ entries za hodinu, kde target nie je NULL
        // a kde ešte žiadny záznam nebol flagged
        const r = await pool.query(
            `SELECT kya_id, target, COUNT(*) AS n
             FROM action_log
             WHERE target IS NOT NULL
               AND received_at > NOW() - INTERVAL '1 hour'
               AND anomaly_flagged = FALSE
             GROUP BY kya_id, target
             HAVING COUNT(*) >= $1
             LIMIT 50`,
            [CFG.ANOMALY_TARGET_SPAM_THRESHOLD]
        );
        stats.scanned = r.rowCount;
        
        for (const row of r.rows) {
            try {
                const agentRow = await pool.query(
                    `SELECT id, status FROM agents WHERE kya_id = $1`, [row.kya_id]
                );
                if (agentRow.rowCount === 0) continue;
                if (agentRow.rows[0].status === 'SUSPENDED') continue;
                
                // Flag actions
                await pool.query(
                    `UPDATE action_log SET anomaly_flagged = TRUE, anomaly_reason = $1
                     WHERE kya_id = $2 AND target = $3 AND received_at > NOW() - INTERVAL '1 hour'`,
                    [`Target spam: ${row.n}× same target`, row.kya_id, row.target]
                );
                stats.flagged += parseInt(row.n, 10);
                
                // Auto-slash
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await repEngine.applyEvent(client, {
                        agent_id: agentRow.rows[0].id, kya_id: row.kya_id,
                        event_type: 'PROTOCOL_VIOLATION',
                        source: 'system',
                        delta: CFG.ANOMALY_AUTO_SLASH_DELTA,
                        reason: `Anomaly: ${row.n}× same target "${String(row.target).slice(0, 40)}" za hodinu`,
                        evidence: { target: row.target, count: row.n },
                    });
                    await client.query('COMMIT');
                    stats.slashed++;
                    if (logger) logger.warn({ kya_id: row.kya_id, target: row.target, count: row.n }, 'anomaly: target spam → auto-slash');
                } catch (e) {
                    await client.query('ROLLBACK');
                } finally {
                    client.release();
                }
            } catch (_) { /* skip this row */ }
        }
    } catch (e) {
        if (logger) logger.error({ err: e.message }, 'anomaly detection FAIL');
    }
    return stats;
}

/**
 * Cleanup starých záznamov (volaný worker-om).
 */
async function cleanupOldRecords(pool) {
    const stats = {};
    try {
        const r1 = await pool.query(`DELETE FROM rejected_requests WHERE occurred_at < NOW() - INTERVAL '30 days'`);
        stats.rejected_pruned = r1.rowCount;
        const r2 = await pool.query(`DELETE FROM signature_failures WHERE occurred_at < NOW() - INTERVAL '24 hours'`);
        stats.sigfails_pruned = r2.rowCount;
        const r3 = await pool.query(`DELETE FROM pow_challenges WHERE expires_at < NOW() - INTERVAL '1 hour' AND solved_at IS NULL`);
        stats.pow_pruned = r3.rowCount;
    } catch (_) { /* */ }
    return stats;
}

/**
 * Start background refresh of ban cache (každú minútu).
 */
function startCacheRefresh(pool, logger) {
    refreshBanCache(pool); // initial load
    const t = setInterval(() => refreshBanCache(pool), 60 * 1000);
    if (typeof t.unref === 'function') t.unref();
    if (logger) logger.info('abuse-tracker: ban cache refresh started (60s interval)');
    return t;
}

module.exports = {
    CFG,
    SEVERITY,
    IMMUNE_IPS,
    isImmuneIp,
    recordRejection,
    recordSignatureFailure,
    checkIpBan,
    maybeAutoBanIp,
    adminBanIp,
    adminUnbanIp,
    buildIpBanMiddleware,
    detectAnomalies,
    cleanupOldRecords,
    refreshBanCache,
    startCacheRefresh,
    _internal: { banCache: _banCache },
};
