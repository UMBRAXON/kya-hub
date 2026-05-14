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
const indexPath = path.join(repoRoot, 'index.html');
const jsPath = path.join(repoRoot, 'site', 'app.js');

mustExist(indexPath);
mustExist(jsPath);

const html = fs.readFileSync(indexPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

mustInclude(html, 'https://www.umbraxon.xyz/', 'canonical www URL');
mustInclude(html, 'bots.umbraxon.xyz', 'alias mentioned');
mustInclude(html, '/site/app.js', 'site bundle');
mustInclude(html, 'cdn.tailwindcss.com', 'Tailwind CDN');
mustInclude(html, 'alpinejs', 'Alpine CDN');

mustInclude(js, '/api/health', 'health fetch path');
mustInclude(js, '/api/tiers', 'tiers fetch path');
mustInclude(js, '/api/whitelist', 'whitelist fetch');
mustInclude(js, '/api/pay', 'pay endpoint');
mustInclude(js, 'umbrexon_bot_client.py', 'python client path');
mustInclude(js, 'navigator.clipboard', 'copy helper');

console.log('[test-bot-portal] OK');
