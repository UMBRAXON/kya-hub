// ============================================================================
// UMBRAXON KYA-Hub — Inactivity Decay Worker (Phase 2)
// ============================================================================
// In-process cron ktorý raz za deň:
//   1. Nájde agentov bez heartbeat 14+ dní → DECAY_WARN (-1)
//   2. Nájde agentov bez heartbeat 30+ dní → DECAY_HEAVY (-5)
//   3. Po 60 dňoch → flag is_dormant=TRUE, žiadny ďalší decay (ale agent prestane byť operational kým neurobí heartbeat)
//   4. Loyalty bonus: bot s heartbeatom v posledných 24h dostane +5 za týždeň aktivity
//
// Worker beží v rámci hlavného Node procesu (žiadny externý cron).
// Štartuje sa volaním start(logger, pool) z server.js po app.listen.
// ============================================================================
const reputation = require('./reputation');
const repEngine = require('./reputation-engine');
const abuseTracker = require('./abuse-tracker');
const appealService = require('./appeal-service');
const retentionWorker = require('./retention-worker');
const eliteListing = require('./elite-listing');

const DAY_MS = 24 * 3600 * 1000;

// Phase 2.4: posledný retention run timestamp (in-memory). Retention beží 1×/24h.
let _lastRetentionRun = 0;
const RETENTION_INTERVAL_MS = parseInt(process.env.RETENTION_INTERVAL_MS || String(24 * 3600 * 1000), 10);
// Beh každú hodinu — ale skutočná aplikácia (per agent) prebehne max raz za 24h
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Pre testovanie sa dá zrýchliť cez DECAY_INTERVAL_MS env premennú
const REAL_INTERVAL = parseInt(process.env.DECAY_INTERVAL_MS || String(CHECK_INTERVAL_MS), 10);

let _started = false;
let _timer = null;
let _runningTick = false;

/**
 * Jedna iterácia worker-a. Bezpečne re-entrant: ak prebieha minulý tick, skipne.
 */
async function tick(logger, pool) {
    if (_runningTick) {
        logger.debug({ worker: 'decay' }, 'tick already running, skipping');
        return;
    }
    _runningTick = true;
    const log = logger.child({ worker: 'decay-tick' });
    
    const stats = {
        scanned: 0,
        decayed_warn: 0,
        decayed_heavy: 0,
        dormant: 0,
        loyalty_bonus: 0,
        suspended: 0,
        errors: 0,
        anomaly: null,
        cleanup: null,
    };
    
    try {
        // Načítaj všetkých aktívnych agentov ktorí ešte nie sú SUSPENDED
        const r = await pool.query(
            `SELECT id, kya_id, reputation_score, last_heartbeat_at, is_dormant,
                    last_score_change_at, heartbeat_count, tier
             FROM agents
             WHERE is_active = TRUE AND status NOT IN ('SUSPENDED', 'REVOKED')
             ORDER BY id`
        );
        stats.scanned = r.rowCount;
        
        const now = Date.now();
        const { warnAfterDays, heavyAfterDays, dormantAfterDays } = reputation.INACTIVITY_DECAY;
        
        for (const agent of r.rows) {
            try {
                await processAgent(pool, agent, now, warnAfterDays, heavyAfterDays, dormantAfterDays, stats, log);
            } catch (e) {
                stats.errors++;
                log.error({ err: e.message, kya_id: agent.kya_id }, 'agent processing failed');
            }
        }
        
        // Phase 2.2: Anomaly detection — target spam v action_log
        try {
            stats.anomaly = await abuseTracker.detectAnomalies(pool, log);
        } catch (e) {
            log.error({ err: e.message }, 'anomaly detection FAIL');
        }
        
        // Phase 2.2: Cleanup starých záznamov (rejected_requests > 30d, sigfails > 24h, pow > 1h)
        try {
            stats.cleanup = await abuseTracker.cleanupOldRecords(pool);
        } catch (e) {
            log.error({ err: e.message }, 'abuse cleanup FAIL');
        }
        
        // Phase 2.3: SLA auto-uphold pre expired appeals + cleanup heartbeats_log (>1d)
        try {
            stats.appeal_sla = await appealService.processSlaExpirations(pool, repEngine, log);
        } catch (e) {
            log.error({ err: e.message }, 'appeal SLA tick FAIL');
        }
        try {
            const hb = await pool.query(`DELETE FROM heartbeats_log WHERE received_at < NOW() - INTERVAL '1 day'`);
            if (hb.rowCount > 0) log.debug({ deleted: hb.rowCount }, 'old heartbeats_log cleaned');
            stats.heartbeats_cleaned = hb.rowCount;
        } catch (e) {
            log.error({ err: e.message }, 'heartbeats cleanup FAIL');
        }
        
        // Phase 2.4: retention worker — archive + delete starých logov (1×/24h)
        try {
            const sinceLast = Date.now() - _lastRetentionRun;
            if (sinceLast >= RETENTION_INTERVAL_MS) {
                stats.retention = await retentionWorker.tick(pool, log);
                _lastRetentionRun = Date.now();
            } else {
                stats.retention = { skipped: true, next_run_in_ms: RETENTION_INTERVAL_MS - sinceLast };
            }
        } catch (e) {
            log.error({ err: e.message }, 'retention worker FAIL');
        }
        
        try {
            stats.elite_listing_sweep = await eliteListing.sweep(pool, log);
        } catch (e) {
            log.error({ err: e.message }, 'elite listing sweep FAIL');
        }

        log.info({ stats }, 'decay tick completed');
    } catch (e) {
        log.error({ err: e.message, stack: e.stack }, 'decay tick FAIL');
    } finally {
        _runningTick = false;
    }
    
    return stats;
}

async function processAgent(pool, agent, now, warnDays, heavyDays, dormantDays, stats, log) {
    // Ak agent ešte neposlal žiadny heartbeat, počítame od momentu jeho posledného score change
    // (väčšinou cert issuance) — tým mu dáme grace period rovnaký ako pre aktívnych agentov.
    const referenceMs = agent.last_heartbeat_at
        ? new Date(agent.last_heartbeat_at).getTime()
        : agent.last_score_change_at
            ? new Date(agent.last_score_change_at).getTime()
            : now;
    
    const inactiveDays = Math.floor((now - referenceMs) / DAY_MS);
    
    // === DORMANT ===
    if (inactiveDays >= dormantDays && !agent.is_dormant) {
        await pool.query(
            `UPDATE agents SET is_dormant = TRUE WHERE id = $1`,
            [agent.id]
        );
        // Audit log
        await pool.query(
            `INSERT INTO reputation_events (agent_id, kya_id, event_type, source, delta,
                                             score_before, score_after, zone_before, zone_after, reason)
             VALUES ($1, $2, 'DORMANT_FLAGGED', 'system', 0, $3, $3, $4, $4, $5)`,
            [agent.id, agent.kya_id, agent.reputation_score,
             reputation.zoneOf(agent.reputation_score),
             `Agent neaktívny ${inactiveDays} dní → DORMANT (žiadny ďalší decay, ale potrebný heartbeat na operations)`]
        );
        stats.dormant++;
        log.warn({ kya_id: agent.kya_id, days: inactiveDays }, 'agent → DORMANT');
        return;
    }
    
    // Ak je už DORMANT, neaplikujeme decay (uznané ako "uspaté", nie ako trest)
    if (agent.is_dormant) return;
    
    // === HEAVY DECAY (30+ dní) ===
    if (inactiveDays >= heavyDays) {
        await applyDecay(pool, agent, 'DECAY_HEAVY', reputation.SLASHING.DECAY_HEAVY, inactiveDays, stats, log);
        stats.decayed_heavy++;
        return;
    }
    
    // === WARNING DECAY (14+ dní) ===
    if (inactiveDays >= warnDays) {
        await applyDecay(pool, agent, 'DECAY_WARN', reputation.SLASHING.DECAY_WARN, inactiveDays, stats, log);
        stats.decayed_warn++;
        return;
    }
    
    // === LOYALTY BONUS ===
    // Heartbeat v posledných 24h + posledná zmena skóre > 7 dní → +5
    if (agent.last_heartbeat_at) {
        const lastHbAgo = now - new Date(agent.last_heartbeat_at).getTime();
        const lastScoreChangeAgo = agent.last_score_change_at
            ? now - new Date(agent.last_score_change_at).getTime()
            : Infinity;
        if (lastHbAgo < DAY_MS && lastScoreChangeAgo > 7 * DAY_MS) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await repEngine.applyEvent(client, {
                    agent_id: agent.id,
                    kya_id: agent.kya_id,
                    event_type: 'LOYALTY_BONUS',
                    source: 'system',
                    delta: reputation.SLASHING.LOYALTY_BONUS,
                    reason: `Loyalty bonus: aktívny heartbeat (počet=${agent.heartbeat_count})`,
                });
                await client.query('COMMIT');
                stats.loyalty_bonus++;
            } catch (e) {
                await client.query('ROLLBACK');
                log.error({ err: e.message }, 'loyalty bonus FAIL');
            } finally {
                client.release();
            }
        }
    }
}

async function applyDecay(pool, agent, eventType, delta, inactiveDays, stats, log) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await repEngine.applyEvent(client, {
            agent_id: agent.id,
            kya_id: agent.kya_id,
            event_type: eventType,
            source: 'decay',
            delta,
            reason: `Inactivity decay: ${inactiveDays} dní bez heartbeat`,
        });
        await client.query('COMMIT');
        if (result.sideEffects.some(s => s.type === 'CERT_REVOKED')) {
            stats.suspended++;
            log.warn({ kya_id: agent.kya_id, days: inactiveDays }, 'agent → SUSPENDED cez decay (cert revoked)');
        }
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Spustí worker. Idempotentne — len raz.
 */
function start(logger, pool) {
    if (_started) {
        logger.warn('decay worker already started');
        return;
    }
    _started = true;
    logger.info({ worker: 'decay', interval_ms: REAL_INTERVAL }, 'decay worker starting');
    
    // Prvý beh po 30s (po štarte servera nech sa všetko inicializuje)
    setTimeout(() => tick(logger, pool), 30 * 1000);
    _timer = setInterval(() => tick(logger, pool), REAL_INTERVAL);
}

/**
 * Manuálne spustenie jedného ticku (pre testy / admin endpoint).
 */
async function runOnce(logger, pool) {
    return await tick(logger, pool);
}

function stop() {
    if (_timer) {
        clearInterval(_timer);
        _timer = null;
    }
    _started = false;
}

module.exports = {
    start,
    stop,
    runOnce,
    tick, // pre testy
};
