/**
 * Optional live test: real HTTPS to hub + MCP tools/call kya_health.
 * Default: skip (exit 0). Run: KYA_HUB_LIVE_TEST=1 node test/live-integration.mjs
 */
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubClient } from '../src/hub-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.KYA_HUB_LIVE_TEST !== '1') {
  console.log('[live] skip (set KYA_HUB_LIVE_TEST=1 to run against real hub)');
  process.exit(0);
}

async function run() {
  const base = process.env.KYA_HUB_BASE_URL || 'https://umbraxon.xyz';
  console.log(`[live] KYA_HUB_BASE_URL=${base}`);

  const { hubRequest } = createHubClient({
    baseUrl: base,
    timeoutMs: Math.min(Number(process.env.KYA_HUB_REQUEST_TIMEOUT_MS) || 20000, 60000),
  });

  const health = await hubRequest('GET', '/api/health');
  if (!health || typeof health !== 'object') {
    throw new Error('GET /api/health: unexpected body');
  }
  console.log('[live] direct GET /api/health ok');

  const entry = path.join(__dirname, '..', 'src', 'index.js');
  const proc = spawn(process.execPath, [entry], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, KYA_HUB_BASE_URL: base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  function send(obj) {
    proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  const rl = readline.createInterface({ input: proc.stdout });

  function waitForId(wantId, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for jsonrpc id ${wantId}`)), ms);
      const onLine = (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg && msg.id === wantId) {
          clearTimeout(t);
          rl.off('line', onLine);
          resolve(msg);
        }
      };
      rl.on('line', onLine);
    });
  }

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'live-integration', version: '1' },
    },
  });
  const initRes = await waitForId(1, 25000);
  if (initRes.error) throw new Error(`initialize: ${JSON.stringify(initRes.error)}`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'kya_health', arguments: {} },
  });
  const callRes = await waitForId(3, 25000);
  if (callRes.error) throw new Error(`tools/call: ${JSON.stringify(callRes.error)}`);
  if (callRes.result?.isError) {
    throw new Error(`tool error: ${callRes.result.content?.[0]?.text || JSON.stringify(callRes.result)}`);
  }
  const txt = callRes.result?.content?.[0]?.text;
  if (!txt) throw new Error('tools/call: empty content');
  const parsed = JSON.parse(txt);
  if (!parsed || typeof parsed !== 'object') throw new Error('tools/call: health JSON not an object');
  console.log('[live] MCP tools/call kya_health ok');

  proc.stdin.end();
  await new Promise((resolve) => proc.on('close', resolve));
  console.log('[live] SUMMARY: all passed');
}

run().catch((err) => {
  const cause = err && err.cause;
  console.error('[live] FAILED:', err && err.message ? err.message : String(err));
  if (cause && cause.message) console.error('[live] cause:', cause.message, cause.code || '');
  console.error(
    '[live] Check DNS/VPN/firewall, or set KYA_HUB_BASE_URL to a reachable hub (e.g. http://127.0.0.1:3000).',
  );
  process.exit(1);
});
