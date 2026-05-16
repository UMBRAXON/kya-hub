/**
 * Plug-in gate example — call KYA Hub integrator status before allowing an action.
 * Usage: node examples/plugin-gate-v1.js UMBRA-000467
 */
'use strict';

const https = require('https');

const BASE = (process.env.KYA_HUB_BASE_URL || 'https://www.umbraxon.xyz').replace(/\/$/, '');
const API_KEY = process.env.KYA_INTEGRATOR_API_KEY || '';

function getJson(path) {
    return new Promise((resolve, reject) => {
        const headers = { Accept: 'application/json', 'User-Agent': 'kya-plugin-example/1.0' };
        if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
        https
            .get(`${BASE}${path}`, { headers }, (res) => {
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

async function main() {
    const kyaId = process.argv[2] || 'UMBRA-000467';
    const path = `/api/v1/agents/${encodeURIComponent(kyaId)}/status`;
    const { status, data } = await getJson(path);
    if (status !== 200) {
        console.error('Gate FAIL', status, data);
        process.exit(1);
    }
    if (!data.verified) {
        console.error('Agent not trusted:', data.trust_level, data.reasons);
        process.exit(2);
    }
    console.log('Gate OK — trusted agent', data.kya_id, data.tier);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
