// ============================================================================
// Admin: sponsor pool + signed agent history export
// ============================================================================

'use strict';

const httpPublicError = require('../http-public-error');
const sponsorPool = require('../sponsor-pool');
const agentHistoryExport = require('../agent-history-export');

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, security: object, logger: object }} deps
 */
function register(app, deps) {
    const { pool, security, logger } = deps;

    app.get('/api/admin/sponsor-pool/codes', security.adminAuth, async (req, res) => {
        try {
            const rows = await sponsorPool.listCodes(pool, {
                limit: parseInt(req.query.limit || '50', 10),
            });
            res.json({ ok: true, enabled: sponsorPool.CFG.ENABLED, codes: rows });
        } catch (e) {
            logger.error({ err: e.message }, 'admin sponsor-pool list FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });

    app.post('/api/admin/sponsor-pool/codes', security.adminAuth, async (req, res) => {
        try {
            const r = await sponsorPool.createCode(pool, req.body || {});
            if (r.error) return res.status(400).json({ error: r.error });
            res.status(201).json({ ok: true, code: r.row });
        } catch (e) {
            if (e.code === '23505') {
                return res.status(409).json({ error: 'CODE_ALREADY_EXISTS' });
            }
            logger.error({ err: e.message }, 'admin sponsor-pool create FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });

    app.get('/api/admin/agent/:kya_id/history-export', security.adminAuth, async (req, res) => {
        const kya_id = String(req.params.kya_id || '');
        if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
            return res.status(400).json({ error: 'INVALID_KYA_ID' });
        }
        try {
            const pack = await agentHistoryExport.buildHistoryExport(pool, kya_id);
            if (pack.error) return res.status(pack.status).json({ error: pack.error });
            res.set('Cache-Control', 'private, no-store');
            return res.json(pack);
        } catch (e) {
            logger.error({ err: e.message, kya_id }, 'admin history-export FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });
}

module.exports = { register };
