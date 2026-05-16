#!/usr/bin/env node
'use strict';
/**
 * E2E: migration 022 + SPONSOR_INVITE_ENABLED + eligible sponsor agent.
 * Requires kya-hub on PORT (default 3000) and .env DB credentials.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');
const sponsorInvite = require('../lib/sponsor-invite');

const BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;
const TEST_SPONSOR_KYA = process.env.SPONSOR_E2E_KYA_ID || 'UMBRA-000467';

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    database: process.env.DB_NAME || 'kyahub',
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

function genKeypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('hex');
    const pub = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
    return { priv, pub, privateKey };
}

function sign(privKey, buf) {
    return crypto.sign(null, buf, privKey).toString('hex');
}

function sponsorSignBody(privKey, body) {
    const canonical = sponsorInvite.buildInviteCanonicalPayload(body);
    const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest();
    return sign(privKey, hash);
}

async function main() {
    if (!sponsorInvite.isEnabled()) {
        console.error('SPONSOR_INVITE_ENABLED is not true — enable in .env and pm2 restart kya-hub');
        process.exit(2);
    }

    const sponsorKeys = genKeypair();
    const inviteeKeys = genKeypair();
    const ts = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString('hex');

    await pool.query(
        `UPDATE agents SET tier = 'ELITE', status = 'VERIFIED', anchor_status = 'ANCHORED',
            reputation_score = GREATEST(reputation_score, 900), agent_pubkey = $2
         WHERE kya_id = $1`,
        [TEST_SPONSOR_KYA, sponsorKeys.pub]
    );

    const signBody = {
        nonce,
        timestamp: ts,
        invitee_pubkey: inviteeKeys.pub,
        tier_requested: 'BASIC',
        expected_agent_name: null,
        ttl_hours: 72,
    };
    const signature = sponsorSignBody(sponsorKeys.privateKey, signBody);

    const createRes = await axios.post(
        `${BASE}/api/agent/${TEST_SPONSOR_KYA}/sponsor-invite`,
        { ...signBody, signature },
        { validateStatus: () => true }
    );
    if (createRes.status !== 201 || !createRes.data.invite_id) {
        console.error('create sponsor-invite failed', createRes.status, createRes.data);
        process.exit(1);
    }
    const inviteId = createRes.data.invite_id;
    console.log('OK create invite', inviteId);

    const statusRes = await axios.get(`${BASE}/api/sponsor-invite/${inviteId}`);
    if (statusRes.data.status !== 'PENDING' || !statusRes.data.pow_bypass) {
        console.error('bad public status', statusRes.data);
        process.exit(1);
    }
    console.log('OK GET public status');

    const manifest = {
        protocol_version: '1.0',
        agent: {
            name: 'SINV-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
            version: '1.0.0',
            pubkey: inviteeKeys.pub,
            capabilities: ['sponsor_e2e'],
        },
        tier_requested: 'BASIC',
        timestamp: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex'),
    };

    const regNoPow = await axios.post(
        `${BASE}/api/v1/register`,
        {
            agent_name: manifest.agent.name,
            public_key: inviteeKeys.pub,
            lightning_node_id: 'c'.repeat(66),
            capabilities: ['sponsor_e2e'],
            tier: 'BASIC',
            timestamp: manifest.timestamp,
            nonce: manifest.nonce,
            manifest_signature: 'f'.repeat(128),
            challenge_id: 'CH-fake',
            challenge_response: 'e'.repeat(128),
            sponsor_invite_id: inviteId,
        },
        { validateStatus: () => true }
    );
    if (regNoPow.status === 402 && regNoPow.data?.error === 'POW_REQUIRED') {
        console.error('PoW was not bypassed');
        process.exit(1);
    }
    if (regNoPow.headers['x-pow-bypass'] !== 'sponsor-invite') {
        console.error('missing X-Pow-Bypass header', regNoPow.headers['x-pow-bypass']);
        process.exit(1);
    }
    console.log('OK register admission bypassed PoW (got', regNoPow.status, regNoPow.data?.error || 'progress)');

    const regNoInvite = await axios.post(
        `${BASE}/api/v1/register`,
        {
            agent_name: 'NOINV-' + crypto.randomBytes(3).toString('hex'),
            public_key: inviteeKeys.pub,
            lightning_node_id: 'd'.repeat(66),
            capabilities: ['x'],
            tier: 'BASIC',
            timestamp: new Date().toISOString(),
            nonce: crypto.randomBytes(16).toString('hex'),
            manifest_signature: 'a'.repeat(128),
            challenge_id: 'CH-fake',
            challenge_response: 'b'.repeat(128),
        },
        { validateStatus: () => true }
    );
    if (regNoInvite.status !== 402 || !String(regNoInvite.data?.error || '').includes('POW')) {
        console.error('expected POW without invite', regNoInvite.status, regNoInvite.data);
        process.exit(1);
    }
    console.log('OK register without invite still requires PoW');

    const consumed = await pool.query(
        `SELECT status FROM sponsor_invites WHERE invite_id = $1`,
        [inviteId]
    );
    if (consumed.rows[0]?.status !== 'CONSUMED') {
        console.log('note: invite status', consumed.rows[0]?.status, '(CONSUMED only after successful intent)');
    }

    console.log('\nAll sponsor-invite E2E checks passed.');
    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
