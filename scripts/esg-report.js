#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Yearly ESG report generator
// Strategic Sprint §30 Item 12 — 2026-05-12
// ----------------------------------------------------------------------------
// Queries Netdata for historical power data over the requested window,
// computes mean watts / kWh / CO2-equivalent, and writes a sibling Markdown
// file with the numeric placeholders replaced.
//
// USAGE:
//   node scripts/esg-report.js
//   node scripts/esg-report.js --period 30d --out docs/ESG-STATEMENT.generated.md
//   node scripts/esg-report.js --period 365d
//   node scripts/esg-report.js --offline    # produce a synthetic report when
//                                            # Netdata is unreachable (uses a
//                                            # conservative fixed 60 W draw).
//
// Output filename defaults to:
//   docs/ESG-STATEMENT-<YYYY-MM-DD>-<period>.generated.md
// ============================================================================
'use strict';
require('dotenv').config({ path: __dirname + '/../.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const NETDATA_URL = process.env.NETDATA_URL || 'http://127.0.0.1:19999';
const EU_GRID_GCO2_PER_KWH = parseFloat(process.env.EU_GRID_GCO2_PER_KWH || '264');
const ESG_FALLBACK_WATTS = parseFloat(process.env.ESG_FALLBACK_WATTS || '60'); // bare-metal AX52 idle ~25 W, loaded ~80 W

const args = process.argv.slice(2);
const PERIOD = (args[args.indexOf('--period') + 1] || '30d').toLowerCase();
const FORCE_OFFLINE = args.includes('--offline');
const OUT_PATH = args[args.indexOf('--out') + 1];

function periodSeconds(p) {
    const m = /^(\d+)([hdwmy])$/.exec(p);
    if (!m) throw new Error(`bad --period: ${p} (expected like 24h, 7d, 30d, 365d)`);
    const n = parseInt(m[1], 10);
    const unit = m[2];
    return n * ({ h: 3600, d: 86400, w: 604800, m: 2592000, y: 31536000 }[unit]);
}

async function meanWatts(windowSec) {
    // Netdata returns the average value of the requested chart over `points`
    // samples. We ask for chart=system.power if present; falls back to
    // system.cpu utilisation as a proxy if eBPF power readings are absent.
    const candidates = ['system.power', 'sensors.cpu_power', 'cpu.cpufreq'];
    for (const chart of candidates) {
        try {
            const url = `${NETDATA_URL}/api/v1/data?chart=${chart}&after=-${windowSec}&points=1&group=average&format=json`;
            const r = await axios.get(url, { timeout: 5000 });
            if (r.data?.result?.data?.length) {
                const row = r.data.result.data[0];
                const sum = row.slice(1).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
                if (sum > 0) return { watts: sum, chart, mode: 'netdata' };
            }
        } catch (_) {}
    }
    return null;
}

function fmtKWh(watts, hours) {
    return (watts * hours / 1000);
}
function fmtCO2(kwh) {
    return (kwh * EU_GRID_GCO2_PER_KWH); // grams CO2-eq
}

async function buildReport() {
    const windowSec = periodSeconds(PERIOD);

    let watts = null;
    let mode = 'fallback';
    let chartUsed = '(none)';
    if (!FORCE_OFFLINE) {
        const m = await meanWatts(windowSec);
        if (m) { watts = m.watts; chartUsed = m.chart; mode = m.mode; }
    }
    if (watts == null) {
        watts = ESG_FALLBACK_WATTS;
        chartUsed = `(fallback ${ESG_FALLBACK_WATTS} W constant)`;
    }

    const rows = [
        ['1 hour (avg)', 1],
        ['24 hours',     24],
        ['30 days',      24 * 30],
        ['365 days',     24 * 365],
    ];

    const out = [];
    out.push('# UMBRAXON KYA-Hub — ESG report (generated)');
    out.push('');
    out.push(`**Generated:** ${new Date().toISOString()}`);
    out.push(`**Window:** ${PERIOD} (${windowSec} s)`);
    out.push(`**Mean draw (this window):** ${watts.toFixed(1)} W  (source: ${chartUsed})`);
    out.push(`**Grid carbon intensity:** ${EU_GRID_GCO2_PER_KWH.toFixed(0)} gCO2-eq/kWh (EU-27 avg)`);
    out.push(`**Operator-attributable scope-2 (Hetzner 100% renewable):** 0 gCO2-eq (regardless of column 4 below)`);
    out.push('');
    out.push('## Energy + CO2 (worst-case grid attribution)');
    out.push('');
    out.push('| period         | mean watts | kWh (estimate) | EU grid intensity (gCO2/kWh) | gCO2-eq |');
    out.push('| -------------- | ---------- | -------------- | ----------------------------- | ------- |');
    for (const [label, hours] of rows) {
        const kwh = fmtKWh(watts, hours);
        const co2 = fmtCO2(kwh);
        out.push(`| ${label.padEnd(14)} | ${watts.toFixed(1).padStart(10)} | ${kwh.toFixed(3).padStart(14)} | ${String(EU_GRID_GCO2_PER_KWH).padStart(29)} | ${co2.toFixed(0).padStart(7)} |`);
    }
    out.push('');
    out.push('## Methodology');
    out.push('');
    out.push(`- Mean watts was sampled from ${chartUsed === '(none)' ? 'a fallback constant' : 'Netdata'} over the past ${PERIOD}.`);
    out.push(`- kWh = mean watts × period hours / 1000.`);
    out.push(`- Grid CO2-eq = kWh × ${EU_GRID_GCO2_PER_KWH} g/kWh (EEA 2024 EU-27 average).`);
    out.push('- Hetzner is documented 100% renewable since 2017, so operator-attributable scope-2 emissions are 0 gCO2-eq regardless of the column above.');
    out.push('');
    out.push('## Mode');
    out.push('');
    if (mode === 'netdata') {
        out.push(`- Mode: \`netdata\` (chart \`${chartUsed}\`)`);
    } else {
        out.push(`- Mode: \`fallback\` (Netdata not reachable or chart absent; constant ${ESG_FALLBACK_WATTS} W used)`);
        out.push('- To get accurate numbers, install the Netdata Sensors (`apt install lm-sensors`) plugin and re-run.');
    }
    out.push('');
    out.push('---');
    out.push('');
    out.push('_This file is auto-regenerated. Combine it with the hand-maintained `docs/ESG-STATEMENT.md` when handing to a B2B partner._');
    out.push('');
    return out.join('\n');
}

async function main() {
    const body = await buildReport();
    const outPath = OUT_PATH || path.join(__dirname, '..', 'docs',
        `ESG-STATEMENT-${new Date().toISOString().slice(0, 10)}-${PERIOD}.generated.md`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body);
    console.log(`[esg-report] wrote ${outPath} (${body.length} bytes, period=${PERIOD})`);
}

if (require.main === module) main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

module.exports = { buildReport, meanWatts };
