#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Strategic Sprint §31 D test harness
// ----------------------------------------------------------------------------
// Verifies the A+B+D no-custody penalty system:
//   - Register BASIC → ban → 30 000 sat quote, deny-list 30d
//   - Register ELITE → ban → 240 000 sat quote, deny-list 90d
//   - Cooldown expired → quote still 240 000 sat
//   - Second ban → 720 000 sat, third → 720 000 sat (cap)
//   - Active deny-list → 409 Conflict
//
// Uses DB directly (idempotent helpers) instead of the full HTTP/payment flow.
// ============================================================================
'use strict';
require('dotenv').config();

const { Pool } = require('pg');
const crypto = require('crypto');
const regQuote = require('../lib/registration-quote');
const pricing = require('../lib/pricing');

// Test harness uses the privileged DB_USER (test setup creates / cleans up agent
// rows directly); regQuote.* itself runs through pool.query() which is what the
// hub uses too.
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

function randomPubkey() { return crypto.randomBytes(32).toString('hex'); }

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS:', msg); }

async function makeTestAgent({ tier, pubkey }) {
    const kya = 'UMBRA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const seal = crypto.createHash('sha256').update(kya).digest('hex');
    await pool.query(
        `INSERT INTO agents (kya_id, agent_name, status, reputation_score, agent_pubkey,
                             data_hash, origin_node, conduct_grade, tier,
                             initial_deposit, current_deposit, agent_manifest,
                             valid_until, is_active, payment_invoice_id, payment_method,
                             payment_amount_sats, payment_settled_at)
         VALUES ($1::varchar, $2::varchar, 'VERIFIED', $3::int, $4::text,
                 $5::text, 'TEST', $6::char, $7::varchar,
                 $8::int, $8::int, '{}'::jsonb,
                 NOW() + INTERVAL '1 year', TRUE, ('TEST-INV-'||$1::text)::varchar,
                 'test'::varchar, $8::int, NOW())`,
        [kya, `test-denylist-${kya}`, tier === 'ELITE' ? 900 : 500, pubkey, seal,
         tier === 'ELITE' ? 'S' : 'B', tier, tier === 'ELITE' ? 80000 : 10000]
    );
    return kya;
}

async function cleanupAgent(kya) {
    await pool.query(`DELETE FROM reputation_events WHERE kya_id = $1`, [kya]);
    await pool.query(`DELETE FROM agents WHERE kya_id = $1`, [kya]);
}

async function clearDenyList(pubkey) {
    await pool.query(`DELETE FROM pubkey_deny_list WHERE pubkey_hex = $1`, [pubkey.toLowerCase()]);
}

async function banAgent(kya, reason) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await regQuote.banAgent(client, {
            kya_id: kya, reason, admin_user: 'test',
        });
        await client.query('COMMIT');
        return res;
    } catch (e) {
        await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
}

async function main() {
    // Wait briefly for pricing.init to seed cache when called inline.
    await pricing.init(pool, console);

    const basicP = pricing.getTier('BASIC').amount_sats;
    const eliteP = pricing.getTier('ELITE').amount_sats;
    console.log('Active prices: BASIC =', basicP, ' ELITE =', eliteP);
    if (basicP !== 10000) fail('BASIC price expected 10 000');
    if (eliteP !== 80000) fail('ELITE price expected 80 000');

    // --- Test 1: BASIC register → ban → quote 30 000 sat, 30d deny-list ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'BASIC', pubkey: pk });
        try {
            const banRes = await banAgent(kya, 'test-fraud-basic');
            const q = await regQuote.getQuote(pool, { tier: 'BASIC', pubkey: pk });
            if (q.total_price_sats !== 30000) fail(`BASIC re-reg expected 30000, got ${q.total_price_sats}`);
            else pass(`BASIC re-reg quote = ${q.total_price_sats} sats (multiplier ${q.multiplier}×, ban_count ${q.ban_count})`);
            if (!q.deny_listed) fail('Expected deny_listed=true immediately after ban');
            else pass('deny_listed=true while cooldown active');
            const daysOut = (new Date(banRes.expires_at).getTime() - Date.now()) / (24 * 3600 * 1000);
            if (daysOut < 29.9 || daysOut > 30.1) fail(`BASIC cooldown expected ~30d, got ${daysOut.toFixed(2)}d`);
            else pass(`BASIC cooldown ≈ ${daysOut.toFixed(2)} days`);
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    // --- Test 2: ELITE register → ban → quote 240 000 sat, 90d deny-list ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'ELITE', pubkey: pk });
        try {
            const banRes = await banAgent(kya, 'test-fraud-elite');
            const q = await regQuote.getQuote(pool, { tier: 'ELITE', pubkey: pk });
            if (q.total_price_sats !== 240000) fail(`ELITE re-reg expected 240000, got ${q.total_price_sats}`);
            else pass(`ELITE re-reg quote = ${q.total_price_sats} sats`);
            const daysOut = (new Date(banRes.expires_at).getTime() - Date.now()) / (24 * 3600 * 1000);
            if (daysOut < 89.9 || daysOut > 90.1) fail(`ELITE cooldown expected ~90d, got ${daysOut.toFixed(2)}d`);
            else pass(`ELITE cooldown ≈ ${daysOut.toFixed(2)} days`);
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    // --- Test 3: ELITE simulate cooldown expiry by SQL time-travel ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'ELITE', pubkey: pk });
        try {
            await banAgent(kya, 'test-cooldown-expiry');
            // Time-travel: set expires_at to past so deny-list is inactive
            await pool.query(
                `UPDATE pubkey_deny_list SET expires_at = NOW() - INTERVAL '1 day'
                 WHERE pubkey_hex = $1`,
                [pk.toLowerCase()]);
            const q = await regQuote.getQuote(pool, { tier: 'ELITE', pubkey: pk });
            if (q.total_price_sats !== 240000) fail(`Post-cooldown ELITE expected 240000, got ${q.total_price_sats}`);
            else pass(`Post-cooldown ELITE quote = ${q.total_price_sats} sats (ban_count still ${q.ban_count})`);
            if (q.deny_listed) fail('Expected deny_listed=false after cooldown');
            else pass('deny_listed=false after cooldown');
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    // --- Test 4: Second + third ban → 9× cap (no 27×) ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'ELITE', pubkey: pk });
        try {
            // Three consecutive bans on the same pubkey (simulated by ban+expire pattern)
            await banAgent(kya, 'ban #1');
            await pool.query(
                `UPDATE pubkey_deny_list SET expires_at = NOW() - INTERVAL '1 day' WHERE pubkey_hex = $1`,
                [pk.toLowerCase()]);
            // Re-register the agent (simulate by resetting status)
            await pool.query(`UPDATE agents SET status='VERIFIED', pubkey_blacklisted=FALSE WHERE kya_id=$1`, [kya]);
            await banAgent(kya, 'ban #2');
            const q2 = await regQuote.getQuote(pool, { tier: 'ELITE', pubkey: pk });
            if (q2.total_price_sats !== 720000) fail(`After 2nd ban expected 720000, got ${q2.total_price_sats}`);
            else pass(`After 2 bans: ${q2.total_price_sats} sats (9× cap, ban_count=${q2.ban_count})`);

            await pool.query(
                `UPDATE pubkey_deny_list SET expires_at = NOW() - INTERVAL '1 day' WHERE pubkey_hex = $1`,
                [pk.toLowerCase()]);
            await pool.query(`UPDATE agents SET status='VERIFIED', pubkey_blacklisted=FALSE WHERE kya_id=$1`, [kya]);
            await banAgent(kya, 'ban #3');
            const q3 = await regQuote.getQuote(pool, { tier: 'ELITE', pubkey: pk });
            if (q3.total_price_sats !== 720000) fail(`After 3rd ban expected still 720000 (cap), got ${q3.total_price_sats}`);
            else pass(`After 3 bans: ${q3.total_price_sats} sats (still capped at 9×, ban_count=${q3.ban_count})`);
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    // --- Test 5: Active deny-list returns deny_listed:true and HTTP /api/pay
    //            would 409 (verified via direct lookup of deny-list state) ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'BASIC', pubkey: pk });
        try {
            await banAgent(kya, 'test-active-deny');
            const dl = await regQuote.isOnDenyList(pool, pk);
            if (!dl.active) fail('Expected active deny-list lookup');
            else pass(`Active deny-list lookup: ban_count=${dl.ban_count}, expires_at=${dl.expires_at.toISOString()}`);
            const q = await regQuote.getQuote(pool, { tier: 'BASIC', pubkey: pk });
            if (!q.deny_listed) fail('Expected quote.deny_listed=true');
            else pass(`Quote returns deny_listed=true, multiplier_on_clear=${q.multiplier}× (would be 409 in /api/pay)`);
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    // --- Test 6: Unban clears the cooldown but ban_count persists ---
    {
        const pk = randomPubkey();
        const kya = await makeTestAgent({ tier: 'BASIC', pubkey: pk });
        try {
            await banAgent(kya, 'test-unban');
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const out = await regQuote.unbanPubkey(client, pk, { admin_user: 'test', reason: 'operator restore' });
                await client.query('COMMIT');
                if (!out.cleared) fail('unbanPubkey did not clear');
                else pass(`unban cleared cooldown, ban_count preserved: ${out.ban_count}`);
            } finally { client.release(); }
            const q = await regQuote.getQuote(pool, { tier: 'BASIC', pubkey: pk });
            if (q.deny_listed) fail('Expected deny_listed=false after unban');
            else pass('deny_listed=false after unban');
            if (q.total_price_sats !== 30000) fail(`After unban: expected 30 000 (3×), got ${q.total_price_sats}`);
            else pass(`After unban: quote still 30 000 sats (3× because ban_count=1 persists)`);
        } finally {
            await clearDenyList(pk);
            await cleanupAgent(kya);
        }
    }

    console.log('\nDone.');
    await pool.end();
}

main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
