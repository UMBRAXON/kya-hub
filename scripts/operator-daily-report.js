#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Operator daily digest → Telegram / stdout / JSON
// ============================================================================
// USAGE:
//   node scripts/operator-daily-report.js --dry-run
//   node scripts/operator-daily-report.js --telegram
//   node scripts/operator-daily-report.js --json
//   node scripts/operator-daily-report.js --hours 48 --telegram
//
// PM2: kya-operator-daily-report (cron 07:00 UTC) — see ecosystem.config.js
// ============================================================================
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { Pool } = require('pg');
const reportLib = require('../lib/operator-daily-report');
const notifications = require('../lib/notifications');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const TO_TG = args.includes('--telegram');
const AS_JSON = args.includes('--json');
const hoursIdx = args.indexOf('--hours');
const HOURS = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1], 10) : undefined;

async function main() {
    if (process.env.OPERATOR_DAILY_REPORT_ENABLED === 'false' && TO_TG) {
        console.log('OPERATOR_DAILY_REPORT_ENABLED=false — skip');
        return 0;
    }

    const pool = new Pool({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT || '5432', 10),
    });

    try {
        const report = await reportLib.collectReport(pool, { hours: HOURS });
        if (AS_JSON) {
            console.log(JSON.stringify(report, null, 2));
            return 0;
        }

        const text = reportLib.formatTelegramHtml(report);
        if (DRY || !TO_TG) {
            console.log(reportLib.formatPlainText(report));
            return 0;
        }

        const ok = await notifications.sendTelegramDigest(text);
        if (!ok) {
            console.error('Telegram send failed (check TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
            console.log(reportLib.formatPlainText(report));
            return 1;
        }
        console.log('Daily report sent to Telegram.');
        return 0;
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
