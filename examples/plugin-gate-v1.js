/**
 * Plug-in gate — hub snapshot (fast, low-value actions).
 * For payouts / high value use: node examples/plugin-gate-strict.js UMBRA-…
 */
'use strict';

const { verifyAgentGate } = require('../lib/integrator-gate');

const BASE = (process.env.KYA_HUB_BASE_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');
const API_KEY = process.env.KYA_INTEGRATOR_API_KEY || '';

async function main() {
    const kyaId = process.argv[2] || 'UMBRA-000467';
    const out = await verifyAgentGate(BASE, kyaId, {
        apiKey: API_KEY || undefined,
        requireCertProof: false,
    });
    if (!out.ok) {
        console.error('Gate FAIL', out);
        process.exit(out.stage === 'trust' ? 2 : 1);
    }
    console.log('Gate OK (hub snapshot)', out.kya_id, out.trust?.trust_level);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
