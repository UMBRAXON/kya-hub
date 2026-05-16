#!/usr/bin/env node
'use strict';

/**
 * Hermetic MCP smoke: spawns mcp/src/index.js on stdio, completes initialize,
 * lists tools, asserts core tool names are registered. No network.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const MCP_ENTRY = path.join(ROOT, 'mcp', 'src', 'index.js');

const REQUIRED_TOOLS = new Set([
  'kya_health',
  'kya_tiers',
  'kya_cert',
  'kya_cert_verify',
  'kya_registration_quote',
  'kya_l402_delegation_profile',
  'kya_delegation_pass_verify',
  'kya_discovery_agents',
  'kya_embed_badge_status',
]);

function send(proc, obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n');
}

async function main() {
  const proc = spawn(process.execPath, [MCP_ENTRY], {
    cwd: path.join(ROOT, 'mcp'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: proc.stdout });

  const nextJsonWithId = (wantId) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for id ' + wantId)), 8000);
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

  send(proc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-mcp-protocol', version: '1' },
    },
  });

  const initRes = await nextJsonWithId(1);
  if (initRes.error) throw new Error('initialize failed: ' + JSON.stringify(initRes.error));
  if (!initRes.result || initRes.result.serverInfo?.name !== 'kya-hub') {
    throw new Error('unexpected initialize result: ' + JSON.stringify(initRes.result));
  }

  send(proc, { jsonrpc: '2.0', method: 'notifications/initialized' });

  send(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolsRes = await nextJsonWithId(2);
  if (toolsRes.error) throw new Error('tools/list failed: ' + JSON.stringify(toolsRes.error));
  const names = new Set((toolsRes.result.tools || []).map((t) => t.name));
  for (const n of REQUIRED_TOOLS) {
    if (!names.has(n)) throw new Error(`missing tool ${n}; got: ${[...names].sort().join(', ')}`);
  }

  proc.stdin.end();
  await new Promise((r) => proc.on('close', r));

  if (proc.exitCode !== 0 && proc.exitCode !== null) {
    throw new Error('MCP process exit code ' + proc.exitCode);
  }

  console.log('=== MCP stdio protocol ===');
  console.log(`  ✓ initialize + tools/list (${names.size} tools)`);
  for (const n of [...REQUIRED_TOOLS].sort()) console.log(`  ✓ tool registered: ${n}`);
  console.log('\nSUMMARY: 1 passed, 0 failed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
