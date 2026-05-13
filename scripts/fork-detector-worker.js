#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Bitcoin Fork Detector worker (Strategic Sprint §30 Item 5)
// ----------------------------------------------------------------------------
// PM2 cron app, runs once per invocation then exits. Schedule = every 10 min
// (set in ecosystem.config.js as `cron_restart`).
//
// Behavior:
//   - Calls lib/fork-detector.probe() (queries local bitcoind + mempool.space
//     + blockstream.info).
//   - Always prints the result JSON to stdout (PM2 captures to logs).
//   - Exit codes:
//       0 — OK (quorum agreement on local hash)
//       2 — FORK_DETECTED (alert already sent, autopause already attempted)
//       3 — INSUFFICIENT_SOURCES (warning sent)
//       4 — LOCAL_RPC_UNREACHABLE (critical sent)
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env' });

const forkDetector = require('../lib/fork-detector');

(async () => {
    const r = await forkDetector.probe({ alert: true });
    process.stdout.write(JSON.stringify(r) + '\n');
    const map = {
        OK: 0,
        FORK_DETECTED: 2,
        INSUFFICIENT_SOURCES: 3,
        LOCAL_RPC_UNREACHABLE: 4,
    };
    process.exit(map[r.status] != null ? map[r.status] : 1);
})().catch(e => {
    console.error('FATAL', e);
    process.exit(1);
});
