/**
 * Strict plug-in gate — hub status + cert Ed25519 proof (?include=cert_proof).
 */
'use strict';

const { verifyAgentGate } = require('../lib/integrator-gate');

const BASE = (process.env.KYA_HUB_BASE_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');
const API_KEY = process.env.KYA_INTEGRATOR_API_KEY || '';

async function main() {
    const kyaId = process.argv[2];
    if (!kyaId) {
        console.error('Usage: node examples/plugin-gate-strict.js UMBRA-000467');
        process.exit(1);
    }
    const out = await verifyAgentGate(BASE, kyaId, {
        apiKey: API_KEY || undefined,
        requireCertProof: true,
    });
    if (!out.ok) {
        console.error('Strict gate FAIL', out);
        process.exit(1);
    }
    console.log('Strict gate OK', out.stage, out.kya_id);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
