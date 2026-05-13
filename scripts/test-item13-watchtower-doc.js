#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §30 Item 13 doc-lint smoke test
// ----------------------------------------------------------------------------
// Item 13 is doc-only (operator playbook). The "test" enforces that the
// playbook contains the operator-facing structure the user asked for:
//   - all three options (Voltage / Lightning Labs / self-hosted) documented
//   - a stop-and-ask gate before any Alby Hub restart
//   - a re-check date in 2026
//   - the cross-link to the Item 1 channel backup script
//   - the operator action-items table
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

const docPath = path.join(__dirname, '..', 'docs', 'WATCHTOWER-SETUP.md');

let passed = 0, failed = 0;
function ok(n)  { console.log(`  \u2713 ${n}`); passed++; }
function fail(n, d) { console.log(`  \u2717 ${n}${d ? ' — ' + d : ''}`); failed++; }
function truthy(c, n, d) { return c ? ok(n) : fail(n, d); }

console.log(`=== verifying ${docPath} ===`);
truthy(fs.existsSync(docPath), '0.1 doc file exists');
const body = fs.readFileSync(docPath, 'utf8');

console.log('=== 1) decision matrix references all three options ===');
truthy(/Voltage Cloud Watchtower/i.test(body),                  '1.1 Voltage Cloud documented');
truthy(/Lightning Labs LiT/i.test(body) || /lightning\.engineering/i.test(body),
    '1.2 Lightning Labs option documented');
truthy(/self-hosted/i.test(body),                                '1.3 self-hosted option documented');

console.log('=== 2) operator default decision recorded ===');
truthy(/Option A.*Voltage|default decision.*Voltage/i.test(body),
    '2.1 Voltage flagged as the operator default (Option A)');

console.log('=== 3) safety gates documented ===');
truthy(/[Ss]top and ask/i.test(body), '3.1 explicit "stop and ask" before alby-hub restart');
truthy(/backup.*first|backup-channel-state\.sh/i.test(body),
    '3.2 fresh backup required before any LDK config injection');
truthy(/Item 1|channel state|backup-channel-state\.sh/.test(body),
    '3.3 cross-link to Item 1 backup script');

console.log('=== 4) upstream verification dates ===');
truthy(/2026-05-12|2026/.test(body), '4.1 doc carries an explicit verification date');
truthy(/2026-09|Re-check/i.test(body), '4.2 upstream re-check date documented');

console.log('=== 5) Alby Hub watchtower support facts table present ===');
truthy(/web UI/i.test(body) && /\bNo\b/.test(body),
    '5.1 fact "Alby Hub UI does not yet expose watchtower picker" stated');
truthy(/CSV.*window|>24 h outage|justice tx/i.test(body),
    '5.2 LDK justice-tx + CSV-window risk explained');

console.log('=== 6) operator action items table ===');
truthy(/operator action items/i.test(body),     '6.1 action items section present');
truthy(/Voltage.*free|Voltage Cloud.*claim/i.test(body),
    '6.2 action: claim Voltage URI');
truthy(/Netdata.*alert|Telegram/i.test(body),   '6.3 action: Netdata/Telegram alert sketch');

console.log('=== 7) doc length sanity ===');
truthy(body.length > 4000, `7.1 doc > 4 kB (got ${body.length})`);
truthy(body.length < 30000, `7.2 doc < 30 kB (got ${body.length}; keeps it operator-readable)`);

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
