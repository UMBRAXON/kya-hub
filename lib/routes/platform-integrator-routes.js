// ============================================================================
// Platform integrator HTTP routes (extracted from server.js)
// ============================================================================

const integratorTrust = require('../integrator-trust');
const integratorMetrics = require('../integrator-metrics');
const { productionAgentsWhere } = require('../operator-report-filters');

/**
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   cfg: object,
 *   axios: object,
 *   logger: object,
 *   platformIntegrator: object,
 *   integratorLsat: object,
 *   integratorSandbox: object,
 *   developerApiAuth: object,
 *   integratorReadLimiter: import('express-rate-limit').RateLimitRequestHandler,
 * }} deps
 */
function register(app, deps) {
    const {
        pool,
        cfg,
        axios,
        logger,
        platformIntegrator,
        integratorLsat,
        integratorSandbox,
        developerApiAuth,
        integratorReadLimiter,
    } = deps;

    function integratorKeyMiddleware(req, res, next) {
        return developerApiAuth.optionalDeveloperKey(pool)(req, res, next);
    }

    function setIntegratorCacheHeaders(res) {
        const maxAge = Math.max(1, Math.floor(integratorTrust.CACHE_TTL_MS / 1000));
        res.set('Cache-Control', `public, max-age=${maxAge}, must-revalidate`);
    }

    app.get(
        '/api/v1/agents/:kya_id',
        integratorKeyMiddleware,
        integratorReadLimiter,
        async (req, res) => {
            const kya_id = req.params.kya_id;
            if (integratorTrust.sandboxBlockedInProduction(kya_id)) {
                return res.status(400).json({
                    error: 'SANDBOX_ID_IN_PRODUCTION',
                    message: 'UMBRA-TEST-* IDs are documentation fixtures only. Use /api/protocol/integrator-sandbox.',
                });
            }
            try {
                const out = await platformIntegrator.getAgentIntegratorView(pool, kya_id);
                if (out.error) return res.status(out.status).json({ error: out.error });
                if (req.integrator) {
                    out.body._integrator = { tier: req.integrator.tier, label: req.integrator.label };
                }
                out.body.verification = integratorTrust.verificationEnvelope(kya_id);
                setIntegratorCacheHeaders(res);
                return res.json(out.body);
            } catch (err) {
                logger.error({ err: err.message, kya_id }, 'GET /api/v1/agents/:kya_id FAIL');
                return res.status(500).json({ error: 'DB_ERROR' });
            }
        },
    );

    app.get(
        '/api/v1/agents/:kya_id/status',
        integratorKeyMiddleware,
        integratorReadLimiter,
        async (req, res) => {
            const kya_id = req.params.kya_id;
            if (integratorTrust.sandboxBlockedInProduction(kya_id)) {
                return res.status(400).json({
                    error: 'SANDBOX_ID_IN_PRODUCTION',
                    message: 'UMBRA-TEST-* IDs are documentation fixtures only.',
                });
            }
            const includeCertProof = req.query.include === 'cert_proof';
            try {
                const out = await platformIntegrator.getAgentStatusGate(pool, kya_id, {
                    includeCertBody: includeCertProof,
                });
                if (out.error) return res.status(out.status).json({ error: out.error });

                const body = {
                    ...out.body,
                    verification: integratorTrust.verificationEnvelope(kya_id),
                };
                if (includeCertProof && out.cert_body) {
                    body.cert_proof = integratorTrust.certProofFromBody(out.cert_body);
                }

                integratorMetrics
                    .recordStatusRead(pool, {
                        verified: !!body.verified,
                        integratorKeyId: req.integrator && req.integrator.id,
                        clientIp: req.ip,
                        certChecked: includeCertProof,
                    })
                    .catch(() => {});

                setIntegratorCacheHeaders(res);
                return res.json(body);
            } catch (err) {
                logger.error({ err: err.message, kya_id }, 'GET /api/v1/agents/:kya_id/status FAIL');
                return res.status(500).json({ error: 'DB_ERROR' });
            }
        },
    );

    app.post('/api/v1/integrator/lsat/invoice', integratorKeyMiddleware, async (req, res) => {
        if (!cfg.BTCPAY_URL || !cfg.BTCPAY_STORE_ID || !cfg.BTCPAY_API_KEY) {
            return res.status(503).json({ error: 'BTCPAY_UNAVAILABLE' });
        }
        try {
            const integratorKeyId =
                req.integrator && req.integrator.auth === 'api_key' ? req.integrator.id : null;
            const order = await integratorLsat.createInvoiceOrder(pool, { integratorKeyId });
            const inv = await integratorLsat.createBtcpayInvoice(cfg, axios, {
                access_id: order.access_id,
                amount_sats: order.amount_sats,
                integratorKeyId,
            });
            await integratorLsat.attachInvoice(pool, order.access_id, inv);
            return res.status(201).json({
                access_id: order.access_id,
                amount_sats: order.amount_sats,
                invoice_id: inv.invoiceId,
                bolt11: inv.bolt11,
                checkout_link: inv.checkoutLink,
                status_url: `/api/v1/integrator/lsat/status?access_id=${encodeURIComponent(order.access_id)}`,
                redeem_url: '/api/v1/integrator/lsat/redeem',
                profile: '/api/protocol/integrator-lsat-profile',
            });
        } catch (err) {
            logger.error({ err: err.message }, 'POST /api/v1/integrator/lsat/invoice FAIL');
            return res.status(500).json({ error: 'INVOICE_CREATE_FAILED' });
        }
    });

    app.get('/api/v1/integrator/lsat/status', async (req, res) => {
        const access_id = (req.query.access_id || '').trim();
        if (!access_id) return res.status(400).json({ error: 'MISSING_ACCESS_ID' });
        try {
            const out = await integratorLsat.getStatus(pool, access_id);
            if (!out.ok) return res.status(404).json({ error: out.error });
            return res.json(out);
        } catch (err) {
            logger.error({ err: err.message }, 'GET integrator lsat status FAIL');
            return res.status(500).json({ error: 'DB_ERROR' });
        }
    });

    app.post('/api/v1/integrator/lsat/redeem', async (req, res) => {
        const access_id = (req.body && req.body.access_id) || (req.query && req.query.access_id);
        if (!access_id || typeof access_id !== 'string') {
            return res.status(400).json({ error: 'MISSING_ACCESS_ID' });
        }
        try {
            const out = await integratorLsat.redeemToken(pool, access_id.trim());
            if (!out.ok) {
                const status = out.error === 'NOT_FOUND' ? 404 : out.error === 'NOT_PAID' ? 402 : 409;
                return res.status(status).json({ error: out.error, status: out.status });
            }
            return res.json({
                access_id: out.access_id,
                lsat_token: out.lsat_token,
                expires_at: out.expires_at,
                rate_limit_per_min: out.rate_limit_per_min,
                scopes: out.scopes,
                usage: 'Authorization: Bearer <lsat_token>',
            });
        } catch (err) {
            logger.error({ err: err.message }, 'POST integrator lsat redeem FAIL');
            return res.status(500).json({ error: 'DB_ERROR' });
        }
    });

    app.get('/api/protocol/integrator-sandbox', (req, res) => {
        res.json({
            profile: 'umbraxon-integrator-sandbox-v1',
            pattern: 'UMBRA-TEST-0001 … UMBRA-TEST-9999',
            no_database: true,
            production_note:
                process.env.INTEGRATOR_SANDBOX_ON_PRODUCTION === 'true'
                    ? 'UMBRA-TEST-* status/agent endpoints work on this production hub (INTEGRATOR_SANDBOX_ON_PRODUCTION=true).'
                    : 'UMBRA-TEST-* returns 400 on /api/v1/agents/* unless INTEGRATOR_SANDBOX_ON_PRODUCTION=true.',
            fixtures: {
                verified: 'UMBRA-TEST-0001, UMBRA-TEST-0002 (mod 10 → 1–2 verified)',
                unverified: 'UMBRA-TEST-0003, UMBRA-TEST-0004',
                revoked: 'UMBRA-TEST-0005',
                not_found: 'UMBRA-TEST-0000',
            },
            endpoints: {
                status: 'GET /api/v1/agents/UMBRA-TEST-0001/status',
                agent: 'GET /api/v1/agents/UMBRA-TEST-0001',
            },
            quickstart: '/integrators',
        });
    });

    app.get('/api/protocol/integrator-ops', async (req, res) => {
        try {
            const summary = await integratorMetrics.getPublicSummary(pool, {
                days: parseInt(req.query.days || '7', 10),
            });
            const agents = await pool.query(
                `SELECT COUNT(*)::int AS production_agents
                 FROM agents a
                 WHERE a.payment_settled_at IS NOT NULL
                   AND ${productionAgentsWhere('a')}`,
            );
            res.set('Cache-Control', 'public, max-age=300');
            return res.json({
                profile: 'umbraxon-integrator-ops-v1',
                production_agents_paid: agents.rows[0]?.production_agents || 0,
                integrator_verify: summary,
                note: 'Distinct external integrators appear as key:* sources after partners use umb_live_ keys.',
            });
        } catch (err) {
            logger.error({ err: err.message }, 'integrator-ops FAIL');
            return res.status(500).json({ error: 'DB_ERROR' });
        }
    });
}

module.exports = { register };
