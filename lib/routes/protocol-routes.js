// ============================================================================
// Public protocol routes (extracted from server.js)
// ============================================================================

'use strict';

const httpPublicError = require('../http-public-error');

function buildProtocolVersionInfo(manifestSchema) {
    let supported;
    try {
        const enumList = manifestSchema?.SCHEMA?.properties?.protocol_version?.enum;
        supported = Array.isArray(enumList) && enumList.length ? enumList.slice() : ['1.0'];
    } catch (_) {
        supported = ['1.0'];
    }
    const preferred = process.env.HUB_PROTOCOL_PREFERRED
        || supported[supported.length - 1] || '1.0';
    const minRequired = process.env.HUB_PROTOCOL_MIN_REQUIRED || supported[0] || '1.0';
    const deprecated = (process.env.HUB_PROTOCOL_DEPRECATED || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    return {
        supported,
        preferred,
        deprecated,
        min_required: minRequired,
        next_planned: process.env.HUB_PROTOCOL_NEXT_PLANNED || '1.1',
        changelog_url: process.env.HUB_PROTOCOL_CHANGELOG_URL
            || 'https://www.umbraxon.xyz/docs/protocol-changelog',
        handshake_required: true,
    };
}

/**
 * @param {import('express').Express} app
 * @param {object} deps
 */
function register(app, deps) {
    const {
        pool,
        logger,
        manifestSchema,
        delegationPass,
        integratorLsat,
        protocolEconomics,
        protocolPublicMetrics,
        hubReleaseVersion,
        hubReleasePhase,
    } = deps;

    const PROTOCOL_VERSION_INFO = buildProtocolVersionInfo(manifestSchema);

    app.get('/api/protocol/manifest-schema', (_req, res) => {
        res.json(manifestSchema.SCHEMA);
    });

    app.get('/api/protocol/l402-delegation-profile', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json(delegationPass.l402DelegationProfileDoc());
    });

    app.get('/api/protocol/integrator-lsat-profile', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.json(integratorLsat.profileDoc());
    });

    app.post('/api/delegation-pass/verify', (req, res) => {
        const pass = req.body;
        const v = delegationPass.verifyDelegationPass(pass);
        res.json({
            ...v,
            optional_next_checks: {
                crl: '/crl/latest.json',
                cert_status: pass && pass.sub ? `/api/cert/${pass.sub}/status` : null,
            },
        });
    });

    app.get('/api/protocol/versions', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=60');
        res.json(PROTOCOL_VERSION_INFO);
    });

    app.get('/api/protocol/economics', async (_req, res) => {
        try {
            const doc = await protocolEconomics.buildEconomicsDoc(pool);
            res.set('Cache-Control', 'public, max-age=600');
            return res.json(doc);
        } catch (err) {
            logger.error({ err: err.message }, 'GET /api/protocol/economics FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });

    app.get('/api/protocol/public-metrics', async (_req, res) => {
        try {
            const doc = await protocolPublicMetrics.buildPublicMetrics(pool, {
                hubVersion: hubReleaseVersion,
                hubPhase: hubReleasePhase,
            });
            res.set('Cache-Control', 'public, max-age=300');
            return res.json(doc);
        } catch (err) {
            logger.error({ err: err.message }, 'GET /api/protocol/public-metrics FAIL');
            return httpPublicError.send500(res, 'DB_ERROR');
        }
    });

    app.get('/api/protocol/trusted-hubs.json', (_req, res) => {
        const hubUrl = process.env.HUB_PUBLIC_URL || 'https://www.umbraxon.xyz';
        const hubId = process.env.HUB_FEDERATION_ID || 'umbraxon-main';
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({
            profile: 'umbraxon-trusted-hubs-v1',
            primary: { hub_id: hubId, hub_url: hubUrl, role: 'register+read' },
            mirrors: (process.env.HUB_FEDERATION_MIRRORS || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map((url, i) => ({ hub_id: `${hubId}-mirror-${i + 1}`, hub_url: url, role: 'read' })),
            adr: '/docs/adr/ADR-001-multi-hub-federation.md',
        });
    });
}

module.exports = { register, buildProtocolVersionInfo };
