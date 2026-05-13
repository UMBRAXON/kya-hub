#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 12 smoke test
// ----------------------------------------------------------------------------
// Verifies:
//   1. `docs/ESG-STATEMENT.md` (the hand-maintained template) exists,
//      contains the expected top-level sections, and lists the
//      Hetzner-renewable claim with a verifiable URL.
//   2. `scripts/esg-report.js --offline --period 7d --out <tmp>` produces a
//      well-formed Markdown file with the kWh + CO2 table for the 7-day
//      window, and the fallback watts constant is reflected.
//   3. The generator's `buildReport()` API is importable and writes a
//      Markdown body > 1 kB.
//   4. CO2 column scales linearly with the period hours (sanity check on
//      the arithmetic).
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? ' — ' + d : ''}`); failed++; }
function eq(a, b, n) { return (a === b) ? ok(n) : fail(n, `actual=${JSON.stringify(a)} expected=${JSON.stringify(b)}`); }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

async function main() {
    const tmplPath = path.join(__dirname, '..', 'docs', 'ESG-STATEMENT.md');
    console.log('=== 1) hand-maintained template ===');
    truthy(fs.existsSync(tmplPath), `1.1 ${tmplPath} exists`);
    const tmpl = fs.readFileSync(tmplPath, 'utf8');
    truthy(tmpl.includes('## 1. Operating model summary'), '1.2 §1 heading');
    truthy(tmpl.includes('## 2. Environmental (E)'),       '1.3 §2 heading');
    truthy(tmpl.includes('## 3. Social (S)'),              '1.4 §3 heading');
    truthy(tmpl.includes('## 4. Governance (G)'),          '1.5 §4 heading');
    truthy(/hetzner\.com\/unternehmen\/umweltschutz/i.test(tmpl),
        '1.6 Hetzner renewable URL cited');
    truthy(tmpl.includes('264 gCO2'), '1.7 EU-27 264 gCO2/kWh figure cited');
    truthy(tmpl.includes('Volumetric limits') || tmpl.includes('docs/AML-VOLUMETRIC'),
        '1.8 AML safeguards cross-referenced');
    truthy(tmpl.includes('Subject Access Request') || tmpl.includes('DATA-EXPORT'),
        '1.9 GDPR data-export cross-referenced');

    console.log('=== 2) generator (offline mode) ===');
    const outFile = path.join(__dirname, '..', 'docs', `ESG-STATEMENT-test-${Date.now()}.generated.md`);
    try {
        const stdout = execSync(
            `node ${path.join(__dirname, 'esg-report.js')} --offline --period 7d --out '${outFile}'`,
            { encoding: 'utf-8' });
        truthy(stdout.includes('wrote'), '2.1 generator reports a write');
        truthy(fs.existsSync(outFile), `2.2 generated file exists (${outFile})`);

        const body = fs.readFileSync(outFile, 'utf8');
        truthy(body.length > 1000, `2.3 body > 1 kB (got ${body.length} bytes)`);
        truthy(body.includes('kWh (estimate)'), '2.4 table header present');
        truthy(body.includes('| 1 hour (avg)'), '2.5 row "1 hour (avg)" present');
        truthy(body.includes('| 24 hours'),    '2.6 row "24 hours" present');
        truthy(body.includes('| 30 days'),     '2.7 row "30 days" present');
        truthy(body.includes('| 365 days'),    '2.8 row "365 days" present');
        truthy(body.includes('fallback'),      '2.9 mode reported as fallback');
        truthy(body.includes('264'),           '2.10 grid intensity 264 visible');

        console.log('=== 3) buildReport() API ===');
        const { buildReport } = require('./esg-report');
        // override via env-style globals
        process.env.ESG_FALLBACK_WATTS = '50';
        const bodyApi = await buildReport();
        truthy(typeof bodyApi === 'string' && bodyApi.length > 500,
            `3.1 buildReport() returns >500 chars (got ${bodyApi.length})`);

        console.log('=== 4) numeric sanity check ===');
        // Extract the 24h row's kWh column (column 3, 1-indexed table is space-padded)
        function extractCol(line, idx) {
            return line.split('|').map(s => s.trim()).filter((_, i) => i > 0 && i <= 5)[idx];
        }
        const lines = body.split('\n');
        const oneHr = lines.find(l => l.startsWith('| 1 hour '));
        const day   = lines.find(l => l.startsWith('| 24 hours '));
        const month = lines.find(l => l.startsWith('| 30 days '));
        const kwh1  = parseFloat(extractCol(oneHr, 2));
        const kwh24 = parseFloat(extractCol(day, 2));
        const kwh30d = parseFloat(extractCol(month, 2));
        truthy(Math.abs(kwh24 / kwh1 - 24) < 0.5,
            `4.1 24h kWh ≈ 24x 1h kWh (${kwh1} -> ${kwh24})`);
        truthy(Math.abs(kwh30d / kwh24 - 30) < 0.5,
            `4.2 30d kWh ≈ 30x 24h kWh (${kwh24} -> ${kwh30d})`);
    } finally {
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) {}
    }

    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(2); });
