// ============================================================================
// Recommended plug-in gate: hub status + optional cert cryptographic proof
// ============================================================================

const https = require('https');
const http = require('http');
const certs = require('./certs');
const hubkeys = require('./hubkeys');
const sandbox = require('./platform-integrator-sandbox');

function httpGetJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib
            .get(url, { headers: { Accept: 'application/json', ...headers } }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(body) });
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .on('error', reject);
    });
}

/**
 * @param {string} baseUrl
 * @param {string} kyaId
 * @param {{ apiKey?: string, requireCertProof?: boolean, allowSandbox?: boolean }} opts
 */
async function verifyAgentGate(baseUrl, kyaId, opts = {}) {
    const base = baseUrl.replace(/\/$/, '');
    if (!opts.allowSandbox && process.env.NODE_ENV === 'production' && sandbox.isSandboxKyaId(kyaId)) {
        return { ok: false, stage: 'sandbox_rejected', error: 'SANDBOX_ID_IN_PRODUCTION' };
    }

    const headers = { 'User-Agent': 'kya-integrator-gate/1.0' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

    const statusPath = `/api/v1/agents/${encodeURIComponent(kyaId)}/status`;
    const includeProof = opts.requireCertProof ? '&include=cert_proof' : '';
    const statusUrl = `${base}${statusPath}${includeProof ? `?include=cert_proof` : ''}`;
    const { status, data } = await httpGetJson(statusUrl, headers);
    if (status !== 200) {
        return { ok: false, stage: 'status', http_status: status, body: data };
    }
    if (!data.verified) {
        return { ok: false, stage: 'trust', trust_level: data.trust_level, reasons: data.reasons };
    }

    if (opts.requireCertProof) {
        if (data.cert_proof && data.cert_proof.cert_signature_valid === true) {
            return { ok: true, stage: 'cert_proof_inline', kya_id: kyaId, trust: data };
        }
        const certUrl = `${base}/api/cert/${encodeURIComponent(kyaId)}`;
        const certRes = await httpGetJson(certUrl, headers);
        if (certRes.status !== 200 || !certRes.data.certificate) {
            return { ok: false, stage: 'cert_fetch', http_status: certRes.status, body: certRes.data };
        }
        const v = certs.verifyCertSignature(certRes.data.certificate);
        if (!v.valid) {
            return { ok: false, stage: 'cert_crypto', reason: v.reason };
        }
        if (v.expired) {
            return { ok: false, stage: 'cert_expired' };
        }
        const hubPub = hubkeys.getPublicInfo().pubkey_hex;
        if (v.issuerPubkey && v.issuerPubkey !== hubPub) {
            return { ok: false, stage: 'cert_issuer_mismatch' };
        }
        return { ok: true, stage: 'cert_offline', kya_id: kyaId, trust: data };
    }

    return { ok: true, stage: 'hub_snapshot', kya_id: kyaId, trust: data };
}

module.exports = { verifyAgentGate, httpGetJson };
