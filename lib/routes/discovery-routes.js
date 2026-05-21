// ============================================================================
// Discovery feed + embed badge (extracted from server.js)
// ============================================================================

'use strict';

const httpPublicError = require('../http-public-error');

/**
 * @param {import('express').Express} app
 * @param {object} deps
 */
function register(app, deps) {
    const { pool, logger, delegationPass, hubkeys } = deps;

    app.get('/api/discovery/v1/agents.json', async (req, res) => {
        const cap = (req.query.capability || '').trim().toLowerCase();
        const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
        const params = [];
        let where = `WHERE a.discovery_opt_in = TRUE AND a.is_active = TRUE AND a.status = 'VERIFIED'`;
        if (cap) {
            params.push(cap);
            where += ` AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(a.agent_manifest->'agent'->'capabilities', '[]'::jsonb)) cap
            WHERE lower(cap) = lower($${params.length})
        )`;
        }
        params.push(limit);
        const limIdx = params.length;
        try {
            const r = await pool.query(
                `SELECT a.kya_id, a.agent_name, a.tier, a.reputation_score,
                    a.agent_manifest->'agent'->'capabilities' AS capabilities,
                    a.agent_manifest->'payment_hints' AS payment_hints
             FROM agents a
             ${where}
             ORDER BY a.reputation_score DESC NULLS LAST
             LIMIT $${limIdx}`,
                params,
            );
            res.set('Cache-Control', 'public, max-age=30');
            res.json({
                profile: delegationPass.L402_PROFILE_ID,
                count: r.rowCount,
                agents: r.rows,
            });
        } catch (e) {
            logger.error({ err: e.message }, 'discovery feed FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });

    app.get('/api/embed/badge/:kya_id', async (req, res) => {
        const kya_id = req.params.kya_id;
        if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
            return res.status(400).type('text/plain').send('INVALID_KYA_ID');
        }
        const fmt = (req.query.format || 'svg').toLowerCase();
        try {
            const r = await pool.query(
                `SELECT a.kya_id, a.agent_name, a.status, a.is_active, c.revoked_at
             FROM agents a
             LEFT JOIN certificates c ON c.kya_id = a.kya_id AND c.is_current = TRUE
             WHERE a.kya_id = $1`,
                [kya_id],
            );
            if (r.rowCount === 0) {
                if (fmt === 'json') return res.status(404).json({ error: 'NOT_FOUND' });
                return res.status(404).type('image/svg+xml').send(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><text x="4" y="14" font-size="11">KYA unknown</text></svg>',
                );
            }
            const row = r.rows[0];
            const ok = row.is_active && row.status === 'VERIFIED' && !row.revoked_at;
            if (fmt === 'json') {
                return res.json({
                    kya_id,
                    agent_name: row.agent_name,
                    status: ok ? 'verified' : 'not_verified',
                    hub: hubkeys.getPublicInfo().hub_url || 'https://www.umbraxon.xyz',
                });
            }
            const label = ok ? 'KYA verified' : 'KYA not ok';
            const fill = ok ? '#16a34a' : '#64748b';
            const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" role="img" aria-label="${label}">
  <title>${label}</title>
  <rect width="120" height="20" rx="3" fill="${fill}"/>
  <text x="8" y="14" fill="#ffffff" font-family="system-ui,sans-serif" font-size="11">${row.agent_name.slice(0, 18)}</text>
</svg>`;
            res.set('Cache-Control', 'public, max-age=60');
            res.type('image/svg+xml').send(svg);
        } catch (e) {
            logger.error({ err: e.message, kya_id }, 'embed badge FAIL');
            res.status(500).type('text/plain').send('ERR');
        }
    });
}

module.exports = { register };
