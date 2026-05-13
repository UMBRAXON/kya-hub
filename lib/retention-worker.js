// ============================================================================
// UMBRAXON KYA-Hub — Retention Worker (Phase 2.4)
// ============================================================================
// Archivuje + maže staré high-frequency záznamy aby DB nerástla donekonečna.
// 
// Stratégia "archive-then-delete":
//   1. SELECT staré riadky (podľa retention policy)
//   2. INSERT do *_archive tabuľky (zachová audit forenziku)
//   3. DELETE z origin tabuľky
//   4. (Voliteľne) prune archive (po N rokoch)
//
// Retention defaults (override-able cez env):
//   action_log               → archive po 90d, delete archive po 2 rokoch
//   reputation_events        → archive po 180d, delete archive po 5 rokoch (audit-trail)
//   reports (RESOLVED/old)   → archive po 365d, delete archive po 5 rokoch
//   cert_signing_log         → archive po 180d, delete archive po 5 rokoch (forenzika)
//   rejected_requests        → archive po 30d, delete archive po 1 rok
//
// Batch size limit zabraňuje DB lock-up pri masívnom archive.
// Worker beží 1× za 24h v decay-worker tick.
// ============================================================================

const CFG = {
    ENABLED: process.env.RETENTION_WORKER !== 'false',
    BATCH_SIZE: parseInt(process.env.RETENTION_BATCH_SIZE || '5000', 10),
    
    ACTION_LOG_ARCHIVE_DAYS:    parseInt(process.env.RETENTION_ACTION_LOG_DAYS || '90', 10),
    ACTION_LOG_DELETE_DAYS:     parseInt(process.env.RETENTION_ACTION_LOG_HARDDEL_DAYS || '730', 10),
    
    REPEVENT_ARCHIVE_DAYS:      parseInt(process.env.RETENTION_REPEVENT_DAYS || '180', 10),
    REPEVENT_DELETE_DAYS:       parseInt(process.env.RETENTION_REPEVENT_HARDDEL_DAYS || '1825', 10),
    
    REPORTS_ARCHIVE_DAYS:       parseInt(process.env.RETENTION_REPORTS_DAYS || '365', 10),
    REPORTS_DELETE_DAYS:        parseInt(process.env.RETENTION_REPORTS_HARDDEL_DAYS || '1825', 10),
    
    CERTSIGN_ARCHIVE_DAYS:      parseInt(process.env.RETENTION_CERTSIGN_DAYS || '180', 10),
    CERTSIGN_DELETE_DAYS:       parseInt(process.env.RETENTION_CERTSIGN_HARDDEL_DAYS || '1825', 10),
    
    REJREQ_ARCHIVE_DAYS:        parseInt(process.env.RETENTION_REJREQ_DAYS || '30', 10),
    REJREQ_DELETE_DAYS:         parseInt(process.env.RETENTION_REJREQ_HARDDEL_DAYS || '365', 10),

    WEBHOOK_ARCHIVE_DAYS:       parseInt(process.env.RETENTION_WEBHOOK_DAYS || '30', 10),
    WEBHOOK_DELETE_DAYS:        parseInt(process.env.RETENTION_WEBHOOK_HARDDEL_DAYS || '365', 10),

    HEARTBEAT_DELETE_DAYS:      parseInt(process.env.RETENTION_HEARTBEAT_DAYS || '14', 10),

    // Strategic Sprint §31 B — gap fills (audit added 2026-05-12).
    // High-churn / low audit value → hard delete short-term.
    AUTH_CHALLENGES_DELETE_DAYS:    parseInt(process.env.RETENTION_AUTH_CHALLENGES_DAYS || '7', 10),
    POW_CHALLENGES_DELETE_DAYS:     parseInt(process.env.RETENTION_POW_CHALLENGES_DAYS || '7', 10),
    SIGNATURE_FAIL_DELETE_DAYS:     parseInt(process.env.RETENTION_SIGFAIL_DAYS || '90', 10),
    REG_INTENTS_DELETE_DAYS:        parseInt(process.env.RETENTION_REG_INTENTS_DAYS || '30', 10),
    IP_BANS_DELETE_DAYS:            parseInt(process.env.RETENTION_IP_BANS_DAYS || '90', 10),
    DATA_EXPORTS_DELETE_DAYS:       parseInt(process.env.RETENTION_DATA_EXPORTS_DAYS || '30', 10),
    VOLUMETRIC_DELETE_DAYS:         parseInt(process.env.RETENTION_VOLUMETRIC_DAYS || '365', 10),

    // Anomaly: if a hard-delete removes >ANOMALY_FRAC of the table's *prior*
    // total row count in a single run, Telegram-alert the operator. Default 5%.
    ANOMALY_FRAC:               parseFloat(process.env.RETENTION_ANOMALY_FRAC || '0.05'),
    ANOMALY_MIN_ROWS:           parseInt(process.env.RETENTION_ANOMALY_MIN_ROWS || '100', 10),

    VACUUM_ENABLED:             process.env.RETENTION_VACUUM !== 'false',
};

/**
 * Generic archive-then-delete helper.
 * Robí to v transakcii s batch limitom.
 *
 * @param {pg.Pool} pool
 * @param {object} task
 *   - srcTable, archiveTable
 *   - srcTimestampCol (default 'received_at' / 'occurred_at' / 'created_at' / 'signed_at')
 *   - archiveDays (po N dňoch sa archivuje)
 *   - columns: string[] zoznam stĺpcov ktoré sa kopírujú (musia existovať v oboch tabuľkách)
 * @returns { archived, errors }
 */
async function archiveBatch(pool, task) {
    const { srcTable, archiveTable, srcTimestampCol, archiveDays, columns } = task;
    const cols = columns.join(', ');
    
    // Select IDs ktoré pôjdu archivovať (batch limit)
    const ids = await pool.query(
        `SELECT id FROM ${srcTable}
         WHERE ${srcTimestampCol} < NOW() - INTERVAL '${archiveDays} days'
         ORDER BY id ASC LIMIT $1`,
        [CFG.BATCH_SIZE]
    );
    if (ids.rowCount === 0) return { archived: 0 };
    
    const idList = ids.rows.map(r => r.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // INSERT do archive ON CONFLICT DO NOTHING (idempotent ak by sa worker spustil 2× paralelne)
        const placeholders = idList.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
            `INSERT INTO ${archiveTable} (${cols})
             SELECT ${cols} FROM ${srcTable} WHERE id IN (${placeholders})
             ON CONFLICT (id) DO NOTHING`,
            idList
        );
        
        // DELETE z origin
        const del = await client.query(
            `DELETE FROM ${srcTable} WHERE id IN (${placeholders})`,
            idList
        );
        
        await client.query('COMMIT');
        return { archived: del.rowCount };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Prune archive (hard delete starých archive riadkov).
 */
async function pruneArchive(pool, table, timestampCol, days) {
    const r = await pool.query(
        `DELETE FROM ${table} WHERE ${timestampCol} < NOW() - INTERVAL '${days} days'`
    );
    return r.rowCount;
}

const TASKS = [
    {
        name: 'action_log',
        srcTable: 'action_log', archiveTable: 'action_log_archive',
        srcTimestampCol: 'received_at',
        archiveDaysKey: 'ACTION_LOG_ARCHIVE_DAYS',
        deleteDaysKey: 'ACTION_LOG_DELETE_DAYS',
        archiveTimestampCol: 'received_at',
        columns: [
            'id', 'agent_id', 'kya_id', 'action_type', 'target', 'context',
            'evidence_hash', 'signature', 'nonce', 'score_delta', 'rate_limited',
            'rejected_reason', 'anomaly_flagged', 'anomaly_reason',
            'bot_timestamp', 'received_at',
        ],
    },
    {
        name: 'reputation_events',
        srcTable: 'reputation_events', archiveTable: 'reputation_events_archive',
        srcTimestampCol: 'occurred_at',
        archiveDaysKey: 'REPEVENT_ARCHIVE_DAYS',
        deleteDaysKey: 'REPEVENT_DELETE_DAYS',
        archiveTimestampCol: 'occurred_at',
        columns: [
            'id', 'agent_id', 'kya_id', 'event_type', 'source', 'delta',
            'score_before', 'score_after', 'zone_before', 'zone_after',
            'reason', 'evidence', 'reporter_kya_id', 'reporter_pubkey',
            'related_report_id', 'related_action_id', 'admin_user',
            'client_ip', 'user_agent', 'occurred_at',
        ],
    },
    {
        name: 'reports',
        srcTable: 'reports', archiveTable: 'reports_archive',
        srcTimestampCol: 'created_at',
        archiveDaysKey: 'REPORTS_ARCHIVE_DAYS',
        deleteDaysKey: 'REPORTS_DELETE_DAYS',
        archiveTimestampCol: 'created_at',
        columns: [
            'id', 'target_agent_id', 'target_kya_id', 'report_type', 'description',
            'evidence', 'reporter_kya_id', 'reporter_pubkey', 'reporter_signature',
            'reporter_ip', 'status', 'auto_applied_delta', 'resolution',
            'resolution_delta', 'resolution_note', 'resolved_by',
            'report_nonce', 'report_timestamp', 'created_at', 'resolved_at',
        ],
    },
    {
        name: 'cert_signing_log',
        srcTable: 'cert_signing_log', archiveTable: 'cert_signing_log_archive',
        srcTimestampCol: 'signed_at',
        archiveDaysKey: 'CERTSIGN_ARCHIVE_DAYS',
        deleteDaysKey: 'CERTSIGN_DELETE_DAYS',
        archiveTimestampCol: 'signed_at',
        columns: [
            'id', 'serial', 'kya_id', 'key_id', 'role', 'signing_purpose',
            'message_hash', 'signature_prefix', 'requested_by_admin',
            'requested_by_ip', 'signed_at', 'anomaly_flagged', 'anomaly_reason',
        ],
    },
    {
        name: 'rejected_requests',
        srcTable: 'rejected_requests', archiveTable: 'rejected_requests_archive',
        srcTimestampCol: 'occurred_at',
        archiveDaysKey: 'REJREQ_ARCHIVE_DAYS',
        deleteDaysKey: 'REJREQ_DELETE_DAYS',
        archiveTimestampCol: 'occurred_at',
        columns: [
            'id', 'path', 'method', 'reason', 'http_status', 'severity',
            'client_ip', 'kya_id', 'user_agent', 'error_detail', 'metadata',
            'occurred_at',
        ],
    },
    {
        name: 'webhook_deliveries',
        srcTable: 'webhook_deliveries', archiveTable: 'webhook_deliveries_archive',
        srcTimestampCol: 'received_at',
        archiveDaysKey: 'WEBHOOK_ARCHIVE_DAYS',
        deleteDaysKey: 'WEBHOOK_DELETE_DAYS',
        archiveTimestampCol: 'received_at',
        columns: [
            'id', 'source', 'delivery_id', 'invoice_id', 'event_type',
            'payload_hash', 'processed', 'processing_result',
            'received_at', 'processed_at',
        ],
    },
];

// Hard-delete tabuľky (žiadny archive — high-frequency / nízka audit hodnota).
const HARD_DELETE_TASKS = [
    {
        name: 'heartbeats_log',
        table: 'heartbeats_log',
        timestampCol: 'received_at',
        deleteDaysKey: 'HEARTBEAT_DELETE_DAYS',
        // tabuľka môže neexistovať v starších inštaláciách
        optional: true,
    },
    // Strategic Sprint §31 B — short-lived nonces (auth + PoW challenges) accumulate
    // when bots solve them but the row stays. 7 days is plenty for forensics.
    {
        name: 'auth_challenges',
        table: 'auth_challenges',
        timestampCol: 'created_at',
        deleteDaysKey: 'AUTH_CHALLENGES_DELETE_DAYS',
        optional: true,
    },
    {
        name: 'pow_challenges',
        table: 'pow_challenges',
        timestampCol: 'created_at',
        deleteDaysKey: 'POW_CHALLENGES_DELETE_DAYS',
        optional: true,
    },
    // Signature failures — useful for spike detection but no need to retain past 90d.
    {
        name: 'signature_failures',
        table: 'signature_failures',
        timestampCol: 'occurred_at',
        deleteDaysKey: 'SIGNATURE_FAIL_DELETE_DAYS',
        optional: true,
    },
    // Registration intents — completed/expired drop after 30d (we keep the
    // resulting agent row + cert + invoice indefinitely).
    {
        name: 'registration_intents',
        table: 'registration_intents',
        timestampCol: 'created_at',
        deleteDaysKey: 'REG_INTENTS_DELETE_DAYS',
        // only delete completed or expired ones, keep PENDING_PAYMENT until expires_at
        whereExtra: "(status <> 'PENDING_PAYMENT' OR expires_at < NOW())",
        optional: true,
    },
    // IP bans — keep audit only for 90d after expiry / revoke.
    {
        name: 'ip_bans',
        table: 'ip_bans',
        timestampCol: 'banned_at',
        deleteDaysKey: 'IP_BANS_DELETE_DAYS',
        whereExtra: "(revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at < NOW()))",
        optional: true,
    },
    // Data export rows + their archives have their own /api/admin/data-exports/prune
    // endpoint. Run that here too so the operator doesn't have to remember.
    // Archives are referenced by archive_path — we let the dedicated service do unlink.
    {
        name: 'data_exports',
        table: 'data_exports',
        timestampCol: 'requested_at',
        deleteDaysKey: 'DATA_EXPORTS_DELETE_DAYS',
        // Will be deleted via dataExportService.prune which handles disk artifacts.
        // We don't issue a plain SQL DELETE here — see runDataExportPrune() below.
        skipPlainDelete: true,
        optional: true,
    },
    // Volumetric counters: 1-year window is plenty for AML reporting; older
    // rows have no operational value.
    {
        name: 'volumetric_counters',
        table: 'volumetric_counters',
        timestampCol: 'occurred_at',
        deleteDaysKey: 'VOLUMETRIC_DELETE_DAYS',
        optional: true,
    },
];

/**
 * Special-cased data_exports cleanup: invokes data-export-service.prune which
 * deletes both the DB row AND the on-disk archive. Returns rowCount-like int.
 */
async function runDataExportPrune(pool, log) {
    try {
        // Lazy require to avoid circular deps on cold start.
        const svc = require('./data-export-service');
        if (!svc || typeof svc.prune !== 'function') return 0;
        const out = await svc.prune(pool, { dryRun: false });
        return (out && out.deleted_rows) || (out && out.deleted) || 0;
    } catch (e) {
        if (log && log.error) log.error({ err: e.message }, 'data_exports prune FAIL');
        return 0;
    }
}

/**
 * Total row count for anomaly comparison. Cheap because we just SELECT
 * relation reltuples from pg_class — approximate but adequate.
 */
async function approxTableRowCount(pool, table) {
    try {
        const r = await pool.query(
            `SELECT GREATEST(reltuples::bigint, 0) AS approx
             FROM pg_class WHERE oid = to_regclass($1)`,
            [`public.${table}`]
        );
        if (r.rowCount === 0) return 0;
        return parseInt(r.rows[0].approx, 10) || 0;
    } catch (_) {
        return 0;
    }
}

let _notify = null;
function _getNotify() {
    if (_notify === null) {
        try { _notify = require('./notifications'); }
        catch (_) { _notify = false; }
    }
    return _notify || null;
}

/**
 * Spustí 1 retention tick. Idempotentný, safe pri opakovanom volaní.
 * @param {pg.Pool} pool
 * @param {pino} logger
 */
async function tick(pool, logger) {
    if (!CFG.ENABLED) {
        return { skipped: true, reason: 'RETENTION_WORKER disabled' };
    }
    const log = logger ? logger.child({ worker: 'retention-tick' }) : console;
    const stats = { archived: {}, pruned: {}, hardDeleted: {}, vacuumed: [], errors: [] };
    
    for (const task of TASKS) {
        try {
            const archiveDays = CFG[task.archiveDaysKey];
            const deleteDays = CFG[task.deleteDaysKey];
            
            // Archive batch loop — opakuj kým je čo archivovať (max 100 batches per tick)
            let totalArchived = 0;
            for (let i = 0; i < 100; i++) {
                const r = await archiveBatch(pool, {
                    srcTable: task.srcTable, archiveTable: task.archiveTable,
                    srcTimestampCol: task.srcTimestampCol,
                    archiveDays, columns: task.columns,
                });
                totalArchived += r.archived;
                if (r.archived < CFG.BATCH_SIZE) break;
            }
            stats.archived[task.name] = totalArchived;
            
            // Hard delete archive po deleteDays
            const pruned = await pruneArchive(pool, task.archiveTable, task.archiveTimestampCol, deleteDays);
            stats.pruned[task.name] = pruned;
            
            if (totalArchived > 0 || pruned > 0) {
                (log.info || console.log).call(log, {
                    task: task.name, archived: totalArchived, pruned, archiveDays, deleteDays,
                }, 'retention task done');
            }
        } catch (e) {
            stats.errors.push({ task: task.name, error: e.message });
            (log.error || console.error).call(log, { task: task.name, err: e.message }, 'retention task FAIL');
        }
    }

    // Hard-delete tasks (no archive — pre veľmi high-frequency tabuľky).
    // Strategic Sprint §31 B — also detects anomalies (single run deleting
    // >ANOMALY_FRAC of prior total rows → Telegram alert).
    stats.anomalies = [];
    for (const t of HARD_DELETE_TASKS) {
        try {
            const days = CFG[t.deleteDaysKey];
            if (t.optional) {
                const ex = await pool.query(
                    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
                    [t.table]
                );
                if (ex.rowCount === 0) continue;
            }

            let deleted = 0;
            const priorRows = await approxTableRowCount(pool, t.table);
            if (t.skipPlainDelete && t.name === 'data_exports') {
                deleted = await runDataExportPrune(pool, log);
            } else {
                const extra = t.whereExtra ? ` AND ${t.whereExtra}` : '';
                const r = await pool.query(
                    `DELETE FROM ${t.table}
                     WHERE ${t.timestampCol} < NOW() - INTERVAL '${days} days'${extra}`
                );
                deleted = r.rowCount;
            }
            stats.hardDeleted[t.name] = deleted;

            if (deleted > 0) {
                (log.info || console.log).call(log, {
                    task: t.name, hardDeleted: deleted, days, prior_rows: priorRows,
                }, 'retention hard-delete done');

                // Anomaly check: fraction of prior table size.
                if (priorRows >= CFG.ANOMALY_MIN_ROWS
                    && deleted >= Math.max(CFG.ANOMALY_MIN_ROWS, Math.ceil(priorRows * CFG.ANOMALY_FRAC))) {
                    const frac = priorRows > 0 ? deleted / priorRows : 0;
                    stats.anomalies.push({ task: t.name, deleted, prior_rows: priorRows, frac });
                    const notif = _getNotify();
                    if (notif && typeof notif.notify === 'function') {
                        notif.notify({
                            category: 'warning',
                            title: `Retention anomaly: ${t.name}`,
                            body: `table=${t.table} deleted=${deleted} prior_rows≈${priorRows} `
                                + `(${(frac * 100).toFixed(1)}% of total) threshold=${(CFG.ANOMALY_FRAC * 100).toFixed(0)}% retention_days=${days}\n`
                                + `If this is unexpected, inspect ${t.table} for upstream bug.`,
                            dedupe_key: `retention_anomaly_${t.name}`,
                        }).catch(() => {});
                    }
                }
            }
        } catch (e) {
            stats.errors.push({ task: t.name, error: e.message });
            (log.error || console.error).call(log, { task: t.name, err: e.message }, 'retention hard-delete FAIL');
        }
    }

    // VACUUM ANALYZE (lehkovážny, vyčistí dead tuples po delete) — nevadí, že beží len 1× denne.
    if (CFG.VACUUM_ENABLED) {
        const vacTargets = [
            'action_log', 'reputation_events', 'reports',
            'cert_signing_log', 'rejected_requests', 'webhook_deliveries',
            // Strategic Sprint §31 B additions:
            'auth_challenges', 'pow_challenges', 'signature_failures',
            'registration_intents', 'ip_bans', 'volumetric_counters',
            'data_exports',
        ];
        for (const t of vacTargets) {
            try {
                await pool.query(`VACUUM (ANALYZE) ${t}`);
                stats.vacuumed.push(t);
            } catch (e) {
                // VACUUM nemôže bežať v transakcii — pri share-lock konflikte len log a pokračuj
                (log.warn || console.warn).call(log, { table: t, err: e.message }, 'VACUUM skipped');
            }
        }
    }

    return stats;
}

/**
 * Read-only DB sizes report (pre admin dashboard).
 */
async function getSizes(pool) {
    const r = await pool.query(`
        SELECT relname AS table_name, n_live_tup AS row_count, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
        FROM pg_stat_user_tables
        WHERE relname IN (
            'action_log', 'action_log_archive',
            'reputation_events', 'reputation_events_archive',
            'reports', 'reports_archive',
            'cert_signing_log', 'cert_signing_log_archive',
            'rejected_requests', 'rejected_requests_archive',
            'webhook_deliveries', 'webhook_deliveries_archive',
            'heartbeats_log', 'heartbeats_log_archive',
            'auth_challenges', 'pow_challenges',
            'signature_failures', 'registration_intents',
            'ip_bans', 'data_exports', 'volumetric_counters',
            'agents', 'certificates', 'reputation_state', 'tier_pricing',
            'pubkey_deny_list'
        )
        ORDER BY pg_total_relation_size(relid) DESC
    `);
    return r.rows;
}

module.exports = {
    CFG,
    tick,
    getSizes,
    TASKS,
    HARD_DELETE_TASKS,
    archiveBatch,
    pruneArchive,
};
