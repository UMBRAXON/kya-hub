// ============================================================================
// Operator discovery webhooks — notify when a new agent opts into public index
// ============================================================================
// Env: DISCOVERY_WEBHOOK_URLS=https://a.example/hook,https://b.example/hook
//      DISCOVERY_WEBHOOK_SECRET=optional HMAC secret
// ============================================================================

'use strict';

const crypto = require('crypto');
const httpPublicError = require('./http-public-error');

const CFG = {
    URLS: (process.env.DISCOVERY_WEBHOOK_URLS || '')
        .split(',')
        .map((s) => s.trim())
        .filter((u) => u.startsWith('https://')),
    SECRET: process.env.DISCOVERY_WEBHOOK_SECRET || '',
    TIMEOUT_MS: parseInt(process.env.DISCOVERY_WEBHOOK_TIMEOUT_MS || '8000', 10),
};

/**
 * @param {import('pg').Pool} pool
 * @param {{ kya_id: string, agent_name?: string, tier?: string, capabilities?: string[] }} agent
 */
async function notifyNewDiscoveryAgent(pool, agent) {
    if (!CFG.URLS.length || !agent?.kya_id) return { sent: 0 };

    let capabilities = agent.capabilities;
    if (!capabilities && pool) {
        try {
            const r = await pool.query(
                `SELECT agent_manifest->'agent'->'capabilities' AS caps FROM agents WHERE kya_id = $1`,
                [agent.kya_id],
            );
            capabilities = r.rows[0]?.caps || [];
        } catch (_) {
            capabilities = [];
        }
    }

    const body = {
        event: 'discovery.indexed',
        ts: new Date().toISOString(),
        hub_id: process.env.HUB_FEDERATION_ID || 'umbraxon-main',
        agent: {
            kya_id: agent.kya_id,
            agent_name: agent.agent_name || null,
            tier: agent.tier || null,
            capabilities: capabilities || [],
        },
        feed: '/api/discovery/v1/agents.json',
    };

    const raw = JSON.stringify(body);
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'KYA-Hub-DiscoveryNotify/1',
    };
    if (CFG.SECRET) {
        headers['X-KYA-Signature'] = crypto
            .createHmac('sha256', CFG.SECRET)
            .update(raw)
            .digest('hex');
    }

    let sent = 0;
    await Promise.all(
        CFG.URLS.map(async (url) => {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), CFG.TIMEOUT_MS);
            try {
                const r = await fetch(url, { method: 'POST', headers, body: raw, signal: ac.signal });
                if (r.ok) sent += 1;
            } catch (e) {
                httpPublicError.clientErrorCode(e, 'DISCOVERY_WEBHOOK_FAIL');
            } finally {
                clearTimeout(t);
            }
        }),
    );
    return { sent, urls: CFG.URLS.length };
}

module.exports = { notifyNewDiscoveryAgent, CFG };
