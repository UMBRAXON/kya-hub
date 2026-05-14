#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`missing: ${p}`);
}

function mustInclude(content, needle, label) {
  if (!content.includes(needle)) throw new Error(`missing string (${label}): ${needle}`);
}

const repoRoot = path.join(__dirname, '..');
const portalDir = path.join(repoRoot, 'public', 'bots');
const indexPath = path.join(portalDir, 'index.html');
const cssPath = path.join(portalDir, 'style.css');
const jsPath = path.join(portalDir, 'main.js');

mustExist(portalDir);
mustExist(indexPath);
mustExist(cssPath);
mustExist(jsPath);

const html = fs.readFileSync(indexPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

// URL + identity
mustInclude(html, 'www.umbraxon.xyz/bots', 'canonical portal URL');
mustInclude(html, 'bots.umbraxon.xyz', 'technical alias mentioned');
mustInclude(html, 'Bot Developer Portal', 'title');

// Must reference OpenAPI and at least one API endpoint
mustInclude(html, 'openapi/openapi.yaml', 'OpenAPI link');
mustInclude(html, '/api/register/initiate', 'register endpoint mentioned');
mustInclude(html, '/api/check-status', 'polling mentioned');
mustInclude(html, '/api/cert/', 'cert verify mentioned');

// Policy / safety signals (so the page doesn't devolve into marketing only)
mustInclude(html, 'Rate limiting', 'rate limit section');
mustInclude(html, 'SPAM_REPORT', 'reputation slashing');
mustInclude(html, 'PROTOCOL_VIOLATION', 'protocol escalation');
mustInclude(html, '24h', 'escalation window');

mustInclude(html, 'id="live"', 'live status section');
mustInclude(html, 'id="assistant"', 'registration assistant section');
mustInclude(html, 'umbrexon_bot_client.py', 'python client path in HTML');

mustInclude(js, 'https://umbraxon.xyz', 'API base in client');
mustInclude(js, '/api/health', 'health fetch');
mustInclude(js, '/api/tiers', 'tiers fetch');
mustInclude(js, 'umbrexon_bot_client.py', 'register command');
mustInclude(js, 'navigator.clipboard', 'copy helper');

console.log('[test-bot-portal] OK');

