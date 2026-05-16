#!/usr/bin/env node
'use strict';
/**
 * Process one batch of developer_webhook_outbox (cron / manual).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { Pool } = require('pg');
const developerWebhookQueue = require('../lib/developer-webhook-queue');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

(async () => {
    try {
        const out = await developerWebhookQueue.processPending(pool);
        console.log(JSON.stringify({ ts: new Date().toISOString(), ...out }));
        process.exit(0);
    } catch (e) {
        console.error(JSON.stringify({ error: e.message }));
        process.exit(1);
    } finally {
        await pool.end();
    }
})();
