/**
 * Minimal Express-style snippet: verify a KYA delegation pass offline-ish,
 * then optionally re-check cert revocation online.
 *
 * Dependencies: `axios` (or swap for fetch), hub pubkey from GET /api/hub/pubkey.
 * Non-custodial: you only verify signatures; you never hold the agent's sats.
 */
'use strict';

const delegationPass = require('../lib/delegation-pass');
const hubkeys = require('../lib/hubkeys');

/**
 * @param {object} pass — full JSON from POST /api/agent/:kya_id/delegation-pass
 */
function verifyDelegationPassLocal(pass) {
    return delegationPass.verifyDelegationPass(pass);
}

/**
 * Optional online CRL / cert status (recommended for high-value flows).
 * @param {import('axios').AxiosInstance} http
 * @param {string} baseUrl e.g. https://umbraxon.xyz
 * @param {string} kya_id
 */
async function fetchCertStatus(http, baseUrl, kya_id) {
    const url = `${baseUrl.replace(/\/$/, '')}/api/cert/${encodeURIComponent(kya_id)}/status`;
    const { data } = await http.get(url, { timeout: 8000, validateStatus: () => true });
    return data;
}

/** Express middleware sketch: attach pass in Authorization header as JSON or body. */
function kyaDelegationPassGuard(opts = {}) {
    const { requireNotRevoked } = opts;
    return async function (req, res, next) {
        let pass = req.body && req.body.delegation_pass;
        if (!pass && req.headers.authorization && req.headers.authorization.startsWith('KYA-PASS ')) {
            try {
                const b64 = req.headers.authorization.slice('KYA-PASS '.length).trim();
                pass = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
            } catch {
                return res.status(401).json({ error: 'BAD_PASS_ENCODING' });
            }
        }
        if (!pass) return res.status(401).json({ error: 'MISSING_DELEGATION_PASS' });

        const v = verifyDelegationPassLocal(pass);
        if (!v.valid) return res.status(401).json({ error: 'DELEGATION_PASS_INVALID', reason: v.reason });

        if (requireNotRevoked && pass.sub) {
            try {
                const axios = require('axios');
                const st = await fetchCertStatus(axios, process.env.KYA_HUB_BASE_URL || 'https://umbraxon.xyz', pass.sub);
                if (st && st.revoked) return res.status(403).json({ error: 'CERT_REVOKED' });
            } catch {
                return res.status(503).json({ error: 'STATUS_CHECK_UNAVAILABLE' });
            }
        }
        req.kyaDelegation = pass;
        next();
    };
}

module.exports = {
    verifyDelegationPassLocal,
    fetchCertStatus,
    kyaDelegationPassGuard,
};
