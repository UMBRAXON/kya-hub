// ============================================================================
// UMBRAXON KYA-Hub — Phase 1 Server
// ============================================================================
// Beží pod PM2 (ecosystem.config.js). Konfigurácia v .env.
// Endpointy:
//   GET  /api/health                  — server/DB/BTCPay/Alby health
//   GET  /                           — unified www portal (live + whitelist + pay + CLI + docs)
//   GET  /bots/*                     — legacy path → 301 redirect to /
//   GET  /api/tiers                   — zoznam tierov
//   POST /api/v1/register             — M2M registrácia (canonical)
//   POST /api/register/initiate       — legacy alias (same handler)
//   POST /api/pay                     — deprecated (410 → use /api/v1/register)
//   GET  /api/check-status/:invoiceId — polling stavu faktúry
//   POST /api/webhook/btcpay          — BTCPay webhook (HMAC validovaný)
//   POST /api/webhook/alby            — Alby Hub webhook (sig validovaný)
//   GET  /api/dashboard               — admin-only zoznam agentov
//   GET  /api/admin/ops-summary       — admin-only JSON (ops agregáty + posledné rejections)
//
// Bezpečnosť:
//   - helmet.js security headers
//   - CORS whitelist (z CORS_ALLOWED_ORIGINS env)
//   - express-rate-limit
//   - HMAC timing-safe verify
//   - Admin auth cez X-Admin-Key header
//   - Idempotency cez webhook_deliveries tabuľku
//   - pino structured logging
//   - DB user `kyahub_app` s least-privilege
// ============================================================================

require('dotenv').config({ override: true });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const HUB_PACKAGE_JSON = require('./package.json');
/** Semver for ops + `/api/health`; override with `HUB_VERSION` in `.env` if needed. */
const HUB_RELEASE_VERSION = (process.env.HUB_VERSION || HUB_PACKAGE_JSON.version || 'unknown').trim();
/** Human-readable release track (not manifest `protocol_version`). */
const HUB_RELEASE_PHASE = (process.env.HUB_RELEASE_PHASE || 'Integrations v1').trim();

const logger = require('./lib/logger');
const security = require('./lib/security');
const alby = require('./lib/alby');
const hubkeys = require('./lib/hubkeys');
const manifestSchema = require('./lib/manifest-schema');
const integrationsManifest = require('./lib/integrations-manifest');
const apiV1Register = require('./lib/api-v1-register');
const registerStatus = require('./lib/register-status');
const delegationPass = require('./lib/delegation-pass');
const developerWebhooks = require('./lib/developer-webhooks');
const certs = require('./lib/certs');
const reputation = require('./lib/reputation');
const repEngine = require('./lib/reputation-engine');
const zoneRateLimiter = require('./lib/zone-rate-limiter');
const abuseTracker = require('./lib/abuse-tracker');
const pow = require('./lib/pow');
const http403Tracker = require('./lib/http-403-tracker');
const { allocateSequentialKyaId } = require('./lib/allocate-kya-id');
const decayWorker = require('./lib/decay-worker');
const eliteListing = require('./lib/elite-listing');
const appealService = require('./lib/appeal-service');
const retireService = require('./lib/retire-service');
const dataExportService = require('./lib/data-export-service');
const metrics = require('./lib/metrics');
const { fetchOpsSummaryFull } = require('./lib/ops-summary-data');
const filePermWatcher = require('./lib/file-perm-watcher');
const sybilResistance = require('./lib/sybil-resistance');
const pricing = require('./lib/pricing');
const retentionWorker = require('./lib/retention-worker');
const notifications = require('./lib/notifications');
const sentry = require('./lib/sentry');
const breaker = require('./lib/circuit-breaker');
const certIssuanceBreaker = require('./lib/cert-issuance-breaker');
const volumetricLimits = require('./lib/volumetric-limits');
const forkDetector = require('./lib/fork-detector');
const anchorLib = require('./lib/anchor');
const bitcoindRpc = require('./lib/bitcoind-rpc');
const crlLib = require('./lib/crl');
const manufacturer = require('./lib/manufacturer');
// Strategic Sprint §31 D — A+B+D no-custody penalty system (registration quote
// with re-registration multiplier + pubkey deny-list cooldown).
const regQuote = require('./lib/registration-quote');
const sponsorInvite = require('./lib/sponsor-invite');
const platformIntegrator = require('./lib/platform-integrator');
const developerApiAuth = require('./lib/developer-api-auth');
const developerApiKeys = require('./lib/developer-api-keys');
const developerWebhookQueue = require('./lib/developer-webhook-queue');
const integratorLsat = require('./lib/integrator-lsat');
const integratorKeyRequests = require('./lib/integrator-key-requests');
const integratorSandbox = require('./lib/platform-integrator-sandbox');
const platformIntegratorRoutes = require('./lib/routes/platform-integrator-routes');
const registrationIpCap = require('./lib/registration-ip-cap');
const protocolEconomics = require('./lib/protocol-economics');
const protocolPublicMetrics = require('./lib/protocol-public-metrics');
const httpPublicError = require('./lib/http-public-error');
// Strategic Sprint §31 C — PDF invoice generator.
const invoicePdf = require('./lib/invoice-pdf');

// Konfigurovateľný timestamp skew tolerance (default 5 min). Phase 2.4.
const TIMESTAMP_SKEW_MS = parseInt(process.env.TIMESTAMP_SKEW_MS || String(5 * 60 * 1000), 10);

// ----------------------------------------------------------------------------
// Konfigurácia + validácia env
// ----------------------------------------------------------------------------
const cfg = {
    PORT: parseInt(process.env.PORT || '3000', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    HUB_SECRET: process.env.HUB_SECRET,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    
    BTCPAY_URL: process.env.BTCPAY_URL,
    BTCPAY_API_KEY: process.env.BTCPAY_API_KEY,
    BTCPAY_STORE_ID: process.env.BTCPAY_STORE_ID,
    BTCPAY_WEBHOOK_SECRET: process.env.BTCPAY_WEBHOOK_SECRET,
    
    ALBY_NWC_URI: process.env.ALBY_NWC_URI || '',
    ALBY_WEBHOOK_SECRET: process.env.ALBY_WEBHOOK_SECRET || '',
    
    REDIRECT_URL: process.env.REDIRECT_URL || 'https://umbraxon.xyz/dashboard',
    
    DB: {
        // Preferuj least-privilege app usera ak heslo k nemu existuje
        user: process.env.KYAHUB_APP_PASSWORD ? 'kyahub_app' : (process.env.DB_USER || 'postgres'),
        host: process.env.DB_HOST || '127.0.0.1',
        database: process.env.DB_NAME || 'kyahub',
        password: process.env.KYAHUB_APP_PASSWORD || process.env.DB_PASSWORD || '',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        // Pool tuning (Phase 2.4 follow-up):
        //   max=20 stačí pre 1k+ botov s krátkymi queries; pri >5k botov nasadíme PgBouncer.
        max: parseInt(process.env.DB_POOL_MAX || '20', 10),
        min: parseInt(process.env.DB_POOL_MIN || '2', 10),
        idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000', 10),
        connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONN_TIMEOUT_MS || '5000', 10),
        // Server-side query timeout (statement_timeout) — chráni pred runaway SELECTmi
        statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '10000', 10),
        query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '15000', 10),
    }
};

const required = ['HUB_SECRET', 'BTCPAY_URL', 'BTCPAY_API_KEY', 'BTCPAY_STORE_ID', 'BTCPAY_WEBHOOK_SECRET'];
const missing = required.filter(k => !cfg[k]);
if (missing.length) {
    logger.fatal({ missing }, 'Chýbajú povinné env premenné, exit.');
    process.exit(1);
}
if (!cfg.ADMIN_API_KEY) {
    logger.warn('ADMIN_API_KEY nie je nastavené — /api/dashboard bude odmietať všetko (503)');
}
if (!cfg.ALBY_NWC_URI) {
    logger.warn('ALBY_NWC_URI nie je nastavené — Lightning platby cez Alby Hub vypnuté (fallback iba BTCPay LNURL)');
}

// ----------------------------------------------------------------------------
// Tiery (Phase 2.4: hot-reloadable cez lib/pricing.js + tier_pricing DB tabuľka)
//
// TIERS proxy expose-uje aktuálne hodnoty cache-nuté z pricing modulu.
// Pri update cez /api/admin/pricing sa snapshot reloaduje automaticky.
// ----------------------------------------------------------------------------
const TIERS = new Proxy({}, {
    get(_target, prop) {
        if (prop !== 'BASIC' && prop !== 'ELITE') return undefined;
        const p = pricing.getTier(prop);
        if (!p) return undefined;
        return {
            total: p.amount_sats,
            grade: p.grade,
            durationMonths: p.duration_months,
            requiresAnchor: !!p.requires_anchor,
            baseReputation: reputation.STARTING_SCORE[prop],
        };
    },
});

function getTierByAmount(amount) {
    const val = parseInt(amount, 10);
    if (TIERS.ELITE && val === TIERS.ELITE.total) return { ...TIERS.ELITE, name: 'ELITE' };
    if (TIERS.BASIC && val === TIERS.BASIC.total) return { ...TIERS.BASIC, name: 'BASIC' };
    return null;
}

// ----------------------------------------------------------------------------
// DB pool
// ----------------------------------------------------------------------------
const pool = new Pool(cfg.DB);
pool.on('error', (err) => logger.error({ err: err.message }, 'pg pool error'));

// ----------------------------------------------------------------------------
// Idempotency helper
// ----------------------------------------------------------------------------
async function recordWebhookDelivery({ source, deliveryId, invoiceId, eventType, payloadHash, agentTier, priority }) {
    // Vráti true ak je to nový webhook, false ak duplikát.
    // Phase 4: agentTier ('BASIC'/'ELITE') + priority (1..10) ukladáme pre operator
    // dashboard a budúce out-of-band processing. ELITE → priority 9, BASIC → 5.
    const resolvedPriority = priority != null ? priority
        : (agentTier === 'ELITE' ? 9 : (agentTier === 'BASIC' ? 5 : 5));
    try {
        const r = await pool.query(
            `INSERT INTO webhook_deliveries (source, delivery_id, invoice_id, event_type, payload_hash, agent_tier, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (source, delivery_id) DO NOTHING
             RETURNING id`,
            [source, deliveryId, invoiceId || null, eventType, payloadHash, agentTier || null, resolvedPriority]
        );
        return r.rowCount > 0;
    } catch (e) {
        logger.error({ err: e.message, deliveryId, source }, 'recordWebhookDelivery FAIL');
        return false;
    }
}

// Phase 4 (P4-5): doplnenie tier-u na webhook delivery po tom, ako vieme, ktorý
// agent prislúcha invoice/payment_hash. Volá sa z webhook handlerov po registrácii.
async function backfillWebhookTier({ source, deliveryId, agentTier }) {
    if (!agentTier) return;
    const priority = agentTier === 'ELITE' ? 9 : 5;
    try {
        await pool.query(
            `UPDATE webhook_deliveries SET agent_tier = $3, priority = $4
             WHERE source = $1 AND delivery_id = $2`,
            [source, deliveryId, agentTier, priority]
        );
    } catch (e) {
        logger.warn({ err: e.message, deliveryId, source }, 'backfillWebhookTier FAIL');
    }
}

async function markWebhookProcessed({ source, deliveryId, success, message }) {
    try {
        await pool.query(
            `UPDATE webhook_deliveries SET processed = $3, processing_result = $4, processed_at = CURRENT_TIMESTAMP
             WHERE source = $1 AND delivery_id = $2`,
            [source, deliveryId, success, (message || '').slice(0, 500)]
        );
    } catch (e) {
        logger.error({ err: e.message }, 'markWebhookProcessed FAIL');
    }
}

// ----------------------------------------------------------------------------
// Trusted manufacturers (Phase 1.5 — hardcoded zoznam v .env)
// Formát: "MFR_ID:ed25519_pubkey_hex:reputation_bonus,MFR2:pub2:bonus2,..."
// ----------------------------------------------------------------------------
function parseTrustedManufacturers() {
    const raw = process.env.TRUSTED_MANUFACTURERS || '';
    const map = new Map();
    raw.split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
        const parts = entry.split(':');
        if (parts.length < 3) return;
        const [id, pub, bonus] = parts;
        if (!/^[A-Z0-9_]+$/.test(id) || !/^[0-9a-fA-F]{64}$/.test(pub)) return;
        map.set(id, { id, pubkey: pub.toLowerCase(), bonus: parseInt(bonus, 10) || 0 });
    });
    return map;
}
const TRUSTED_MFRS = parseTrustedManufacturers();
logger.info({ count: TRUSTED_MFRS.size, ids: [...TRUSTED_MFRS.keys()] }, 'Trusted manufacturers loaded');

/**
 * Verifikuje manufacturer atestáciu manifestu.
 * Pri spárovaní s trusted zoznamom vráti reputation bonus.
 */
function verifyManufacturerAttestation(manifest) {
    const mfr = manifest.manufacturer;
    if (!mfr) return { present: false, verified: false, bonus: 0 };
    
    const trusted = TRUSTED_MFRS.get(mfr.id);
    if (!trusted) {
        return { present: true, verified: false, bonus: 0, reason: 'UNKNOWN_MANUFACTURER' };
    }
    if (trusted.pubkey !== mfr.pubkey.toLowerCase()) {
        return { present: true, verified: false, bonus: 0, reason: 'MFR_PUBKEY_MISMATCH' };
    }
    
    // Manufacturer mal podpísať sha256(manifest bez manufacturer.attestation)
    const { manufacturer, ...rest } = manifest;
    const { attestation, ...mfrNoSig } = manufacturer;
    const toVerify = { ...rest, manufacturer: mfrNoSig };
    const digest = crypto.createHash('sha256').update(manifestSchema.canonicalize(toVerify)).digest();
    
    const ok = hubkeys.verify(digest, attestation, mfr.pubkey);
    if (!ok) {
        return { present: true, verified: false, bonus: 0, reason: 'BAD_MFR_SIGNATURE' };
    }
    return { present: true, verified: true, bonus: trusted.bonus, manufacturerId: mfr.id };
}

// ----------------------------------------------------------------------------
// Challenge management (Phase 1.5)
// ----------------------------------------------------------------------------
const CHALLENGE_TTL_SEC = parseInt(process.env.AUTH_CHALLENGE_TTL_SEC || '300', 10);

// Tracks last seen spike state so we only run the optional "extend open
// challenges" UPDATE on the rising edge, not on every challenge request.
let _lastChallengeSpike = false;

async function createChallenge({ pubkey, purpose, clientIp }) {
    const challengeId = 'CH-' + crypto.randomBytes(12).toString('hex');
    const nonce = crypto.randomBytes(32).toString('hex');
    const ttl = http403Tracker.computeChallengeTtl(CHALLENGE_TTL_SEC);
    const expiresAt = new Date(Date.now() + ttl.ttl_sec * 1000);
    
    await pool.query(
        `INSERT INTO auth_challenges (challenge_id, nonce, pubkey, purpose, expires_at, used_by_ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challengeId, nonce, pubkey || null, purpose || 'register', expiresAt, clientIp || null]
    );
    
    // Rising-edge: when we just transitioned into a spike, optionally extend
    // already-issued but unused challenges so honest clients mid-flow do not
    // get caught by the shorter base TTL. Opt-in via env (see lib/http-403-tracker.js).
    if (ttl.mode === 'spike' && !_lastChallengeSpike) {
        if (http403Tracker.CFG.EXTEND_OPEN_ON_SPIKE) {
            const extraSec = Math.max(0, ttl.ttl_sec - CHALLENGE_TTL_SEC);
            if (extraSec > 0) {
                try {
                    await pool.query(
                        `UPDATE auth_challenges
                         SET expires_at = expires_at + make_interval(secs => $1)
                         WHERE used_at IS NULL
                           AND expires_at > NOW()
                           AND expires_at < NOW() + make_interval(secs => $2)`,
                        [extraSec, CHALLENGE_TTL_SEC]
                    );
                } catch (e) {
                    logger.warn({ err: e.message }, 'extend open auth_challenges on spike FAIL');
                }
            }
        }
        logger.warn({
            count_403_in_window: ttl.count_in_window,
            window_min: http403Tracker.CFG.WINDOW_MIN,
            new_ttl_sec: ttl.ttl_sec,
            base_ttl_sec: CHALLENGE_TTL_SEC,
        }, 'auth_challenge entering 403-spike mode (longer TTL)');
    }
    _lastChallengeSpike = (ttl.mode === 'spike');
    
    return {
        challenge_id: challengeId,
        nonce,
        expires_at: expiresAt.toISOString(),
        ttl_sec: ttl.ttl_sec,
        ttl_mode: ttl.mode,
    };
}

async function consumeChallenge({ challengeId, nonce, expectedPubkey }) {
    // Atomické: vybrať a označiť ako used; zlyhá ak je expired, used alebo neexistuje
    const r = await pool.query(
        `UPDATE auth_challenges
         SET used_at = CURRENT_TIMESTAMP
         WHERE challenge_id = $1
           AND used_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
           AND ($2::text IS NULL OR pubkey IS NULL OR pubkey = $2)
           AND nonce = $3
         RETURNING id, pubkey, purpose, nonce`,
        [challengeId, expectedPubkey || null, nonce]
    );
    return r.rowCount > 0 ? r.rows[0] : null;
}

// Pravidelne čistíme expired challenges (aby tabuľka nerástla donekonečna)
setInterval(async () => {
    try {
        const r = await pool.query("DELETE FROM auth_challenges WHERE expires_at < NOW() - INTERVAL '1 hour'");
        if (r.rowCount > 0) logger.debug({ deleted: r.rowCount }, 'cleaned expired challenges');
    } catch (_) { /* ignore */ }
}, 60 * 60 * 1000); // hodinu


// ----------------------------------------------------------------------------
// Cert issuance helper — uloží do DB tabuľky certificates a vráti signed cert
// ----------------------------------------------------------------------------
async function issueCertificate(client, { agent, tier, paymentMethod, paymentHash, amountSats, manifest }) {
    const mf = manifest && typeof manifest === 'object' ? manifest : {};
    // Strategic Sprint §30 Item 3 — cert-issuance circuit breaker.
    // If the breaker is HARD HALTED, refuse to even build the body so we don't
    // burn DB writes / signing CPU. The outer caller will surface the error.
    if (!certIssuanceBreaker.canIssue()) {
        const e = new Error('CERT_ISSUANCE_HALTED');
        e.code = 'CERT_ISSUANCE_HALTED';
        e.retryAfterSec = 300;
        e.breakerState = certIssuanceBreaker.state();
        throw e;
    }
    const serial = certs.makeSerial(agent.kya_id, 1);
    let body, signed;
    try {
        body = certs.buildCertBody({
            kya_id: agent.kya_id,
            agentName: agent.agent_name,
            pubkey: agent.agent_pubkey,
            tier: tier.name,
            grade: tier.grade,
            validUntil: agent.valid_until,
            manifestHash: agent.manifest_hash,
            manufacturerId: agent.manufacturer_id,
            reputationScore: agent.reputation_score,
            paymentMethod,
            paymentHash,
            amountSats,
            serial,
            paymentHints: integrationsManifest.paymentHintsForCert(mf),
            integrationsPublic: integrationsManifest.integrationsPublicForCert(mf),
        });
        signed = certs.signCert(body, {
            purpose: 'cert_issue', serial, kya_id: agent.kya_id,
        });
    } catch (signErr) {
        certIssuanceBreaker.recordFailure(signErr);
        throw signErr;
    }
    const meta = _extractProofMeta(signed);

    // Resolve signing_key_id z hub-key-store podľa primárnej pubkey (single-sig:
    // jediná použitá; multi-sig: prvá v poradí — typicky BASIC).
    let signingKeyId = null;
    try {
        const k = await hubkeys.store.lookupKeyByPubkey(client, meta.issuerPubkey);
        signingKeyId = k ? k.key_id : null;
    } catch (_) { /* best effort */ }

    try {
        await client.query(
            `INSERT INTO certificates (
                serial, agent_id, kya_id, cert_body, hub_signature, issuer_pubkey,
                valid_until, signing_key_id,
                proof_type, proof_threshold, proof_signing_roles
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                serial, agent.id, agent.kya_id, JSON.stringify(signed),
                meta.signatureForLegacyColumn, meta.issuerPubkey,
                agent.valid_until, signingKeyId,
                meta.proofType, meta.threshold, meta.signingRoles,
            ]
        );
        await client.query(
            `UPDATE agents SET cert_issued_at = CURRENT_TIMESTAMP, cert_serial = $1 WHERE id = $2`,
            [serial, agent.id]
        );
    } catch (dbErr) {
        certIssuanceBreaker.recordFailure(dbErr);
        throw dbErr;
    }
    certIssuanceBreaker.recordSuccess();
    return signed;
}

// ----------------------------------------------------------------------------
// Helper: extract DB-friendly metadata from a signed cert (single OR multi).
// ----------------------------------------------------------------------------
function _extractProofMeta(signed) {
    const proof = (signed && signed.proof) || {};
    if (proof.type === 'Ed25519MultiSignature2020') {
        const sigs = Array.isArray(proof.signatures) ? proof.signatures : [];
        const firstPub = (() => {
            for (const s of sigs) {
                const m = (s.verificationMethod || '').match(/ed25519:([0-9a-fA-F]{64})/);
                if (m) return m[1].toLowerCase();
            }
            return null;
        })();
        return {
            proofType: 'Ed25519MultiSignature2020',
            threshold: Number.isFinite(proof.threshold) ? proof.threshold : sigs.length,
            signingRoles: sigs.map(s => s.role || null).filter(Boolean),
            issuerPubkey: firstPub || (hubkeys.getPublicInfo().pubkey_hex),
            // For backward compat the legacy hub_signature column expects ONE
            // signature value. Use the first one as a representative; the
            // canonical truth is `cert_body.proof.signatures[*]`.
            signatureForLegacyColumn: (sigs[0] && (sigs[0].signatureValue || sigs[0].signature)) || '',
        };
    }
    // Single-sig
    const vm = proof.verificationMethod || '';
    const m = vm.match(/ed25519:([0-9a-fA-F]{64})/);
    return {
        proofType: proof.type || 'Ed25519Signature2020',
        threshold: 1,
        signingRoles: proof.signingRole ? [proof.signingRole] : null,
        issuerPubkey: (m && m[1].toLowerCase()) || hubkeys.getPublicInfo().pubkey_hex,
        signatureForLegacyColumn: proof.signatureValue || '',
    };
}


// ----------------------------------------------------------------------------
// Agent registration core — volaný z webhook handlerov po overení platby
// ----------------------------------------------------------------------------
async function registerAgent({ tier, agentName, pubkey, manifest, paymentMethod, invoiceId, amountSats, registrationIntent }) {
    if (!tier || !agentName) throw new Error('tier + agentName povinné');

    // Strategic Sprint §31 D — defense in depth: even if /api/pay was bypassed
    // (e.g. cron-driven backfill or admin route), refuse to register an agent
    // whose pubkey is on the active deny-list.
    const effPubkey = registrationIntent ? registrationIntent.agent_pubkey : pubkey;
    if (effPubkey) {
        try {
            const dl = await regQuote.isOnDenyList(pool, effPubkey);
            if (dl.active) {
                logger.warn({
                    agentName, pubkey_prefix: dl.pubkey ? dl.pubkey.slice(0, 16) : null,
                    expires_at: dl.expires_at, ban_count: dl.ban_count,
                }, 'registerAgent BLOCKED — pubkey on deny-list');
                const err = new Error(`PUBKEY_DENY_LISTED until ${dl.expires_at} (ban_count=${dl.ban_count})`);
                err.code = 'PUBKEY_DENY_LISTED';
                err.deny_listed_until = dl.expires_at;
                err.ban_count = dl.ban_count;
                throw err;
            }
        } catch (e) {
            if (e && e.code === 'PUBKEY_DENY_LISTED') throw e;
            // best-effort otherwise
        }
    }

    const validUntil = tier.durationMonths
        ? new Date(new Date().setMonth(new Date().getMonth() + tier.durationMonths))
        : null;
    
    // Phase 1.5: Ak máme intent (validated manifest+signature), použijeme ho
    let manifestHash = null;
    let manifestSignature = null;
    let manufacturerId = null;
    let manufacturerVerified = false;
    let manufacturerBonus = 0;
    let protocolVersion = '1.0';
    
    let mfrAttestationId = null;
    let mfrTier = null;
    if (registrationIntent) {
        manifestHash = registrationIntent.manifest_hash;
        manifestSignature = registrationIntent.manifest_signature;
        manufacturerId = registrationIntent.manufacturer_id;
        manufacturerVerified = !!registrationIntent.manufacturer_verified;
        manufacturerBonus = registrationIntent.manufacturer_bonus || 0;
        mfrAttestationId = registrationIntent.mfr_attestation_id
            ? Number(registrationIntent.mfr_attestation_id) : null;
        mfrTier = registrationIntent.mfr_tier || null;
    } else if (manifest && typeof manifest === 'object' && manifest.protocol_version) {
        // Legacy direct manifest cez /api/pay — best-effort hash bez signature
        manifestHash = manifestSchema.manifestHash(manifest);
        protocolVersion = manifest.protocol_version;
    }
    
    // Vypočítaj starting reputation podľa tier + manufacturer bonus
    const startingScore = reputation.computeStartingScore({
        tierName: tier.name,
        manufacturerBonus,
    });
    
    // ELITE → PENDING_ANCHOR, BASIC → VERIFIED hneď
    const status = tier.requiresAnchor ? 'PENDING_ANCHOR' : 'VERIFIED';
    const anchorStatus = tier.requiresAnchor ? 'PENDING' : null;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Serialize registration for the same agent_name (parallel webhooks / BTCPay+LN).
        // Transaction-scoped: released on COMMIT/ROLLBACK.
        await client.query(
            `SELECT pg_advisory_xact_lock(CAST(hashtext($1::text) AS bigint))`,
            [`kya:agent_reg:${agentName}`]
        );

        // Phase 1.5: row lock on intent so only one txn can finalize PENDING_PAYMENT → COMPLETED.
        if (registrationIntent && registrationIntent.id) {
            const intentRow = await client.query(
                `SELECT id, status, agent_name FROM registration_intents WHERE id = $1 FOR UPDATE`,
                [registrationIntent.id]
            );
            if (intentRow.rowCount === 0) {
                await client.query('COMMIT');
                logger.warn({ intentId: registrationIntent.id, agentName }, 'registration intent row missing');
                return { duplicate: true, agentName };
            }
            const ir = intentRow.rows[0];
            if (ir.status !== 'PENDING_PAYMENT') {
                await client.query('COMMIT');
                logger.warn({
                    intentId: registrationIntent.id, agentName, status: ir.status,
                }, 'registration intent already finalized');
                return { duplicate: true, agentName };
            }
            if (ir.agent_name !== agentName) {
                await client.query('ROLLBACK');
                throw new Error('REGISTRATION_INTENT_AGENT_MISMATCH');
            }
        }

        const existingAgent = await client.query(
            `SELECT id, kya_id FROM agents WHERE agent_name = $1 FOR UPDATE`,
            [agentName]
        );
        if (existingAgent.rowCount > 0) {
            const row = existingAgent.rows[0];
            if (registrationIntent && registrationIntent.id) {
                await client.query(
                    `UPDATE registration_intents
                     SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
                     WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
                    [registrationIntent.id]
                );
            }
            await client.query('COMMIT');
            logger.warn({ agentName, kya_id: row.kya_id }, 'Agent už existuje — preskakujem registráciu');
            return { duplicate: true, agentName, axisId: row.kya_id };
        }

        // Chronological public id: UMBRA-000042 (hub_kya_seq, see migrations/018_hub_kya_seq.sql)
        const axisId = await allocateSequentialKyaId(client);
        const seal = crypto.createHmac('sha256', cfg.HUB_SECRET)
            .update(`${agentName}:${axisId}:${tier.total}`)
            .digest('hex');
        const discoveryOptIn = integrationsManifest.discoveryOptInFromManifest(manifest || {});
        const lightningNodeId = apiV1Register.lightningNodeIdFromManifest(manifest || {});

        const insertRes = await client.query(
            `INSERT INTO agents (
                kya_id, agent_name, status, reputation_score, agent_pubkey,
                data_hash, origin_node, conduct_grade, tier,
                initial_deposit, current_deposit, agent_manifest,
                valid_until, is_active, last_seen,
                payment_invoice_id, payment_method, payment_amount_sats, payment_settled_at,
                anchor_status,
                protocol_version, manifest_hash, manifest_signature,
                manufacturer_id, manufacturer_verified,
                mfr_attestation_id, mfr_tier, discovery_opt_in,
                lightning_node_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP, $15, $16, $17, CURRENT_TIMESTAMP, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
            ON CONFLICT (agent_name) DO NOTHING
            RETURNING id, kya_id, agent_name, agent_pubkey, valid_until, reputation_score, manifest_hash, manufacturer_id`,
            [
                axisId, agentName, status, startingScore, pubkey || '',
                seal, 'UMBRA-NODE-01', tier.grade, tier.name,
                tier.total, tier.total, JSON.stringify(manifest || {}),
                validUntil, true,
                invoiceId, paymentMethod, amountSats,
                anchorStatus,
                protocolVersion, manifestHash, manifestSignature,
                manufacturerId, manufacturerVerified,
                mfrAttestationId, mfrTier,
                discoveryOptIn,
                lightningNodeId,
            ]
        );
        
        if (insertRes.rowCount === 0) {
            logger.warn({ agentName }, 'INSERT agents ON CONFLICT — duplikát agent_name');
            const ag = await client.query(
                `SELECT id, kya_id FROM agents WHERE agent_name = $1`,
                [agentName]
            );
            if (ag.rowCount === 0) {
                await client.query('ROLLBACK');
                logger.error({ agentName }, 'INSERT ON CONFLICT but agent row missing');
                throw new Error('AGENT_INSERT_CONFLICT_UNKNOWN');
            }
            if (registrationIntent && registrationIntent.id) {
                await client.query(
                    `UPDATE registration_intents
                     SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
                     WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
                    [registrationIntent.id]
                );
            }
            await client.query('COMMIT');
            return { duplicate: true, agentName, axisId: ag.rows[0].kya_id };
        }
        
        const newAgent = insertRes.rows[0];
        
        // ELITE → naqueue anchor request
        if (tier.requiresAnchor) {
            await client.query(
                `INSERT INTO pending_anchors (agent_id, hmac_hash, tier, status)
                 VALUES ($1, $2, $3, 'PENDING')`,
                [newAgent.id, seal, tier.name]
            );
        }
        
        // Phase 1.5: Vystav signed certifikát
        let certificate = null;
        try {
            certificate = await issueCertificate(client, {
                agent: newAgent,
                tier,
                paymentMethod,
                paymentHash: invoiceId,
                amountSats,
                manifest: manifest || {},
            });
        } catch (certErr) {
            logger.error({ err: certErr.message, agentName }, 'cert issuance failed (agent zostáva registrovaný)');
            // Nepadáme — agent je registrovaný, cert si môže vyžiadať neskôr
        }
        
        // Update intent ako COMPLETED ak existoval
        if (registrationIntent && registrationIntent.id) {
            await client.query(
                `UPDATE registration_intents
                 SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [registrationIntent.id]
            );
        }

        if (registrationIntent?.sponsor_invite_id) {
            try {
                await sponsorInvite.linkAgentAfterRegistration(client, {
                    inviteId: registrationIntent.sponsor_invite_id,
                    agentKyaId: newAgent.kya_id,
                });
            } catch (e) {
                logger.warn({ err: e.message, inviteId: registrationIntent.sponsor_invite_id },
                    'sponsor invite link FAIL (non-fatal)');
            }
        }

        // Phase 4B: link the mfr attestation to this agent (one-shot consume).
        // Idempotent: if already consumed by a different agent (race), this no-ops.
        if (mfrAttestationId) {
            try {
                const consumed = await manufacturer.markAttestationConsumed(client, {
                    attestation_id: mfrAttestationId, agent_id: newAgent.id,
                });
                if (!consumed.ok) {
                    logger.warn({
                        agentName, mfrAttestationId, reason: consumed.reason,
                    }, 'mfr attestation already consumed (race?)');
                }
            } catch (e) {
                logger.error({ err: e.message, mfrAttestationId },
                    'mfr attestation consume FAIL (non-fatal)');
            }
        }

        await client.query('COMMIT');
        const repInfo = reputation.describe(startingScore);
        logger.info({
            event: 'agent_registered',
            agentName,
            axisId: newAgent.kya_id,
            tier: tier.name,
            status,
            cert: !!certificate,
            mfr: manufacturerId,
            reputation: startingScore,
            zone: repInfo.zone,
            registration_id: registrationIntent ? registrationIntent.registration_id : null,
            invoice_id: invoiceId || null,
        }, 'Agent zaregistrovaný');

        developerWebhooks.emit(pool, {
            event: 'agent.registered',
            kya_id: newAgent.kya_id,
            payload: {
                tier: tier.name,
                manifest_hash: manifestHash,
                discovery_opt_in: discoveryOptIn,
            },
        }).catch(() => {});

        // Fire-and-forget Telegram/Discord PING po každej zaplatenej registrácii (BASIC + ELITE).
        notifications.notifyRegistrationPaid({
            tier: tier.name,
            agentName,
            axisId: newAgent.kya_id,
            paymentMethod: paymentMethod || 'unknown',
            amountSats: amountSats || tier.total,
        }).catch(() => { /* notifikácia nikdy nezhorí registráciu */ });

        return {
            duplicate: false,
            axisId: newAgent.kya_id,
            agentId: newAgent.id,
            seal,
            status,
            certificate, // signed cert object (alebo null ak issuance zlyhal)
        };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();

// P2: Error tracking (opt-in via SENTRY_DSN).
// Must be mounted before routes so request context is available.
try {
    sentry.init(logger);
    const rh = sentry.requestHandler();
    const th = sentry.tracingHandler();
    if (rh) app.use(rh);
    if (th) app.use(th);
} catch (e) {
    logger.warn({ err: e?.message }, 'Sentry init failed (continuing without it)');
}
// Expose pool cez app.locals pre middleware ktoré k nemu nemajú priamy prístup (napr. security.adminAuth)
app.locals.pool = pool;
app.set('trust proxy', 1); // ak je za nginx/cloudflare

// Globálne security headers
app.use(helmet({
    contentSecurityPolicy: false, // frontend HTML používa inline scripty, dorobíme neskôr
    crossOriginEmbedderPolicy: false,
}));

// HTTP 403 sliding-window counter (Phase 2.5) — must attach BEFORE any
// route/middleware that may emit 403, so `res.on('finish')` fires for every
// 403 response (zone limiter, ip ban, suspended agents, rejectAndLog …).
app.use(http403Tracker.buildExpressMiddleware());

// IP ban check (Phase 2.2) — beží PRED akýmkoľvek iným spracovaním
// Health a webhook majú výnimku (nech monitoring funguje aj keď je IP banned)
app.use(abuseTracker.buildIpBanMiddleware({
    poolGetter: () => pool,
    exemptPaths: ['/api/health', '/api/webhook/btcpay', '/api/webhook/alby'],
}));

// CORS s whitelist
app.use(cors(security.buildCorsOptions()));

// Admin bypass helper (definícia ďalej v súbore — function declaration je hoisted)
// Použité v rate-limiteroch nech testy a admin tooling s X-Admin-Key môžu preskočiť limity.

// Rate limiting — globálny
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Príliš veľa requestov' },
    skip: (req) => _adminBypass(req),
});
app.use(globalLimiter);

// Špeciálny limiter pre /api/pay (drahšia operácia — BTCPay/Alby API call)
const payLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_PAY_PER_MIN || '5', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Max 5 faktúr/min/IP. Skús neskôr.' },
    skip: (req) => _adminBypass(req),
});

// M2M canonical register — stricter than legacy pay/initiate
const v1RegisterLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_V1_REGISTER_PER_MIN || '3', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'RATE_LIMITED',
        message: 'Max 3 registrácií/min/IP na /api/v1/register. Rešpektuj Retry-After.',
    },
    skip: (req) => _adminBypass(req),
});

// Phase 4B: manufacturer attestation submission throttle.
const mfrAttestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.RATE_MFR_ATTEST_PER_MIN || '20', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Too many attestation submissions; slow down.' },
    skip: (req) => _adminBypass(req),
});

// Platform / plug-in read API (GET /api/v1/agents/*) — per-IP or per API key bucket
const integratorReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: (req) => {
        if (req.integrator && req.integrator.rate_limit_per_min) {
            return req.integrator.rate_limit_per_min;
        }
        return parseInt(process.env.RATE_INTEGRATOR_READ_PER_MIN || '120', 10);
    },
    keyGenerator: (req) => {
        if (req.integrator && req.integrator.id) return `devkey:${req.integrator.id}`;
        return req.ip || 'unknown';
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'RATE_LIMITED',
        message: 'Integrator read rate limit exceeded. Honor Retry-After or use a developer API key.',
    },
    skip: (req) => _adminBypass(req),
});

// Registrácia rate-limit referencií pre admin reset (Phase 2.2 testovacie pomôcky)
const _rateLimiters = {
    global: globalLimiter,
    pay: payLimiter,
    v1_register: v1RegisterLimiter,
    mfr_attest: mfrAttestLimiter,
    integrator_read: integratorReadLimiter,
};

// ----------------------------------------------------------------------------
// 1) Webhook BTCPay — raw body kvôli HMAC overeniu (PRED app.use(json()))
// ----------------------------------------------------------------------------
app.post('/api/webhook/btcpay', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
    const log = logger.child({ route: 'webhook/btcpay' });
    const sig = req.headers['btcpay-sig'];
    const deliveryId = req.headers['btcpay-delivery-id'] || crypto.randomBytes(8).toString('hex');
    
    if (!sig || !req.body || req.body.length === 0) {
        log.warn('prázdny alebo nepodpísaný webhook');
        return res.status(400).send('Missing data');
    }
    
    if (!security.verifyHmacSignature(req.body, cfg.BTCPAY_WEBHOOK_SECRET, sig)) {
        log.error({ deliveryId }, 'INVALID HMAC signature');
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'BAD_HMAC_SIGNATURE',
            http_status: 401, client_ip: req.ip, user_agent: req.headers['user-agent'],
            error_detail: `deliveryId=${deliveryId}`,
        }).catch(() => {});
        return res.status(401).send('Invalid signature');
    }
    
    let payload;
    try {
        payload = JSON.parse(req.body.toString());
    } catch {
        return res.status(400).send('Bad JSON');
    }
    
    const payloadHash = crypto.createHash('sha256').update(req.body).digest('hex');
    
    // Idempotency
    const isNew = await recordWebhookDelivery({
        source: 'btcpay',
        deliveryId,
        invoiceId: payload.invoiceId,
        eventType: payload.type,
        payloadHash,
    });
    if (!isNew) {
        log.info({ deliveryId, eventType: payload.type }, 'duplicate webhook, skipping');
        return res.status(200).send('Duplicate (idempotent)');
    }
    
    log.info({ deliveryId, eventType: payload.type, invoiceId: payload.invoiceId }, 'webhook received');
    
    try {
        if (payload.type === 'InvoiceSettled') {
            const metadata = payload.metadata || {};
            // ELITE public listing — heartbeat / reactivation (not registration)
            if (metadata.integratorLsatAccessId) {
                try {
                    const settled = await integratorLsat.markPaid(
                        pool,
                        metadata.integratorLsatAccessId,
                        payload.invoiceId
                    );
                    await markWebhookProcessed({
                        source: 'btcpay',
                        deliveryId,
                        success: !!settled.ok,
                        message: settled.already ? 'lsat_dup' : `lsat:${settled.access_id || 'fail'}`,
                    });
                } catch (e) {
                    log.error({ err: e.message }, 'integrator LSAT BTCPay webhook FAIL');
                    await markWebhookProcessed({ source: 'btcpay', deliveryId, success: false, message: e.message });
                }
                return res.status(200).send('OK');
            }

            if (metadata.eliteListingPayment === 'heartbeat' || metadata.eliteListingPayment === 'reactivation') {
                try {
                    const amt = parseInt(metadata.eliteListingExpectedSats || metadata.amount || 0, 10)
                        || (payload.amount ? parseInt(String(payload.amount), 10) : 0);
                    const settled = await eliteListing.handlePaymentSettled(pool, {
                        invoiceId: payload.invoiceId,
                        paymentHash: payload.invoiceId,
                        amountSats: amt,
                        metadata,
                        source: 'btcpay',
                        logger: log,
                    });
                    await markWebhookProcessed({
                        source: 'btcpay', deliveryId, success: !!settled.ok,
                        message: settled.duplicate ? 'elite_listing_dup' : `elite_listing:${settled.handled}`,
                    });
                } catch (e) {
                    log.error({ err: e.message }, 'elite listing BTCPay webhook FAIL');
                    await markWebhookProcessed({ source: 'btcpay', deliveryId, success: false, message: e.message });
                }
                return res.status(200).send('OK');
            }

            const { agentName, pubkey, amount, manifest, registrationId } = metadata;
            
            // Phase 1.5: ak má registrationId, použijeme validovaný intent
            let intent = null;
            if (registrationId) {
                const r = await pool.query(
                    `SELECT * FROM registration_intents WHERE registration_id = $1 AND status = 'PENDING_PAYMENT'`,
                    [registrationId]
                );
                if (r.rowCount > 0) {
                    intent = r.rows[0];
                } else {
                    log.warn({ registrationId }, 'intent nenájdený alebo už dokončený — fallback na legacy flow');
                }
            }
            
            const effAgentName = intent ? intent.agent_name : agentName;
            const effPubkey = intent ? intent.agent_pubkey : pubkey;
            const effManifest = intent ? intent.manifest : manifest;
            const effAmount = intent ? (intent.tier_requested === 'ELITE' ? TIERS.ELITE.total : TIERS.BASIC.total) : amount;
            
            if (!effAgentName || !effAmount) {
                log.warn({ metadata }, 'chýbajú metadáta agentName/amount');
                await markWebhookProcessed({ source: 'btcpay', deliveryId, success: false, message: 'missing metadata' });
                return res.status(200).send('OK (skipped)');
            }
            
            const tier = getTierByAmount(effAmount);
            if (!tier) {
                log.warn({ amount: effAmount }, 'suma nezodpovedá žiadnemu tieru');
                await markWebhookProcessed({ source: 'btcpay', deliveryId, success: false, message: 'invalid tier' });
                return res.status(200).send('Invalid tier');
            }
            
            // Phase 4 (P4-5): označ webhook tier-om PRED registráciou — admin queue
            // tak vidí ELITE invoicy aj kým ešte beží registerAgent().
            await backfillWebhookTier({ source: 'btcpay', deliveryId, agentTier: tier.name });

            const result = await registerAgent({
                tier, agentName: effAgentName, pubkey: effPubkey, manifest: effManifest,
                paymentMethod: 'btcpay',
                invoiceId: payload.invoiceId,
                amountSats: tier.total,
                registrationIntent: intent,
            });

            // Strategic Sprint §31 C — issue PDF invoice (fire-and-forget; non-fatal).
            if (!result.duplicate && result.axisId) {
                try {
                    const ag = await pool.query(
                        'SELECT id, kya_id, agent_name, tier, anchor_txid FROM agents WHERE kya_id = $1',
                        [result.axisId]);
                    if (ag.rowCount > 0) {
                        invoicePdf.issueForPayment(pool, {
                            agent: ag.rows[0],
                            paymentMethod: 'btcpay',
                            amountSats: tier.total,
                            paymentHash: payload.invoiceId,
                            paidAt: new Date(),
                            logger: log,
                        }).catch(e => log.warn({ err: e.message, kya_id: result.axisId },
                            'invoice PDF issue FAIL (non-fatal)'));
                    }
                } catch (e) {
                    log.warn({ err: e.message }, 'invoice PDF lookup FAIL (non-fatal)');
                }
            }

            await markWebhookProcessed({ source: 'btcpay', deliveryId, success: true, message: result.duplicate ? 'duplicate agent' : `created ${result.axisId}` });
        } else {
            await markWebhookProcessed({ source: 'btcpay', deliveryId, success: true, message: 'event ignored' });
        }
        res.status(200).send('OK');
    } catch (err) {
        log.error({ err: err.message, deliveryId }, 'webhook processing failed');
        await markWebhookProcessed({ source: 'btcpay', deliveryId, success: false, message: err.message });
        // 200 nech BTCPay neskúša znova nekonečne; v DB máme záznam o chybe
        res.status(200).send('Error but keeping alive');
    }
});

// ----------------------------------------------------------------------------
// 2) Webhook Alby Hub (alternatíva k subscription) — voliteľné
// ----------------------------------------------------------------------------
app.post('/api/webhook/alby', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    const log = logger.child({ route: 'webhook/alby' });
    
    if (!cfg.ALBY_WEBHOOK_SECRET) {
        log.warn('ALBY_WEBHOOK_SECRET nenastavené, webhook odmietnutý');
        return res.status(503).send('Not configured');
    }
    
    const sig = req.headers['alby-signature'] || req.headers['x-alby-signature'];
    const deliveryId = req.headers['alby-delivery-id'] || crypto.randomBytes(8).toString('hex');
    
    if (!sig || !req.body || req.body.length === 0) {
        return res.status(400).send('Missing data');
    }
    if (!security.verifyHmacSignature(req.body, cfg.ALBY_WEBHOOK_SECRET, sig)) {
        log.error({ deliveryId }, 'INVALID Alby HMAC');
        return res.status(401).send('Invalid signature');
    }
    
    let payload;
    try { payload = JSON.parse(req.body.toString()); }
    catch { return res.status(400).send('Bad JSON'); }
    
    const payloadHash = crypto.createHash('sha256').update(req.body).digest('hex');
    const isNew = await recordWebhookDelivery({
        source: 'alby',
        deliveryId,
        invoiceId: payload.payment_hash,
        eventType: payload.event || payload.type || 'unknown',
        payloadHash,
    });
    if (!isNew) return res.status(200).send('Duplicate');
    
    log.info({ deliveryId, eventType: payload.event }, 'Alby webhook received');
    // TODO: spracovať podľa potreby (zatiaľ nás zaujímajú iba NWC notifikácie cez subscription)
    await markWebhookProcessed({ source: 'alby', deliveryId, success: true });
    res.status(200).send('OK');
});

// ----------------------------------------------------------------------------
// Štandardné JSON parsovanie pre ostatné endpointy
// ----------------------------------------------------------------------------
app.use(express.json({ limit: '100kb' }));

// ----------------------------------------------------------------------------
// Unified www portal + bots.* alias
// ----------------------------------------------------------------------------
// Primary HTML is repo-root index.html + /site/app.js (Tailwind CDN + dynamic /api).
// Optional: BOTS_PORTAL_PUBLIC_BASE (no trailing slash), default https://www.umbraxon.xyz
// Host bots.umbraxon.xyz → HTTP 301 to that base (query preserved).
const BOTS_ALIAS_HOST = 'bots.umbraxon.xyz';
const BOTS_PORTAL_PUBLIC_BASE = String(process.env.BOTS_PORTAL_PUBLIC_BASE || 'https://www.umbraxon.xyz').replace(/\/$/, '');

app.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (host !== BOTS_ALIAS_HOST) return next();
    if (req.path.startsWith('/.well-known/')) return next();
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'NOT_FOUND' });
    let u;
    try {
        u = new URL(req.originalUrl || '/', 'https://internal.local');
    } catch (_) {
        return res.redirect(301, `${BOTS_PORTAL_PUBLIC_BASE}/bots/`);
    }
    const target = new URL('/bots/', `${BOTS_PORTAL_PUBLIC_BASE}/`);
    if (u.search) target.search = u.search;
    return res.redirect(301, target.toString());
});

app.use(express.static(__dirname, { dotfiles: 'ignore', index: 'index.html' }));

// Strategic Sprint §30 Item 10 — Prometheus instrumentation. Place AFTER
// json+static so static asset hits also count toward request totals, but
// BEFORE any route handlers so res.on('finish') fires once per response.
app.use(metrics.requestMetricsMiddleware());

// ----------------------------------------------------------------------------
// 3) Tiery
// ----------------------------------------------------------------------------
app.get('/api/tiers', (req, res) => {
    res.json({
        BASIC: {
            total: TIERS.BASIC.total,
            grade: TIERS.BASIC.grade,
            durationMonths: TIERS.BASIC.durationMonths,
            startingReputation: TIERS.BASIC.baseReputation,
            startingZone: reputation.getZone(TIERS.BASIC.baseReputation).name,
            requiresAnchor: TIERS.BASIC.requiresAnchor,
        },
        ELITE: {
            total: TIERS.ELITE.total,
            grade: TIERS.ELITE.grade,
            durationMonths: TIERS.ELITE.durationMonths,
            startingReputation: TIERS.ELITE.baseReputation,
            startingZone: reputation.getZone(TIERS.ELITE.baseReputation).name,
            requiresAnchor: TIERS.ELITE.requiresAnchor,
            public_listing: eliteListing.cfgSummary(),
        },
        max_score: reputation.MAX_SCORE,
        max_manufacturer_bonus: reputation.MAX_MANUFACTURER_BONUS,
    });
});

// ----------------------------------------------------------------------------
// 4) Vytvorenie faktúry
// ----------------------------------------------------------------------------
// PoW gate (Phase 2.2) — voliteľne aplikované pred /api/pay
const payPowGate = pow.buildRequireMiddleware({
    poolGetter: () => pool,
    purpose: 'pay',
    recordRejection: (req, reason) => abuseTracker.recordRejection(pool, {
        path: req.path, method: req.method, reason,
        http_status: 402, client_ip: req.ip, user_agent: req.headers['user-agent'],
    }),
    // Telemetria pre dashboard: distribúcia reálneho času riešenia legit klientov.
    // Hľadáme p50/p95/p99 — ak je p95 < 5 s, dnešná obtiažnosť je v poriadku.
    onSuccess: (req, info) => {
        logger.info({
            msg: 'pow_solved',
            purpose: info.purpose,
            difficulty: info.difficulty,
            iterations: info.iterations,
            solve_ms: info.solve_ms,
            client_ip: req.ip,
        }, 'pow_solved');
    },
});

app.post('/api/pay', payLimiter, (req, res) => {
    res.set('Deprecation', 'true');
    res.set('Link', '</api/v1/register>; rel="successor-version"');
    return res.status(410).json({
        error: 'ENDPOINT_DEPRECATED',
        message: 'Human / legacy pay removed. Autonomous agents must use POST /api/v1/register.',
        successor: '/api/v1/register',
        docs: '/README_API.md',
        legacy_equivalent: '/api/register/initiate',
    });
});

// ----------------------------------------------------------------------------
// 5) Check status (polling z frontendu)
// ----------------------------------------------------------------------------
app.get('/api/check-status/:invoiceId', async (req, res) => {
    const { invoiceId } = req.params;
    if (!invoiceId || !/^[A-Za-z0-9_-]+$/.test(invoiceId)) {
        return res.status(400).json({ error: 'INVALID_INVOICE_ID' });
    }
    
    // Skús najprv Alby (paymentHash = invoiceId pre alby flow)
    if (alby.isConnected()) {
        try {
            const status = await alby.lookupInvoice({ paymentHash: invoiceId });
            const normalized = status.settled ? 'PAID' : (status.state === 'expired' ? 'EXPIRED' : 'WAITING');
            return res.json({ status: normalized, source: 'alby', albyState: status.state, settledAt: status.settledAt, amountSats: status.amountSats });
        } catch (_) {
            // skús BTCPay
        }
    }
    
    // BTCPay fallback
    try {
        const r = await axios.get(
            `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices/${invoiceId}`,
            { headers: { 'Authorization': `token ${cfg.BTCPAY_API_KEY}` }, timeout: 5000, proxy: false }
        );
        const inv = r.data;
        const s = (inv.status || '').toLowerCase();
        const normalized = (s === 'settled' || s === 'complete' || s === 'completed') ? 'PAID'
                         : s === 'processing' ? 'PROCESSING'
                         : (s === 'expired' || s === 'invalid') ? 'EXPIRED'
                         : 'WAITING';
        return res.json({ status: normalized, source: 'btcpay', btcpayStatus: inv.status, invoiceId: inv.id, amount: inv.amount, currency: inv.currency });
    } catch (err) {
        logger.error({ route: 'check-status', err: err.message, invoiceId }, 'status check failed');
        return res.status(404).json({ error: 'INVOICE_NOT_FOUND' });
    }
});

// ----------------------------------------------------------------------------
// 6) Health
// ----------------------------------------------------------------------------
// Lightweight liveness ping (no DB, no upstream calls). Pre external uptime
// monitory ako UptimeRobot / cron health-alert. /api/health ostáva pre detailný
// component-level check.
app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', uptime_s: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// /api/health — Audit hardening (2026-05-12, §32):
//   1) Upstream probes (DB SELECT 1 + BTCPay invoices?take=1) are NO LONGER
//      executed synchronously per request — they ran on every hit, turning
//      a public unauthenticated endpoint into a DoS amplifier against the
//      BTCPay upstream. Now the probes execute on a background interval
//      (HEALTH_PROBE_INTERVAL_MS, default 60 000 ms) and this endpoint
//      returns the cached snapshot + `staleness_ms` so monitors can detect
//      stuck probes.
//   2) Raw DB driver `err.message` strings (which leaked host/port and
//      sometimes credential hints) are mapped to a small fixed vocabulary
//      of `db.status` labels. Verbose raw errors are accessible only via
//      GET /api/admin/health/details with X-Admin-Key.
// Cold-start: first call may execute a live probe if the cache is empty,
// so a freshly-restarted process still returns useful data on the first
// request. Subsequent calls within HEALTH_PROBE_INTERVAL_MS use the cache.
// ----------------------------------------------------------------------------
const HEALTH_PROBE_INTERVAL_MS = parseInt(process.env.HEALTH_PROBE_INTERVAL_MS || '60000', 10);
const HEALTH_STALE_CYCLE_MULT  = parseInt(process.env.HEALTH_STALE_CYCLE_MULT  || '5', 10);
// Cached snapshot, populated by `_runHealthProbe()` on interval + cold-start.
//   _healthCache.ts          : ms epoch of the last successful probe sweep (any component)
//   _healthCache.db          : { status: 'OK'|'unreachable'|'auth_failure'|'db_missing'|'error',
//                                latency_ms?: number, raw?: {code,message,host,port} }
//   _healthCache.btcpay      : { status: 'OK'|'http_error'|'unreachable'|'error',
//                                latency_ms?: number, http_status?: number, raw?: {code,message} }
let _healthCache = {
    ts: 0,
    db:     { status: 'unknown' },
    btcpay: { status: 'unknown' },
};
let _healthProbeInFlight = false;

// Maps a `pg`-driver error to a sanitised public label.
function _classifyDbError(e) {
    if (!e) return 'error';
    const code = e.code || e.errno || '';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') return 'unreachable';
    if (code === '28P01' || code === '28000') return 'auth_failure';       // PG: invalid_password / invalid_authorization
    if (code === '3D000') return 'db_missing';                              // PG: invalid_catalog_name
    return 'error';
}

// Maps an axios/btcpay probe error to a sanitised public label.
function _classifyBtcpayError(e) {
    if (!e) return 'error';
    if (e.response && typeof e.response.status === 'number') return 'http_error';
    const code = e.code || '';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' ||
        code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'unreachable';
    return 'error';
}

async function _runHealthProbe() {
    if (_healthProbeInFlight) return _healthCache;
    _healthProbeInFlight = true;
    const start = Date.now();
    // DB probe.
    const dbStart = Date.now();
    try {
        await pool.query('SELECT 1');
        _healthCache.db = { status: 'OK', latency_ms: Date.now() - dbStart };
    } catch (e) {
        _healthCache.db = {
            status: _classifyDbError(e),
            latency_ms: Date.now() - dbStart,
            raw: {
                code: e && e.code,
                message: e && e.message,
                host: e && (e.address || e.host),
                port: e && e.port,
            },
        };
    }
    // BTCPay probe (best-effort, low frequency).
    const bpStart = Date.now();
    try {
        await axios.get(
            `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices?take=1`,
            { headers: { 'Authorization': `token ${cfg.BTCPAY_API_KEY}` }, timeout: 3000, proxy: false }
        );
        _healthCache.btcpay = { status: 'OK', latency_ms: Date.now() - bpStart };
    } catch (e) {
        _healthCache.btcpay = {
            status: _classifyBtcpayError(e),
            latency_ms: Date.now() - bpStart,
            http_status: (e && e.response && typeof e.response.status === 'number') ? e.response.status : null,
            raw: {
                code: e && e.code,
                message: e && e.message,
            },
        };
    }
    _healthCache.ts = start;
    _healthProbeInFlight = false;
    return _healthCache;
}

// Background interval. `unref()` so it doesn't keep the event loop alive on
// shutdown. Kicked from the `start()` boot block below so we have `pool` ready.
let _healthProbeTimer = null;
function _startHealthProbeLoop() {
    if (_healthProbeTimer) return;
    _healthProbeTimer = setInterval(() => {
        _runHealthProbe().catch(() => { /* swallow — cache will reflect failure */ });
    }, HEALTH_PROBE_INTERVAL_MS);
    if (typeof _healthProbeTimer.unref === 'function') _healthProbeTimer.unref();
}

app.get('/api/health', async (req, res) => {
    // Cold-start: if cache is empty, fire one live probe so the first call
    // after `pm2 restart` still returns useful data.
    if (!_healthCache.ts) {
        await _runHealthProbe().catch(() => {});
    }
    const now = Date.now();
    const staleness_ms = _healthCache.ts ? (now - _healthCache.ts) : null;
    const degraded = (staleness_ms !== null) &&
                     (staleness_ms > HEALTH_PROBE_INTERVAL_MS * HEALTH_STALE_CYCLE_MULT);

    const albyStatus = alby.isConfigured()
        ? (alby.isConnected() ? 'OK' : 'NOT_CONNECTED')
        : 'NOT_CONFIGURED';

    res.set('Cache-Control', 'no-store');
    res.json({
        server: 'OK',
        env: cfg.NODE_ENV,
        hub_release: { version: HUB_RELEASE_VERSION, phase: HUB_RELEASE_PHASE },
        timestamp: new Date().toISOString(),
        db:     { status: _healthCache.db.status,     latency_ms: _healthCache.db.latency_ms     || null },
        btcpay: { status: _healthCache.btcpay.status, latency_ms: _healthCache.btcpay.latency_ms || null,
                  http_status: _healthCache.btcpay.http_status || null },
        alby: albyStatus,
        // Legacy single-string fields for backward-compat with older callers
        // (UptimeRobot / Netdata YAML pickers that key on these names).
        database: _healthCache.db.status === 'OK' ? 'OK' : `FAIL: ${_healthCache.db.status}`,
        // Cache freshness — clients (Netdata/ops dashboard) can detect stuck probes.
        cache: {
            probe_interval_ms: HEALTH_PROBE_INTERVAL_MS,
            staleness_ms,
            stale_cycle_threshold: HEALTH_STALE_CYCLE_MULT,
            degraded,
            last_probe_at: _healthCache.ts ? new Date(_healthCache.ts).toISOString() : null,
        },
    });
});

// Admin-only verbose health endpoint — returns raw error details (pg code,
// host, port, message) for troubleshooting. Gated by X-Admin-Key.
app.get('/api/admin/health/details', security.adminAuth, async (req, res) => {
    // Operator may force a fresh probe by appending `?refresh=1`.
    if (req.query.refresh === '1') {
        await _runHealthProbe().catch(() => {});
    } else if (!_healthCache.ts) {
        await _runHealthProbe().catch(() => {});
    }
    const now = Date.now();
    res.set('Cache-Control', 'no-store');
    res.json({
        server: 'OK',
        env: cfg.NODE_ENV,
        hub_release: { version: HUB_RELEASE_VERSION, phase: HUB_RELEASE_PHASE },
        timestamp: new Date().toISOString(),
        cache: {
            probe_interval_ms: HEALTH_PROBE_INTERVAL_MS,
            staleness_ms: _healthCache.ts ? (now - _healthCache.ts) : null,
            last_probe_at: _healthCache.ts ? new Date(_healthCache.ts).toISOString() : null,
        },
        db: _healthCache.db,         // includes raw {code,message,host,port}
        btcpay: _healthCache.btcpay, // includes raw {code,message} + http_status
        alby: {
            configured: alby.isConfigured(),
            connected: alby.isConfigured() ? alby.isConnected() : false,
        },
    });
});

// ============================================================================
// PHASE 1.5 — Identity & Certificate endpoints
// ============================================================================

// ----------------------------------------------------------------------------
// 7) Hub verejný kľúč + metadata
// ----------------------------------------------------------------------------
app.get('/api/hub/pubkey', (req, res) => {
    try {
        const info = hubkeys.getPublicInfo();
        res.json({
            ...info,
            trusted_manufacturers: [...TRUSTED_MFRS.values()].map(m => ({ id: m.id, pubkey: m.pubkey, bonus: m.bonus })),
            manifest_schema_url: '/api/protocol/manifest-schema',
            protocol_version: '1.0',
        });
    } catch (err) {
        logger.error({ err: err.message }, 'hub/pubkey FAIL');
        res.status(500).json({ error: 'HUB_KEYS_UNAVAILABLE' });
    }
});

// ----------------------------------------------------------------------------
// 7.5) Manifest schema (verejne dostupná pre klientov)
// ----------------------------------------------------------------------------
app.get('/api/protocol/manifest-schema', (req, res) => {
    res.json(manifestSchema.SCHEMA);
});

// ----------------------------------------------------------------------------
// 7.55) L402-aligned delegated payment profile + delegation pass verify
// ----------------------------------------------------------------------------
app.get('/api/protocol/l402-delegation-profile', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(delegationPass.l402DelegationProfileDoc());
});

app.get('/api/protocol/integrator-lsat-profile', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(integratorLsat.profileDoc());
});

app.post('/api/delegation-pass/verify', async (req, res) => {
    const pass = req.body;
    const v = delegationPass.verifyDelegationPass(pass);
    res.json({
        ...v,
        optional_next_checks: {
            crl: '/crl/latest.json',
            cert_status: pass && pass.sub ? `/api/cert/${pass.sub}/status` : null,
        },
    });
});

// ----------------------------------------------------------------------------
// 7.56) Public discovery feed (opt-in agents only)
// ----------------------------------------------------------------------------
app.get('/api/discovery/v1/agents.json', async (req, res) => {
    const cap = (req.query.capability || '').trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const params = [];
    let where = `WHERE a.discovery_opt_in = TRUE AND a.is_active = TRUE AND a.status = 'VERIFIED'`;
    if (cap) {
        params.push(cap);
        where += ` AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(a.agent_manifest->'agent'->'capabilities', '[]'::jsonb)) cap
            WHERE lower(cap) = lower($${params.length})
        )`;
    }
    params.push(limit);
    const limIdx = params.length;
    try {
        const r = await pool.query(
            `SELECT a.kya_id, a.agent_name, a.tier, a.reputation_score,
                    a.agent_manifest->'agent'->'capabilities' AS capabilities,
                    a.agent_manifest->'payment_hints' AS payment_hints
             FROM agents a
             ${where}
             ORDER BY a.reputation_score DESC NULLS LAST
             LIMIT $${limIdx}`,
            params
        );
        res.set('Cache-Control', 'public, max-age=30');
        res.json({
            profile: delegationPass.L402_PROFILE_ID,
            count: r.rowCount,
            agents: r.rows,
        });
    } catch (e) {
        logger.error({ err: e.message }, 'discovery feed FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 7.57) Embed badge (SVG) — third-party pages / README shields
// ----------------------------------------------------------------------------
app.get('/api/embed/badge/:kya_id', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        return res.status(400).type('text/plain').send('INVALID_KYA_ID');
    }
    const fmt = (req.query.format || 'svg').toLowerCase();
    try {
        const r = await pool.query(
            `SELECT a.kya_id, a.agent_name, a.status, a.is_active, c.revoked_at
             FROM agents a
             LEFT JOIN certificates c ON c.kya_id = a.kya_id AND c.is_current = TRUE
             WHERE a.kya_id = $1`,
            [kya_id]
        );
        if (r.rowCount === 0) {
            if (fmt === 'json') return res.status(404).json({ error: 'NOT_FOUND' });
            return res.status(404).type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><text x="4" y="14" font-size="11">KYA unknown</text></svg>');
        }
        const row = r.rows[0];
        const ok = row.is_active && row.status === 'VERIFIED' && !row.revoked_at;
        if (fmt === 'json') {
            return res.json({
                kya_id,
                agent_name: row.agent_name,
                status: ok ? 'verified' : 'not_verified',
                hub: hubkeys.getPublicInfo().hub_url || 'https://umbraxon.xyz',
            });
        }
        const label = ok ? 'KYA verified' : 'KYA not ok';
        const fill = ok ? '#16a34a' : '#64748b';
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="20" role="img" aria-label="${label}">
  <title>${label}</title>
  <rect width="120" height="20" rx="3" fill="${fill}"/>
  <text x="8" y="14" fill="#ffffff" font-family="system-ui,sans-serif" font-size="11">${row.agent_name.slice(0, 18)}</text>
</svg>`;
        res.set('Cache-Control', 'public, max-age=60');
        res.type('image/svg+xml').send(svg);
    } catch (e) {
        logger.error({ err: e.message, kya_id }, 'embed badge FAIL');
        res.status(500).type('text/plain').send('ERR');
    }
});

// ----------------------------------------------------------------------------
// 7.6) Strategic Sprint §30 Item 9 — Protocol version handshake.
//      Clients MUST call this before any other API call to pick a
//      `protocol_version` they support. Cached for 60s at the edge.
// ----------------------------------------------------------------------------
const PROTOCOL_VERSION_INFO = (() => {
    // Pull from manifest-schema enum when possible so we never drift.
    let supported;
    try {
        const enumList = manifestSchema?.SCHEMA?.properties?.protocol_version?.enum;
        supported = Array.isArray(enumList) && enumList.length ? enumList.slice() : ['1.0'];
    } catch (_) { supported = ['1.0']; }
    const preferred = process.env.HUB_PROTOCOL_PREFERRED
        || supported[supported.length - 1] || '1.0';
    const minRequired = process.env.HUB_PROTOCOL_MIN_REQUIRED || supported[0] || '1.0';
    const deprecated = (process.env.HUB_PROTOCOL_DEPRECATED || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const nextPlanned = process.env.HUB_PROTOCOL_NEXT_PLANNED || '1.1';
    const changelogUrl = process.env.HUB_PROTOCOL_CHANGELOG_URL
        || 'https://umbraxon.xyz/docs/protocol-changelog';
    return {
        supported,
        preferred,
        deprecated,
        min_required: minRequired,
        next_planned: nextPlanned,
        changelog_url: changelogUrl,
        handshake_required: true,
    };
})();

app.get('/api/protocol/versions', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json(PROTOCOL_VERSION_INFO);
});

// ----------------------------------------------------------------------------
// 7.6) Proof-of-Work captcha (Phase 2.2)
// ----------------------------------------------------------------------------
// Klient si vyžiada challenge, vyrieši ho a pošle riešenie spolu s drahým
// requestom (napr. /api/pay, /api/register/initiate).
//
// Rate limit: dosť veľký (60/min) — challenge generation samotné je lacné,
// drahé je riešiť. Banuje sa fail2ban heuristikou ak niekto generuje
// tisíce a nikdy nerieši.
const powLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Max 60 PoW challenges/min/IP' },
    skip: _adminBypass,
});
_rateLimiters.pow = powLimiter;

app.get('/api/pow/challenge', powLimiter, async (req, res) => {
    const purpose = req.query.purpose || 'generic';
    const difficulty = req.query.difficulty ? parseInt(req.query.difficulty, 10) : undefined;
    const tierRaw = (req.query.tier || '').toString().toUpperCase();
    const tier = tierRaw === 'BASIC' || tierRaw === 'ELITE' ? tierRaw : undefined;

    if (!pow.PURPOSES.includes(purpose)) {
        return rejectAndLog(req, res, 400, 'INVALID_POW_PURPOSE', {
            body: { allowed: pow.PURPOSES },
        });
    }
    if (tier && purpose !== 'register') {
        return rejectAndLog(req, res, 400, 'INVALID_POW_TIER', {
            body: { message: 'Query tier=BASIC|ELITE is only valid with purpose=register' },
        });
    }

    try {
        const ch = await pow.createChallenge(pool, {
            purpose, difficulty, clientIp: req.ip, tier,
        });
        return res.json({
            ...ch,
            required: pow.isRequiredFor(purpose),
            note: pow.isRequiredFor(purpose)
                ? `Endpoint pre purpose=${purpose} vyžaduje PoW.`
                : `PoW pre ${purpose} je voliteľný (gate je vypnutý alebo nie je v REQUIRED_FOR).`,
        });
    } catch (err) {
        logger.error({ err: err.message }, 'pow challenge create FAIL');
        return res.status(500).json({ error: 'POW_CREATE_FAILED' });
    }
});

// Endpoint na samostatnú validáciu (debug/test) — vráti či je riešenie valid bez bind-u na endpoint
app.post('/api/pow/verify', powLimiter, async (req, res) => {
    const { challenge_id, nonce, iterations } = req.body || {};
    if (!challenge_id || !nonce) {
        return res.status(400).json({ error: 'MISSING_FIELDS', required: ['challenge_id', 'nonce'] });
    }
    const result = await pow.verifySolution(pool, {
        challenge_id, nonce, iterations, clientIp: req.ip,
    });
    if (!result.valid) {
        return res.status(402).json({ valid: false, ...result });
    }
    return res.json({ valid: true, ...result });
});

// ----------------------------------------------------------------------------
// 8) Challenge-response: bot si vyžiada nonce
// ----------------------------------------------------------------------------
const challengeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: 'Max 20 challenges/min/IP' },
    skip: (req) => _adminBypass(req),
});
_rateLimiters.challenge = challengeLimiter;

app.get('/api/auth/challenge', challengeLimiter, async (req, res) => {
    const pubkey = (req.query.pubkey || '').toLowerCase();
    if (pubkey && !security.isValidPubkey(pubkey)) {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'INVALID_PUBKEY',
            http_status: 400, client_ip: req.ip, user_agent: req.headers['user-agent'],
        }).catch(() => {});
        return res.status(400).json({ error: 'INVALID_PUBKEY' });
    }
    try {
        const ch = await createChallenge({
            pubkey: pubkey || null,
            purpose: req.query.purpose || 'register',
            clientIp: req.ip,
        });
        res.json(ch);
    } catch (err) {
        logger.error({ err: err.message }, 'createChallenge FAIL');
        res.status(500).json({ error: 'CHALLENGE_FAILED' });
    }
});

// ----------------------------------------------------------------------------
// 9) Registration initiate — validovaný flow s manifestom a podpisom
// ----------------------------------------------------------------------------
// PoW gate (Phase 2.2) — registrácia je drahá operácia
const registerPowGate = pow.buildRequireMiddleware({
    poolGetter: () => pool,
    purpose: 'register',
    recordRejection: (req, reason) => abuseTracker.recordRejection(pool, {
        path: req.path, method: req.method, reason,
        http_status: 402, client_ip: req.ip, user_agent: req.headers['user-agent'],
    }),
    // Telemetria pre dashboard (rovnaký dôvod ako pri payPowGate).
    onSuccess: (req, info) => {
        logger.info({
            msg: 'pow_solved',
            purpose: info.purpose,
            difficulty: info.difficulty,
            iterations: info.iterations,
            solve_ms: info.solve_ms,
            client_ip: req.ip,
        }, 'pow_solved');
    },
});
const registerAdmissionGate = sponsorInvite.buildRegisterAdmissionMiddleware({
    poolGetter: () => pool,
    powGate: registerPowGate,
    recordRejection: (req, reason) => abuseTracker.recordRejection(pool, {
        path: req.path, method: req.method, reason,
        http_status: 402, client_ip: req.ip, user_agent: req.headers['user-agent'],
    }),
});

async function handleRegisterInitiate(req, res) {
    const log = logger.child({ route: req.path.includes('/v1/') ? 'v1/register' : 'register/initiate' });
    const { manifest, manifest_signature, challenge_id, challenge_response } = req.body || {};
    
    // Helper na audit rejection
    const reject = (status, reason, extra = {}) => {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason,
            http_status: status, client_ip: req.ip, user_agent: req.headers['user-agent'],
            error_detail: extra.detail,
            metadata: extra.metadata,
        }).catch(() => {});
        return res.status(status).json({ error: reason, ...(extra.body || {}) });
    };
    
    // 1) Manifest schema validácia
    if (!manifest || typeof manifest !== 'object') {
        return reject(400, 'MISSING_MANIFEST');
    }
    const v = manifestSchema.validate(manifest);
    if (!v.valid) {
        return reject(400, 'MANIFEST_INVALID', { body: { errors: v.errors }, detail: 'schema validation failed' });
    }
    const extAudit = integrationsManifest.auditManifestExtensions(manifest);
    if (!extAudit.ok) {
        return reject(400, 'MANIFEST_EXTENSION_INVALID', { body: { errors: extAudit.errors }, detail: 'payment_hints / integrations' });
    }

    // 2) Timestamp tolerancia (Phase 2.4: konfigurovateľná cez TIMESTAMP_SKEW_MS)
    const tsMs = new Date(manifest.timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return reject(400, 'MANIFEST_TIMESTAMP_SKEW', {
            body: { message: `Manifest timestamp musí byť ±${Math.floor(TIMESTAMP_SKEW_MS/1000)}s od server času` },
        });
    }
    
    // 3) Tier kontrola
    const tierName = manifest.tier_requested;
    const tier = tierName === 'ELITE' ? { ...TIERS.ELITE, name: 'ELITE' }
              : tierName === 'BASIC' ? { ...TIERS.BASIC, name: 'BASIC' }
              : null;
    if (!tier) return reject(400, 'INVALID_TIER');
    
    const botPubkey = manifest.agent.pubkey.toLowerCase();
    const agentName = manifest.agent.name;
    
    // 4) Manifest hash + bot signature verify
    const mHash = manifestSchema.manifestHash(manifest);
    const mHashBuf = Buffer.from(mHash, 'hex');
    if (!manifest_signature || !/^[0-9a-fA-F]{128}$/.test(manifest_signature)) {
        return reject(400, 'MISSING_OR_BAD_SIGNATURE', {
            body: { message: 'manifest_signature (Ed25519, 64B hex) povinný' },
        });
    }
    if (!hubkeys.verify(mHashBuf, manifest_signature, botPubkey)) {
        log.warn({ agentName, botPubkey }, 'bot signature INVALID');
        return reject(401, 'BAD_MANIFEST_SIGNATURE', {
            body: { message: 'manifest_signature neprešiel verifikáciou voči agent.pubkey' },
            detail: `agentName=${agentName} pubkey=${botPubkey.slice(0, 12)}...`,
        });
    }
    
    // 5) Challenge-response (anti-replay cross-request)
    if (!challenge_id || !challenge_response) {
        return reject(400, 'CHALLENGE_REQUIRED', {
            body: { message: 'Najprv si vyžiadaj nonce cez GET /api/auth/challenge' },
        });
    }
    
    // Najprv overíme že challenge_response je platný Ed25519 podpis nonce-u
    // → načítame nonce z DB, podpíšeme ho a porovnáme
    const chRow = await pool.query(
        `SELECT id, nonce, pubkey, expires_at, used_at FROM auth_challenges WHERE challenge_id = $1`,
        [challenge_id]
    );
    if (chRow.rowCount === 0) return reject(401, 'CHALLENGE_NOT_FOUND');
    const ch = chRow.rows[0];
    if (ch.used_at) return reject(401, 'CHALLENGE_ALREADY_USED');
    if (new Date(ch.expires_at) < new Date()) return reject(401, 'CHALLENGE_EXPIRED');
    if (ch.pubkey && ch.pubkey.toLowerCase() !== botPubkey) return reject(401, 'PUBKEY_MISMATCH');
    
    // Bot mal podpísať raw nonce bytes
    const nonceBuf = Buffer.from(ch.nonce, 'hex');
    if (!/^[0-9a-fA-F]{128}$/.test(challenge_response) || !hubkeys.verify(nonceBuf, challenge_response, botPubkey)) {
        return reject(401, 'BAD_CHALLENGE_RESPONSE');
    }
    
    // Označ challenge ako použitý
    const consumed = await consumeChallenge({ challengeId: challenge_id, nonce: ch.nonce, expectedPubkey: botPubkey });
    if (!consumed) return reject(401, 'CHALLENGE_RACE', {
        body: { message: 'challenge bol medzitým použitý alebo expirovaný' },
    });
    
    // 6) Manufacturer attestation (voliteľné).
    // Two sources of truth (DB takes precedence over env list):
    //   a) DB-backed manufacturer_attestations (Phase 4B) — operator-curated
    //      registry of trusted manufacturers + signed pre-attestations.
    //   b) Legacy env-var TRUSTED_MANUFACTURERS + in-manifest manufacturer.attestation
    //      (Phase 1.5) — kept for backward compat.
    let mfrResult = verifyManufacturerAttestation(manifest);
    let mfrDbAttestationId = null;
    try {
        const dbAtt = await manufacturer.findUsableAttestation(pool, {
            manifest_hash: mHash, agent_pubkey: botPubkey, agent_name: agentName,
        });
        if (dbAtt) {
            // DB attestation wins: derive verified=true + tier-based bonus
            mfrResult = {
                present: true,
                verified: true,
                bonus: dbAtt.rep_bonus,
                manufacturerId: dbAtt.mfr_ext_id,
                tier: dbAtt.tier,
                source: 'db_attestation',
                attestation_id: Number(dbAtt.id),
            };
            mfrDbAttestationId = Number(dbAtt.id);
        }
    } catch (e) {
        log.warn({ err: e.message }, 'manufacturer DB attestation lookup FAIL (continuing with env-based check)');
    }
    log.info({ agentName, botPubkey, mfr: mfrResult }, 'manufacturer check');
    
    // 7) Uniqueness: agent_name aj pubkey ešte nesmú existovať
    const existsName = await pool.query('SELECT id, status FROM agents WHERE agent_name = $1', [agentName]);
    if (existsName.rowCount > 0) {
        return res.status(409).json({ error: 'AGENT_NAME_TAKEN', status: existsName.rows[0].status });
    }
    const existsKey = await pool.query("SELECT id, agent_name, pubkey_blacklisted, retired_at FROM agents WHERE agent_pubkey = $1 AND agent_pubkey <> ''", [botPubkey]);
    if (existsKey.rowCount > 0) {
        const row = existsKey.rows[0];
        // Phase 2.3: ak je pubkey blacklisted (retired/purged), nedovolíme reuse
        if (row.pubkey_blacklisted || row.retired_at) {
            return rejectAndLog(req, res, 410, 'PUBKEY_BLACKLISTED', {
                kya_id: null,
                detail: 'this pubkey was used by a retired/purged agent and cannot be reused',
            });
        }
        return res.status(409).json({ error: 'PUBKEY_ALREADY_REGISTERED', conflicting_agent: row.agent_name });
    }
    
    // 8) Vytvor registration intent + LN invoice
    const registrationId = 'REG-' + crypto.randomBytes(12).toString('hex');
    const intentExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hodina
    
    try {
        const sponsorInviteId = req.sponsor_invite_verified?.invite_id
            || req.body?.sponsor_invite_id
            || null;
        const intentIns = await pool.query(
            `INSERT INTO registration_intents
             (registration_id, agent_name, agent_pubkey, manifest, manifest_hash, manifest_signature,
              manufacturer_id, manufacturer_signature, manufacturer_verified, manufacturer_bonus,
              tier_requested, expires_at, client_ip, user_agent,
              mfr_attestation_id, mfr_tier, sponsor_invite_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING id`,
            [
                registrationId, agentName, botPubkey,
                JSON.stringify(manifest), mHash, manifest_signature,
                mfrResult.manufacturerId
                    || (mfrResult.present && manifest.manufacturer ? manifest.manufacturer.id : null),
                mfrResult.present && manifest.manufacturer ? manifest.manufacturer.attestation : null,
                mfrResult.verified, mfrResult.bonus,
                tier.name, intentExpires,
                req.ip, req.headers['user-agent'] || null,
                mfrDbAttestationId, mfrResult.tier || null,
                sponsorInviteId,
            ]
        );
        if (sponsorInviteId) {
            const consumed = await sponsorInvite.markConsumed(pool, {
                inviteId: sponsorInviteId,
                inviteePubkey: botPubkey,
                tierRequested: tier.name,
                registrationIntentId: registrationId,
                agentName,
            });
            if (!consumed.ok) {
                log.warn({ sponsorInviteId, reason: consumed.reason }, 'sponsor invite consume FAIL after intent');
            }
        }
    } catch (e) {
        log.error({ err: e.message }, 'intent INSERT FAIL');
        return res.status(500).json({ error: 'INTENT_PERSIST_FAILED' });
    }
    
    const regResponseExtras = req.sponsor_invite_verified ? {
        pow_bypassed: true,
        sponsor_invite_id: req.sponsor_invite_verified.invite_id,
    } : {};

    // Vytvor invoice — preferuj Alby ak je dostupné
    const description = `UMBRAXON ${tier.name} registration: ${agentName} [${registrationId}]`;
    const useAlby = alby.isConfigured() && alby.isConnected();
    let invoiceFailSource = null;

    try {
        if (useAlby) {
            invoiceFailSource = 'alby';
            const inv = await alby.createInvoice({
                amountSats: tier.total,
                description,
                metadata: { registrationId, agentName, pubkey: botPubkey, tier: tier.name, amount: tier.total, mHash },
            });
            await pool.query(
                `UPDATE registration_intents SET invoice_id = $1 WHERE registration_id = $2`,
                [inv.paymentHash, registrationId]
            );
            log.info({
                event: 'registration_intent_created',
                registration_id: registrationId,
                agent_name: agentName,
                tier: tier.name,
                amount_sats: tier.total,
                invoice_id: inv.paymentHash,
                method: 'alby-lightning',
            }, 'registration_intent_created');
            return res.json({
                registration_id: registrationId,
                method: 'alby-lightning',
                invoiceId: inv.paymentHash,
                paymentRequest: inv.invoice,
                expiresAt: inv.expiresAt,
                tier: { name: tier.name, grade: tier.grade, total: tier.total },
                manufacturer: mfrResult,
                manifest_hash: mHash,
                status_poll_url: `/api/v1/register/status?registration_id=${registrationId}`,
                ...regResponseExtras,
            });
        }

        // Fallback BTCPay
        invoiceFailSource = 'btcpay';
        const r = await axios.post(
            `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices`,
            {
                amount: tier.total,
                currency: 'SATS',
                metadata: { registrationId, agentName, pubkey: botPubkey, amount: tier.total, mHash },
                checkout: { speedPolicy: 'HighSpeed', redirectURL: cfg.REDIRECT_URL },
            },
            { headers: { 'Authorization': `token ${cfg.BTCPAY_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const invoice = r.data;
        await pool.query(
            `UPDATE registration_intents SET invoice_id = $1 WHERE registration_id = $2`,
            [invoice.id, registrationId]
        );
        
        log.info({
            event: 'registration_intent_created',
            registration_id: registrationId,
            agent_name: agentName,
            tier: tier.name,
            amount_sats: tier.total,
            invoice_id: invoice.id,
            method: 'btcpay',
        }, 'registration_intent_created');
        return res.json({
            registration_id: registrationId,
            method: 'btcpay',
            invoiceId: invoice.id,
            checkoutLink: invoice.checkoutLink,
            tier: { name: tier.name, grade: tier.grade, total: tier.total },
            manufacturer: mfrResult,
            manifest_hash: mHash,
            status_poll_url: `/api/v1/register/status?registration_id=${registrationId}`,
            ...regResponseExtras,
        });
    } catch (err) {
        const httpStatus = (err.response && typeof err.response.status === 'number')
            ? err.response.status : null;
        const errCode = err.code ? String(err.code) : null;
        log.error({
            err: err.message,
            http_status: httpStatus,
            code: errCode,
            source: invoiceFailSource,
            registration_id: registrationId,
        }, 'invoice create FAIL');
        return res.status(502).json({
            error: 'INVOICE_FAILED',
            message: 'Nepodarilo sa vytvoriť faktúru, skús to o chvíľu znova.',
        });
    }
}

const registrationIpDailyCap = registrationIpCap.buildMiddleware({
    poolGetter: () => pool,
    adminBypass: (req) => {
        const k = req.headers['x-admin-key'];
        return !!(k && cfg.ADMIN_API_KEY && k === cfg.ADMIN_API_KEY);
    },
});

app.post(
    '/api/v1/register',
    v1RegisterLimiter,
    registrationIpDailyCap,
    registerAdmissionGate,
    apiV1Register.normalizeMiddleware,
    handleRegisterInitiate,
);
app.post(
    '/api/register/initiate',
    payLimiter,
    registrationIpDailyCap,
    registerAdmissionGate,
    handleRegisterInitiate,
);

app.get('/api/sponsor-invite/:invite_id', async (req, res) => {
    const inviteId = String(req.params.invite_id || '');
    if (!/^SINV-[0-9a-f]{24}$/i.test(inviteId)) {
        return res.status(400).json({ error: 'INVALID_INVITE_ID' });
    }
    try {
        const status = await sponsorInvite.getPublicStatus(pool, inviteId);
        if (status.error) return res.status(404).json({ error: status.error });
        return res.json(status);
    } catch (e) {
        logger.error({ err: e.message }, 'sponsor-invite status FAIL');
        return res.status(500).json({ error: 'SPONSOR_INVITE_STATUS_FAILED' });
    }
});

async function lookupInvoicePaymentForStatus(invoiceId) {
    if (alby.isConnected()) {
        try {
            const status = await alby.lookupInvoice({ paymentHash: invoiceId });
            const normalized = status.settled ? 'PAID' : (status.state === 'expired' ? 'EXPIRED' : 'WAITING');
            return { status: normalized, source: 'alby', albyState: status.state };
        } catch (_) { /* BTCPay fallback */ }
    }
    try {
        const r = await axios.get(
            `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices/${invoiceId}`,
            { headers: { Authorization: `token ${cfg.BTCPAY_API_KEY}` }, timeout: 5000, proxy: false }
        );
        const s = (r.data.status || '').toLowerCase();
        const normalized = (s === 'settled' || s === 'complete' || s === 'completed') ? 'PAID'
            : s === 'processing' ? 'PROCESSING'
            : (s === 'expired' || s === 'invalid') ? 'EXPIRED'
            : 'WAITING';
        return { status: normalized, source: 'btcpay', btcpayStatus: r.data.status };
    } catch (_) {
        return null;
    }
}

app.get('/api/v1/register/status', async (req, res) => {
    const registrationId = req.query.registration_id;
    if (!registrationId || typeof registrationId !== 'string') {
        return res.status(400).json({ error: 'REGISTRATION_ID_REQUIRED' });
    }
    try {
        const result = await registerStatus.getRegistrationStatus(pool, registrationId.trim(), {
            lookupPayment: lookupInvoicePaymentForStatus,
        });
        return res.status(result.httpStatus).json(result.body);
    } catch (e) {
        logger.error({ err: e.message, registration_id: registrationId }, 'GET /api/v1/register/status FAIL');
        return res.status(500).json({ error: 'STATUS_LOOKUP_FAILED' });
    }
});

// ----------------------------------------------------------------------------
// 10) GET cert by kya_id (vráti aktuálny platný certifikát)
// ----------------------------------------------------------------------------
app.get('/api/cert/:kya_id', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        return res.status(400).json({ error: 'INVALID_KYA_ID' });
    }
    try {
        const r = await pool.query(
            `SELECT cert_body, serial, issued_at, valid_until, revoked_at, revoke_reason
             FROM certificates
             WHERE kya_id = $1 AND is_current = TRUE
             ORDER BY issued_at DESC
             LIMIT 1`,
            [kya_id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'CERT_NOT_FOUND' });
        const row = r.rows[0];
        if (row.revoked_at) {
            return res.status(410).json({
                error: 'CERT_REVOKED',
                serial: row.serial,
                revoked_at: row.revoked_at,
                reason: row.revoke_reason,
            });
        }
        // cert_body je už uložený so signature (proof)
        return res.json({
            certificate: row.cert_body,
            serial: row.serial,
            issued_at: row.issued_at,
            valid_until: row.valid_until,
            hub_pubkey: hubkeys.getPublicInfo().pubkey_hex,
        });
    } catch (err) {
        logger.error({ err: err.message, kya_id }, 'cert fetch FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 11) Cert status (revocation check — endpoint refencovaný v credentialStatus)
// ----------------------------------------------------------------------------
app.get('/api/cert/:kya_id/status', async (req, res) => {
    const kya_id = req.params.kya_id;
    try {
        // Phase 2.3: skontroluj retired_at agentových
        const ag = await pool.query(
            `SELECT a.retired_at, a.retire_reason, a.status AS agent_status,
                    c.serial, c.valid_until, c.revoked_at, c.revoke_reason
             FROM agents a
             LEFT JOIN certificates c ON c.kya_id = a.kya_id AND c.is_current = TRUE
             WHERE a.kya_id = $1`,
            [kya_id]
        );
        if (ag.rowCount === 0) return res.status(404).json({ status: 'UNKNOWN' });
        const row = ag.rows[0];
        
        if (row.retired_at) {
            return res.status(410).json({
                status: 'RETIRED',
                serial: row.serial,
                retired_at: row.retired_at,
                retire_reason: row.retire_reason,
                message: 'Agent voluntarily retired by owner. Certificate revoked permanently.',
            });
        }
        if (!row.serial) return res.status(404).json({ status: 'UNKNOWN' });
        
        const expired = row.valid_until && new Date(row.valid_until) < new Date();
        const status = row.revoked_at ? 'REVOKED' : (expired ? 'EXPIRED' : 'ACTIVE');
        res.json({
            status, serial: row.serial,
            valid_until: row.valid_until,
            revoked_at: row.revoked_at, revoke_reason: row.revoke_reason,
        });
    } catch (err) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 10b–10c) Platform integrator routes (lib/routes/platform-integrator-routes.js)
// ----------------------------------------------------------------------------
platformIntegratorRoutes.register(app, {
    pool,
    cfg,
    axios,
    logger,
    platformIntegrator,
    integratorLsat,
    integratorSandbox,
    developerApiAuth,
    integratorReadLimiter,
});

app.get('/api/protocol/economics', async (req, res) => {
    try {
        const doc = await protocolEconomics.buildEconomicsDoc(pool);
        res.set('Cache-Control', 'public, max-age=600');
        return res.json(doc);
    } catch (err) {
        logger.error({ err: err.message }, 'GET /api/protocol/economics FAIL');
        return res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.get('/api/protocol/public-metrics', async (req, res) => {
    try {
        const doc = await protocolPublicMetrics.buildPublicMetrics(pool, {
            hubVersion: HUB_RELEASE_VERSION,
            hubPhase: HUB_RELEASE_PHASE,
        });
        res.set('Cache-Control', 'public, max-age=300');
        return res.json(doc);
    } catch (err) {
        logger.error({ err: err.message }, 'GET /api/protocol/public-metrics FAIL');
        return res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 11.5) Agent reputation info (verejné — pre dashboardy aj samotného bota)
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/reputation', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (integratorSandbox.isSandboxKyaId(kya_id)) {
        const out = integratorSandbox.agentBody(kya_id);
        if (out.error) return res.status(out.status).json({ error: out.error });
        return res.json({
            kya_id,
            agent_name: out.body.agent_name,
            reputation: out.body.reputation,
            liveness: out.body.liveness,
            _sandbox: true,
        });
    }
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        return res.status(400).json({ error: 'INVALID_KYA_ID' });
    }
    try {
        const r = await pool.query(
            `SELECT kya_id, agent_name, tier, conduct_grade, reputation_score,
                    violations_count, total_slashed, is_active, status,
                    manufacturer_id, manufacturer_verified,
                    valid_until, last_heartbeat_at, heartbeat_count, is_dormant,
                    last_score_change_at, suspended_at
             FROM agents WHERE kya_id = $1`,
            [kya_id]
        );
        if (r.rowCount === 0) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        const a = r.rows[0];
        const repInfo = reputation.describe(a.reputation_score);
        
        // Liveness compute
        let daysSinceHeartbeat = null;
        let livenessStatus = 'NEVER_SEEN';
        if (a.last_heartbeat_at) {
            daysSinceHeartbeat = Math.floor((Date.now() - new Date(a.last_heartbeat_at).getTime()) / (24 * 3600 * 1000));
            if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.warnAfterDays) livenessStatus = 'ACTIVE';
            else if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.heavyAfterDays) livenessStatus = 'WARNING_DECAY';
            else if (daysSinceHeartbeat < reputation.INACTIVITY_DECAY.dormantAfterDays) livenessStatus = 'HEAVY_DECAY';
            else livenessStatus = 'DORMANT';
        }
        
        res.json({
            kya_id: a.kya_id,
            agent_name: a.agent_name,
            tier: a.tier,
            grade: a.conduct_grade,
            status: a.status,
            is_active: a.is_active,
            reputation: repInfo,
            liveness: {
                last_heartbeat_at: a.last_heartbeat_at,
                heartbeat_count: a.heartbeat_count || 0,
                days_since_heartbeat: daysSinceHeartbeat,
                is_dormant: !!a.is_dormant,
                status: livenessStatus,
                decay_schedule: reputation.INACTIVITY_DECAY,
            },
            history: {
                violations_count: a.violations_count || 0,
                total_slashed: a.total_slashed || 0,
                last_score_change_at: a.last_score_change_at,
                suspended_at: a.suspended_at,
            },
            manufacturer: {
                id: a.manufacturer_id,
                verified: !!a.manufacturer_verified,
            },
            tier_baseline: {
                starting_score: reputation.STARTING_SCORE[a.tier] || null,
                max_score: reputation.MAX_SCORE,
            },
            valid_until: a.valid_until,
        });
    } catch (err) {
        logger.error({ err: err.message, kya_id }, 'reputation fetch FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 11.6) Reputation model info — verejné metadáta (pre transparency)
// ----------------------------------------------------------------------------
app.get('/api/protocol/reputation-model', (req, res) => {
    res.json({
        min_score: reputation.MIN_SCORE,
        max_score: reputation.MAX_SCORE,
        starting_score: reputation.STARTING_SCORE,
        max_manufacturer_bonus: reputation.MAX_MANUFACTURER_BONUS,
        zones: reputation.ZONES.map(z => ({
            name: z.name,
            min: z.min,
            max: z.max,
            label: z.label,
            operational: z.allowsOperations,
        })),
        slashing_events: reputation.SLASHING,
    });
});

// ----------------------------------------------------------------------------
// 12) Verify cert (POST body: { certificate })
// ----------------------------------------------------------------------------
app.post('/api/cert/verify', async (req, res) => {
    const { certificate } = req.body || {};
    if (!certificate || typeof certificate !== 'object') {
        return res.status(400).json({ error: 'MISSING_CERTIFICATE' });
    }
    
    // 1) Kryptografická validácia (offline) — toto je nutná, ale nie postačujúca podmienka
    const cryptoResult = certs.verifyCertSignature(certificate);
    if (!cryptoResult.valid) {
        return res.json({
            valid: false,
            reason: cryptoResult.reason,
            crypto_valid: false,
        });
    }
    
    // Expirácia certifikátu (vyhodnotené z cert.expirationDate)
    if (cryptoResult.expired) {
        return res.json({
            valid: false,
            reason: 'CERT_EXPIRED',
            crypto_valid: true,
            expired: true,
            issuer_pubkey: cryptoResult.issuerPubkey,
        });
    }
    
    // 2) Online check: revocation, currentness, agent status
    const kya_id = certificate.credentialSubject && certificate.credentialSubject.kya_id;
    const serial = certificate.id ? certificate.id.replace('urn:kya:cert:', '') : null;
    
    let onlineStatus = null;
    let agentStatus = null;
    let revokedRuntime = false;
    let reasonOverride = null;
    
    if (kya_id && serial) {
        try {
            // Skontroluj cert v DB (revocation)
            const r = await pool.query(
                `SELECT serial, is_current, revoked_at, revoke_reason FROM certificates
                 WHERE kya_id = $1 AND serial = $2`,
                [kya_id, serial]
            );
            if (r.rowCount === 0) {
                onlineStatus = { found: false };
                reasonOverride = 'CERT_NOT_FOUND_IN_DB';
            } else {
                onlineStatus = {
                    found: true,
                    is_current: r.rows[0].is_current,
                    revoked: !!r.rows[0].revoked_at,
                    revoke_reason: r.rows[0].revoke_reason,
                };
                if (r.rows[0].revoked_at) {
                    revokedRuntime = true;
                    reasonOverride = 'CERT_REVOKED';
                }
                if (!r.rows[0].is_current && !r.rows[0].revoked_at) {
                    reasonOverride = 'CERT_SUPERSEDED';
                }
            }
            
            // Skontroluj agenta — reputation zone (SUSPENDED → cert automaticky neplatí)
            const a = await pool.query(
                `SELECT reputation_score, status, is_active FROM agents WHERE kya_id = $1`,
                [kya_id]
            );
            if (a.rowCount > 0) {
                const score = a.rows[0].reputation_score || 0;
                const zone = reputation.describe(score);
                agentStatus = {
                    status: a.rows[0].status,
                    is_active: a.rows[0].is_active,
                    reputation_score: score,
                    reputation_zone: zone.zone,
                    operational: zone.operational,
                };
                // SUSPENDED zóna → cert prakticky neplatí (aj keď by ešte neboli explicit revoked)
                if (zone.zone === 'SUSPENDED' || !zone.operational) {
                    revokedRuntime = true;
                    reasonOverride = reasonOverride || 'AGENT_SUSPENDED';
                }
                if (a.rows[0].status === 'SUSPENDED' || a.rows[0].is_active === false) {
                    revokedRuntime = true;
                    reasonOverride = reasonOverride || 'AGENT_INACTIVE';
                }
            }
        } catch (e) {
            logger.error({ err: e.message, route: 'cert/verify' }, 'online check FAIL');
        }
    }
    
    // Konečný verdikt: cert je VALID iba ak prešiel CRYPTO + nie je revoked + agent nie je SUSPENDED
    const finalValid = cryptoResult.valid && !cryptoResult.expired && !revokedRuntime;
    
    res.json({
        valid: finalValid,
        reason: finalValid ? 'OK' : (reasonOverride || 'UNKNOWN'),
        crypto_valid: cryptoResult.valid,
        expired: cryptoResult.expired,
        issuer_pubkey: cryptoResult.issuerPubkey,
        issuer_trusted: cryptoResult.issuerPubkey === hubkeys.getPublicInfo().pubkey_hex,
        online_status: onlineStatus,
        agent_status: agentStatus,
        kya_id,
        serial,
    });
});


// ============================================================================
// PHASE 2 — Reputation Tracking endpoints
// ============================================================================

// Admin bypass helper pre rate limiters (X-Admin-Key v hlavičke → skip)
function _adminBypass(req) {
    const k = req.headers['x-admin-key'];
    const e = process.env.ADMIN_API_KEY;
    if (!k || !e || typeof k !== 'string') return false;
    try {
        const a = Buffer.from(k), b = Buffer.from(e);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

/**
 * Helper: zaznamenaj rejection do abuse trackera + vráti chybovú odpoveď.
 * Použitie: `return await rejectAndLog(req, res, 400, 'INVALID_TIER', { kya_id });`
 */
async function rejectAndLog(req, res, status, errorCode, extra = {}) {
    const body = { error: errorCode, ...(extra.body || {}) };
    if (extra.message) body.message = extra.message;
    
    // Fire-and-forget (nečakáme aby sme nezdržali odpoveď)
    abuseTracker.recordRejection(pool, {
        path: req.path,
        method: req.method,
        reason: errorCode,
        http_status: status,
        kya_id: extra.kya_id || req.params?.kya_id || null,
        client_ip: req.ip,
        user_agent: req.headers['user-agent'],
        error_detail: extra.detail || extra.message,
        metadata: extra.metadata,
    }).catch(() => {});
    
    return res.status(status).json(body);
}

// IP-based rate limiter (broad, anti-DoS — beží PRED zone limiterom)
const phase2Limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED' },
    skip: _adminBypass,
});

// Zone-based rate limiter (per-agent, podľa reputation zóny)
// SUSPENDED=blok, PROBATION=1/min, NEUTRAL=30/min, TRUSTED=60/min, ELITE_TIER=120/min
const zoneLimitAction = zoneRateLimiter.buildMiddleware({
    poolGetter: () => pool,
    kind: 'action',
});
const zoneLimitHeartbeat = zoneRateLimiter.buildMiddleware({
    poolGetter: () => pool,
    kind: 'heartbeat',
});
const zoneLimitEliteListing = zoneRateLimiter.buildMiddleware({
    poolGetter: () => pool,
    kind: 'elite_listing',
});
const zoneLimitReport = zoneRateLimiter.buildMiddleware({
    poolGetter: () => pool,
    kind: 'report',
    allowMissingAgent: true, // /report sa pýta na cudzieho agenta, kya_id v URL je TARGET
});

/**
 * Helper: nájde agenta podľa kya_id a vráti { row, error_response }.
 */
async function findAgent(kya_id) {
    const r = await pool.query(
        `SELECT id, kya_id, agent_name, agent_pubkey, status, reputation_score, is_active, tier
         FROM agents WHERE kya_id = $1`,
        [kya_id]
    );
    if (r.rowCount === 0) return { row: null, status: 404, error: 'AGENT_NOT_FOUND' };
    return { row: r.rows[0] };
}

app.post('/api/v1/integrator/key-request', phase2Limiter, async (req, res) => {
    const v = integratorKeyRequests.validateSubmit(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
        const recent = await integratorKeyRequests.countRecentByIp(pool, req.ip);
        if (recent >= integratorKeyRequests.MAX_PENDING_PER_IP_24H) {
            return res.status(429).json({
                error: 'RATE_LIMITED',
                message: 'Max integrator key requests per IP per 24h exceeded',
            });
        }
        const row = await integratorKeyRequests.submit(pool, {
            ...v.data,
            client_ip: req.ip,
        });
        notifications.notifyIntegratorKeyRequest({
            request_id: row.id,
            organization: v.data.organization,
            contact_email: v.data.contact_email,
            use_case: v.data.use_case,
            website: v.data.website,
            client_ip: req.ip,
        }).catch(() => {});
        return res.status(201).json({
            ok: true,
            request_id: row.id,
            status: row.status,
            message: 'Request received. Operator will review (Telegram alert) and contact you with your umb_live_… key.',
        });
    } catch (err) {
        logger.error({ err: err.message }, 'integrator key-request FAIL');
        return res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// Sponsor invite — ELITE anchored agents invite others (PoW bypass only)
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/sponsor-invite', phase2Limiter, async (req, res) => {
    const log = logger.child({ route: 'agent/sponsor-invite' });
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        return res.status(400).json({ error: 'INVALID_KYA_ID' });
    }
    const {
        invitee_pubkey, tier_requested, expected_agent_name, ttl_hours,
        nonce, timestamp, signature,
    } = req.body || {};
    if (!invitee_pubkey || !tier_requested || !signature || !nonce || !timestamp) {
        return res.status(400).json({
            error: 'MISSING_FIELDS',
            required: ['invitee_pubkey', 'tier_requested', 'nonce', 'timestamp', 'signature'],
        });
    }
    if (!/^[0-9a-fA-F]{128}$/.test(signature)) {
        return res.status(400).json({ error: 'INVALID_SIGNATURE_FORMAT' });
    }
    if (!/^[0-9a-fA-F]{16,64}$/.test(nonce)) {
        return res.status(400).json({ error: 'INVALID_NONCE_FORMAT' });
    }
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW', skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }

    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const agent = af.row;
    if (!agent.agent_pubkey) {
        return res.status(400).json({ error: 'AGENT_NO_PUBKEY' });
    }
    if (agent.status === 'SUSPENDED' || !agent.is_active) {
        return res.status(403).json({ error: 'AGENT_SUSPENDED' });
    }

    const signBody = {
        nonce,
        timestamp,
        invitee_pubkey: String(invitee_pubkey).toLowerCase(),
        tier_requested,
        expected_agent_name: expected_agent_name || null,
        ttl_hours: ttl_hours != null ? ttl_hours : undefined,
    };
    if (!sponsorInvite.verifySponsorActionSignature(agent.agent_pubkey, signature, signBody)) {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'BAD_SIGNATURE',
            http_status: 401, kya_id, client_ip: req.ip, user_agent: req.headers['user-agent'],
        }).catch(() => {});
        return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }

    try {
        const result = await sponsorInvite.createAgentInvite(pool, {
            sponsorKyaId: kya_id,
            inviteePubkey: signBody.invitee_pubkey,
            tierRequested: signBody.tier_requested,
            expectedAgentName: expected_agent_name || null,
            ttlHours: ttl_hours,
            clientIp: req.ip,
        });
        if (!result.ok) {
            const status = result.status || 400;
            return res.status(status).json({
                error: result.error,
                ...(result.min != null ? { min_reputation: result.min } : {}),
                ...(result.limit != null ? { limit: result.limit } : {}),
                ...(result.until ? { suspended_until: result.until } : {}),
            });
        }
        log.info({
            event: 'sponsor_invite_issued',
            sponsor_kya_id: kya_id,
            invite_id: result.invite_id,
            tier: result.tier_requested,
        }, 'sponsor_invite_issued');
        return res.status(result.status).json(result);
    } catch (e) {
        log.error({ err: e.message }, 'sponsor-invite create FAIL');
        return res.status(500).json({ error: 'SPONSOR_INVITE_FAILED' });
    }
});

// ----------------------------------------------------------------------------
// 13) POST /api/agent/:kya_id/action — bot self-report (signed)
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/action', phase2Limiter, zoneLimitAction, async (req, res) => {
    const log = logger.child({ route: 'agent/action' });
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    
    const { action_type, target, context, evidence_hash, signature, nonce, timestamp } = req.body || {};
    
    if (!action_type || !signature || !nonce) {
        return res.status(400).json({ error: 'MISSING_FIELDS', required: ['action_type', 'signature', 'nonce'] });
    }
    if (!/^[0-9a-fA-F]{128}$/.test(signature)) return res.status(400).json({ error: 'INVALID_SIGNATURE_FORMAT' });
    if (!/^[0-9a-fA-F]{16,64}$/.test(nonce)) return res.status(400).json({ error: 'INVALID_NONCE_FORMAT' });
    
    const rule = reputation.SELF_ACTION_RULES[action_type];
    if (!rule) {
        return res.status(400).json({
            error: 'UNKNOWN_ACTION_TYPE',
            allowed: Object.keys(reputation.SELF_ACTION_RULES),
        });
    }
    
    // Timestamp tolerancia (Phase 2.4: konfigurovateľná)
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW', skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }
    
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const agent = af.row;
    
    if (!agent.agent_pubkey) return res.status(400).json({ error: 'AGENT_NO_PUBKEY', message: 'agent nemá uložený pubkey' });
    if (agent.status === 'SUSPENDED' || !agent.is_active) return res.status(403).json({ error: 'AGENT_SUSPENDED' });
    
    // Verify signature nad canonical telom (action_type|target|context|evidence_hash|nonce|timestamp)
    const signedPayload = JSON.stringify({
        action_type, target: target || null, context: context || null,
        evidence_hash: evidence_hash || null, nonce, timestamp,
    });
    const digest = crypto.createHash('sha256').update(signedPayload).digest();
    if (!hubkeys.verify(digest, signature, agent.agent_pubkey)) {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'BAD_SIGNATURE',
            http_status: 401, kya_id, client_ip: req.ip, user_agent: req.headers['user-agent'],
            error_detail: 'action signature verification failed',
        }).catch(() => {});
        abuseTracker.recordSignatureFailure(pool, {
            kya_id, client_ip: req.ip, endpoint: 'action', failure_type: 'BAD_SIGNATURE', logger,
        }).catch(() => {});
        return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }
    
    // Pre ELITE: pozitívne actions vyžadujú evidence_hash ak rule.requiresProofForElite
    let willApplyDelta = rule.delta;
    let willApplyReason = `self: ${action_type}`;
    
    if (agent.tier === 'ELITE' && rule.delta > 0 && rule.requiresProofForElite && !evidence_hash) {
        // Logujeme ale neaplikujeme delta
        willApplyDelta = 0;
        willApplyReason = `self: ${action_type} (no proof, logged only)`;
    }
    
    // Idempotency + transakčná aplikácia
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Replay: ON CONFLICT = žiadny failed statement → nezvýši PostgreSQL xact_rollback
        const ar = await client.query(
            `INSERT INTO action_log (
                agent_id, kya_id, action_type, target, context, evidence_hash,
                signature, nonce, score_delta, bot_timestamp
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (kya_id, nonce) DO NOTHING
            RETURNING id`,
            [
                agent.id, kya_id, action_type, target || null,
                context ? JSON.stringify(context) : null, evidence_hash || null,
                signature, nonce, 0, new Date(tsMs)
            ]
        );
        if (ar.rowCount === 0) {
            await client.query('COMMIT');
            abuseTracker.recordRejection(pool, {
                path: req.path, method: req.method, reason: 'REPLAY',
                http_status: 409, kya_id, client_ip: req.ip, user_agent: req.headers['user-agent'],
                error_detail: 'nonce already used in action_log',
            }).catch(() => {});
            return res.status(409).json({ error: 'REPLAY', message: 'nonce už použitý' });
        }
        const actionId = ar.rows[0].id;
        
        // Rate limit (only pre pozitívne actions)
        let rateInfo = { allowed: true };
        if (willApplyDelta > 0) {
            rateInfo = await repEngine.checkSelfActionRateLimit(client, { agent_id: agent.id, action_type });
            if (!rateInfo.allowed) {
                // Stále zapíšeme action_log ale s flag-om rate_limited
                await client.query(
                    `UPDATE action_log SET rate_limited = TRUE, rejected_reason = $1, score_delta = 0 WHERE id = $2`,
                    [rateInfo.reason, actionId]
                );
                await client.query('COMMIT');
                return res.json({
                    accepted: true,
                    action_id: actionId,
                    score_delta: 0,
                    rate_limited: true,
                    reason: rateInfo.reason,
                    counters: rateInfo.counters,
                });
            }
        }
        
        // Aplikuj event
        let eventResult = null;
        if (willApplyDelta !== 0) {
            eventResult = await repEngine.applyEvent(client, {
                agent_id: agent.id, kya_id,
                event_type: action_type,
                source: 'self',
                delta: willApplyDelta,
                reason: willApplyReason,
                evidence: { actionId, evidence_hash, target, context },
                related_action_id: actionId,
                client_ip: req.ip,
                user_agent: req.headers['user-agent'] || null,
            });
            await client.query(
                `UPDATE action_log SET score_delta = $1 WHERE id = $2`,
                [eventResult.delta, actionId]
            );
        }
        
        await client.query('COMMIT');
        if (eventResult) {
            const zoneChanged = eventResult.oldZone !== eventResult.newZone;
            if (eventResult.delta !== 0 || zoneChanged) {
                developerWebhooks.emit(pool, {
                    event: 'reputation.changed',
                    kya_id,
                    payload: {
                        event_id: eventResult.eventId,
                        delta: eventResult.delta,
                        old_score: eventResult.oldScore,
                        new_score: eventResult.newScore,
                        old_zone: eventResult.oldZone,
                        new_zone: eventResult.newZone,
                        action_type,
                    },
                }).catch(() => {});
            }
            const revoked = (eventResult.sideEffects || []).some((s) => s.type === 'CERT_REVOKED');
            if (revoked) {
                developerWebhooks.emit(pool, {
                    event: 'cert.revoked',
                    kya_id,
                    payload: { side_effects: eventResult.sideEffects },
                }).catch(() => {});
            }
        }
        log.info({ kya_id, action_type, delta: eventResult?.delta || 0, actionId }, 'self-action recorded');
        
        return res.json({
            accepted: true,
            action_id: actionId,
            applied: !!eventResult,
            event: eventResult ? {
                event_id: eventResult.eventId,
                delta: eventResult.delta,
                new_score: eventResult.newScore,
                new_zone: eventResult.newZone,
                side_effects: eventResult.sideEffects,
            } : null,
            note: willApplyDelta === 0 && rule.delta > 0 ? 'logged only — proof required for ELITE' : undefined,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        log.error({ err: e.message, stack: (e.stack || '').slice(0, 500) }, 'action handler error');
        return res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});


// ----------------------------------------------------------------------------
// 14) POST /api/agent/:kya_id/heartbeat — liveness ping (signed)
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/heartbeat', phase2Limiter, zoneLimitHeartbeat, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return rejectAndLog(req, res, 400, 'INVALID_KYA_ID', { kya_id });
    
    const { signature, nonce, timestamp } = req.body || {};
    if (!signature || !nonce || !timestamp) {
        return rejectAndLog(req, res, 400, 'MISSING_FIELDS', {
            kya_id, body: { required: ['signature', 'nonce', 'timestamp'] },
        });
    }
    
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        abuseTracker.recordSignatureFailure(pool, {
            kya_id, client_ip: req.ip, endpoint: 'heartbeat', failure_type: 'BAD_TIMESTAMP', logger,
        }).catch(() => {});
        return rejectAndLog(req, res, 400, 'MANIFEST_TIMESTAMP_SKEW', { kya_id, skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }
    
    if (!/^[0-9a-fA-F]{16,64}$/.test(nonce)) return rejectAndLog(req, res, 400, 'INVALID_NONCE_FORMAT', { kya_id });
    
    const af = await findAgent(kya_id);
    if (af.error) return rejectAndLog(req, res, af.status, af.error, { kya_id });
    const agent = af.row;
    if (!agent.agent_pubkey) return rejectAndLog(req, res, 400, 'AGENT_NO_PUBKEY', { kya_id });
    if (agent.status === 'SUSPENDED') return rejectAndLog(req, res, 403, 'AGENT_SUSPENDED', { kya_id });
    if (agent.status === 'RETIRED' || agent.retired_at) return rejectAndLog(req, res, 410, 'AGENT_RETIRED', { kya_id });
    
    // Signature nad kya_id|nonce|timestamp (heartbeat je jednoduchý)
    const digest = crypto.createHash('sha256')
        .update(`${kya_id}|${nonce}|${timestamp}`)
        .digest();
    if (!hubkeys.verify(digest, signature, agent.agent_pubkey)) {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'BAD_SIGNATURE',
            http_status: 401, kya_id, client_ip: req.ip, user_agent: req.headers['user-agent'],
            error_detail: 'heartbeat signature verification failed',
        }).catch(() => {});
        abuseTracker.recordSignatureFailure(pool, {
            kya_id, client_ip: req.ip, endpoint: 'heartbeat', failure_type: 'BAD_SIGNATURE', logger,
        }).catch(() => {});
        return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }
    
    // Phase 2.3: Replay protection cez heartbeats_log (UNIQUE(kya_id, nonce))
    const hbIns = await pool.query(
        `INSERT INTO heartbeats_log (agent_id, kya_id, nonce, client_ip, bot_timestamp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (kya_id, nonce) DO NOTHING
         RETURNING id`,
        [agent.id, kya_id, nonce, req.ip, new Date(tsMs)]
    );
    if (hbIns.rowCount === 0) {
        abuseTracker.recordRejection(pool, {
            path: req.path, method: req.method, reason: 'REPLAY',
            http_status: 409, kya_id, client_ip: req.ip, user_agent: req.headers['user-agent'],
            error_detail: 'heartbeat nonce already used',
        }).catch(() => {});
        return res.status(409).json({ error: 'REPLAY', message: 'nonce už použitý' });
    }
    
    await pool.query(
        `UPDATE agents
         SET last_heartbeat_at = CURRENT_TIMESTAMP,
             last_seen = CURRENT_TIMESTAMP,
             heartbeat_count = COALESCE(heartbeat_count, 0) + 1,
             is_dormant = FALSE
         WHERE id = $1`,
        [agent.id]
    );
    
    res.json({
        ok: true,
        kya_id,
        server_time: new Date().toISOString(),
        next_expected_within_days: reputation.INACTIVITY_DECAY.warnAfterDays,
    });
});


// ----------------------------------------------------------------------------
// 14b) POST /api/agent/:kya_id/delegation-pass — hub-issued short-lived pass (L402 claims + caveats)
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/delegation-pass', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { caveats, l402_claims, ttl_seconds, nonce, timestamp, signature } = req.body || {};
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW', skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }
    if (!nonce || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) {
        return res.status(400).json({ error: 'INVALID_NONCE_FORMAT' });
    }
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) {
        return res.status(400).json({ error: 'BAD_SIGNATURE_FORMAT' });
    }
    const ttl = delegationPass.clampTtl(ttl_seconds);
    const cv = delegationPass.validateCaveats(caveats);
    if (!cv.ok) return res.status(400).json({ error: cv.error });

    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const agent = af.row;
    if (!agent.agent_pubkey) return res.status(400).json({ error: 'AGENT_NO_PUBKEY' });
    if (agent.status === 'SUSPENDED' || !agent.is_active) return res.status(403).json({ error: 'AGENT_SUSPENDED' });
    if (agent.status === 'RETIRED') return res.status(410).json({ error: 'AGENT_RETIRED' });

    const digest = delegationPass.agentRequestDigest({
        kya_id,
        ttl_seconds: ttl,
        caveats,
        l402_claims: l402_claims || {},
        nonce,
        timestamp,
    });
    if (!hubkeys.verify(digest, signature, agent.agent_pubkey)) {
        abuseTracker.recordSignatureFailure(pool, {
            kya_id, client_ip: req.ip, endpoint: 'delegation-pass', failure_type: 'BAD_SIGNATURE', logger,
        }).catch(() => {});
        return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }

    const nonceIns = await pool.query(
        `INSERT INTO delegation_request_nonces (kya_id, nonce) VALUES ($1, $2)
         ON CONFLICT (kya_id, nonce) DO NOTHING`,
        [kya_id, nonce]
    );
    if (nonceIns.rowCount === 0) return res.status(409).json({ error: 'REPLAY', message: 'nonce already used' });

    const mh = await pool.query('SELECT manifest_hash FROM agents WHERE id = $1', [agent.id]);
    const manifest_hash = mh.rows[0] ? mh.rows[0].manifest_hash : null;

    let pass;
    try {
        pass = await delegationPass.issueDelegationPass({
            pool,
            kya_id,
            agent_id: agent.id,
            agent_pubkey: agent.agent_pubkey,
            manifest_hash,
            caveats,
            l402_claims: l402_claims || {},
            ttl_seconds: ttl,
            client_ip: req.ip,
        });
    } catch (e) {
        logger.error({ err: e.message, kya_id }, 'delegation-pass issue FAIL');
        return httpPublicError.send500(res, httpPublicError.clientErrorCode(e));
    }
    res.json({
        delegation_pass: pass,
        l402_profile: delegationPass.L402_PROFILE_ID,
        verify_url: '/api/delegation-pass/verify',
    });
});


// ----------------------------------------------------------------------------
// 14c) ELITE public listing liveness — status + paid heartbeat / reactivation
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/elite-listing', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    try {
        const st = await eliteListing.getPublicStatus(pool, kya_id);
        if (st.error === 'AGENT_NOT_FOUND') return res.status(404).json(st);
        if (st.error === 'NOT_ELITE') {
            return res.status(400).json(st);
        }
        res.json(st);
    } catch (e) {
        logger.error({ err: e.message, kya_id }, 'elite-listing GET FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

app.post('/api/agent/:kya_id/elite-listing/pay-invoice', phase2Limiter, zoneLimitEliteListing, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { kind, nonce, timestamp, signature } = req.body || {};
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW', skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const agent = af.row;
    if (!agent.agent_pubkey) return res.status(400).json({ error: 'AGENT_NO_PUBKEY' });
    const v = eliteListing._verifyListingSignature(agent.agent_pubkey, { kind, nonce, timestamp, signature });
    if (!v.ok) return res.status(v.error === 'BAD_SIGNATURE' ? 401 : 400).json(v);
    const out = await eliteListing.createPayInvoice(pool, {
        kya_id,
        kind: v.kind,
        alby,
        btcpayAxios: axios,
        cfg,
        logger: logger.child({ route: 'elite-listing/pay' }),
    });
    res.status(out.status).json(out.body);
});

app.post('/api/agent/:kya_id/elite-listing/redeem-free', phase2Limiter, zoneLimitEliteListing, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { nonce, timestamp, signature } = req.body || {};
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW', skew_ms_allowed: TIMESTAMP_SKEW_MS });
    }
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const agent = af.row;
    if (!agent.agent_pubkey) return res.status(400).json({ error: 'AGENT_NO_PUBKEY' });
    const v = eliteListing._verifyListingSignature(agent.agent_pubkey, {
        kind: 'redeem_free', nonce, timestamp, signature,
    }, ['redeem_free']);
    if (!v.ok) return res.status(v.error === 'BAD_SIGNATURE' ? 401 : 400).json(v);
    const hbNonce = ('RF' + String(nonce)).slice(0, 64);
    const hbRf = await pool.query(
        `INSERT INTO heartbeats_log (agent_id, kya_id, nonce, client_ip, bot_timestamp)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (kya_id, nonce) DO NOTHING
         RETURNING id`,
        [agent.id, kya_id, hbNonce, req.ip]
    );
    if (hbRf.rowCount === 0) {
        return res.status(409).json({ error: 'REPLAY', message: 'nonce already used' });
    }
    const r = await eliteListing.redeemFreeReactivation(pool, kya_id);
    if (!r.ok) {
        return res.status(402).json({
            error: 'FREE_REACTIVATION_NOT_AVAILABLE',
            message: 'Free reactivation once per calendar year when DELISTED, or pay reactivation invoice.',
            fees: eliteListing.cfgSummary(),
        });
    }
    res.json(r);
});


// ----------------------------------------------------------------------------
// 15) POST /api/agent/:kya_id/report — external report (peer alebo anonymný)
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/report', phase2Limiter, async (req, res) => {
    const log = logger.child({ route: 'agent/report' });
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    
    const { report_type, description, evidence, reporter_kya_id, reporter_pubkey, reporter_signature, report_nonce, report_timestamp } = req.body || {};
    
    const ALLOWED_TYPES = ['FRAUD', 'SPAM', 'POOR_QUALITY', 'MISCONDUCT', 'FALSE_CLAIMS', 'PROTOCOL_VIOLATION'];
    if (!ALLOWED_TYPES.includes(report_type)) {
        return res.status(400).json({ error: 'INVALID_REPORT_TYPE', allowed: ALLOWED_TYPES });
    }
    if (!description || typeof description !== 'string' || description.length < 10 || description.length > 2000) {
        return res.status(400).json({ error: 'INVALID_DESCRIPTION', message: '10-2000 chars required' });
    }
    
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    const target = af.row;
    
    // Self-report prevent
    if (reporter_kya_id === kya_id) return res.status(400).json({ error: 'CANNOT_REPORT_SELF' });
    
    // Ak má reporter_pubkey alebo reporter_kya_id → musí byť aj reporter_signature
    let isSigned = false;
    let reporter = null;
    
    if (reporter_kya_id || reporter_pubkey || reporter_signature) {
        if (!reporter_signature || !/^[0-9a-fA-F]{128}$/.test(reporter_signature)) {
            return rejectAndLog(req, res, 400, 'BAD_REPORTER_SIGNATURE', { kya_id });
        }
        if (!reporter_pubkey || !security.isValidPubkey(reporter_pubkey)) {
            return rejectAndLog(req, res, 400, 'BAD_REPORTER_PUBKEY', { kya_id });
        }
        
        // Verify signature nad sha256(target_kya | report_type | description | evidence_json [| nonce | timestamp])
        // Phase 2.3: ak je report_nonce prítomný, zahrnieme ho do canonical (replay protection).
        // Backward compat: bez nonce použijeme pôvodný (Phase 2) canonical formát.
        if (report_nonce && !/^[0-9a-fA-F]{16,64}$/.test(report_nonce)) {
            return rejectAndLog(req, res, 400, 'INVALID_REPORT_NONCE_FORMAT', { kya_id });
        }
        const payloadObj = {
            target_kya: kya_id, report_type, description,
            evidence: evidence || null,
        };
        if (report_nonce) {
            payloadObj.nonce = report_nonce;
            payloadObj.timestamp = report_timestamp || null;
        }
        const payload = JSON.stringify(payloadObj);
        const digest = crypto.createHash('sha256').update(payload).digest();
        if (!hubkeys.verify(digest, reporter_signature, reporter_pubkey)) {
            abuseTracker.recordRejection(pool, {
                path: req.path, method: req.method, reason: 'REPORTER_SIGNATURE_INVALID',
                http_status: 401, kya_id: reporter_kya_id || null,
                client_ip: req.ip, user_agent: req.headers['user-agent'],
                error_detail: `target=${kya_id} report_type=${report_type}`,
            }).catch(() => {});
            // Bad-sig counter sa pripočíta reporter-ovi (ak je registrovaný), nie target-u
            if (reporter_kya_id) {
                abuseTracker.recordSignatureFailure(pool, {
                    kya_id: reporter_kya_id, client_ip: req.ip,
                    endpoint: 'report', failure_type: 'BAD_SIGNATURE', logger,
                }).catch(() => {});
            }
            return res.status(401).json({ error: 'REPORTER_SIGNATURE_INVALID' });
        }
        isSigned = true;
        
        // Ak je reporter_kya_id → overiť že existuje a má zónu ≥ NEUTRAL
        if (reporter_kya_id) {
            const rr = await pool.query(
                `SELECT id, kya_id, reputation_score, status, agent_pubkey FROM agents WHERE kya_id = $1`,
                [reporter_kya_id]
            );
            if (rr.rowCount === 0) return rejectAndLog(req, res, 404, 'REPORTER_NOT_FOUND', { kya_id: reporter_kya_id });
            const rep = rr.rows[0];
            if (rep.agent_pubkey?.toLowerCase() !== reporter_pubkey.toLowerCase()) {
                return rejectAndLog(req, res, 401, 'REPORTER_PUBKEY_MISMATCH_DB', { kya_id: reporter_kya_id });
            }
            if (rep.status === 'SUSPENDED') return rejectAndLog(req, res, 403, 'REPORTER_SUSPENDED', { kya_id: reporter_kya_id });
            if (!reputation.zoneAtLeast(rep.reputation_score, reputation.PEER_REPORT_LIMITS.minReporterZone)) {
                return res.status(403).json({
                    error: 'REPORTER_INSUFFICIENT_REPUTATION',
                    required_zone: reputation.PEER_REPORT_LIMITS.minReporterZone,
                    current_zone: reputation.zoneOf(rep.reputation_score),
                });
            }
            reporter = rep;
        }
    }
    
    // Rate limit mimo transakcie (iba SELECT) — vyhne sa ROLLBACK metrike pri 429
    if (reporter) {
        const rl = await repEngine.checkPeerReportRateLimit(pool, {
            reporter_kya_id, target_kya_id: kya_id,
        });
        if (!rl.allowed) {
            return res.status(429).json({ error: 'RATE_LIMIT', reason: rl.reason, counters: rl.counters });
        }
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // Auto-apply pre signed peer reports v zóne ≥ NEUTRAL
        let autoApplied = false;
        let autoEvent = null;
        let status = 'PENDING_REVIEW';
        let autoDelta = null;
        
        if (reporter) {
            const SERIOUS = ['FRAUD', 'SPAM', 'PROTOCOL_VIOLATION'];
            const targetScoreAfter = (target.reputation_score || 0) + reputation.SLASHING.NEGATIVE_PEER_REVIEW;
            const wouldGoSuspended = targetScoreAfter < 200;
            
            if (SERIOUS.includes(report_type) || wouldGoSuspended) {
                // Eskaluj na admin (žiadne auto-apply pri vážnych alebo SUSPENDED prepade)
                status = 'ESCALATED';
            } else {
                // Auto-apply NEGATIVE_PEER_REVIEW
                autoDelta = reputation.SLASHING.NEGATIVE_PEER_REVIEW;
                status = 'AUTO_APPLIED';
                autoApplied = true;
            }
        }
        
        // Phase 2.4: Sybil-resistance weighting pre auto-applied NEGATIVE peer reviews.
        // Mladší / BASIC / "review-krúžok" reporteri majú znížený vplyv.
        let sybilBreakdown = null;
        if (autoApplied && autoDelta !== null && reporter_kya_id) {
            try {
                const w = await sybilResistance.computeWeightedDelta(client, {
                    base_delta: autoDelta,
                    reporter_kya_id,
                    target_kya_id: kya_id,
                });
                sybilBreakdown = w.breakdown;
                autoDelta = w.weighted_delta;
                if (w.sybilFlag) {
                    log.warn({
                        reporter_kya_id, target_kya_id: kya_id, breakdown: w.breakdown,
                    }, 'SYBIL: review-circle detected, delta heavily reduced');
                }
            } catch (e) {
                log.warn({ err: e.message }, 'sybil-resistance compute FAIL (using base delta)');
            }
        }
        
        const insertRes = await client.query(
            `INSERT INTO reports (
                target_agent_id, target_kya_id, report_type, description, evidence,
                reporter_kya_id, reporter_pubkey, reporter_signature, reporter_ip,
                status, auto_applied_delta, report_nonce, report_timestamp
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT (reporter_pubkey, report_nonce) WHERE reporter_pubkey IS NOT NULL AND report_nonce IS NOT NULL
            DO NOTHING
            RETURNING id, status`,
            [
                target.id, kya_id, report_type, description,
                evidence ? JSON.stringify(evidence) : null,
                reporter_kya_id || null, reporter_pubkey || null, reporter_signature || null, req.ip,
                status, autoDelta,
                report_nonce || null,
                report_timestamp ? new Date(report_timestamp) : null,
            ]
        );
        if (insertRes.rowCount === 0) {
            await client.query('COMMIT');
            abuseTracker.recordRejection(pool, {
                path: req.path, method: req.method, reason: 'REPORT_REPLAY',
                http_status: 409, kya_id: reporter_kya_id || null,
                client_ip: req.ip, user_agent: req.headers['user-agent'],
                error_detail: `report nonce reused by pubkey=${reporter_pubkey?.slice(0,16)}`,
            }).catch(() => {});
            return res.status(409).json({ error: 'REPLAY', message: 'report nonce už použitý' });
        }
        const reportId = insertRes.rows[0].id;
        
        if (autoApplied) {
            autoEvent = await repEngine.applyEvent(client, {
                agent_id: target.id, kya_id,
                event_type: 'NEGATIVE_PEER_REVIEW',
                source: 'peer',
                delta: autoDelta,
                reason: `Peer report #${reportId} (${report_type}) by ${reporter_kya_id}`,
                evidence: { reportId, description: description.slice(0, 200), sybil: sybilBreakdown || undefined },
                reporter_kya_id, reporter_pubkey,
                related_report_id: reportId,
                client_ip: req.ip,
            });
        }
        
        await client.query('COMMIT');
        if (autoEvent) {
            const zoneChanged = autoEvent.oldZone !== autoEvent.newZone;
            if (autoEvent.delta !== 0 || zoneChanged) {
                developerWebhooks.emit(pool, {
                    event: 'reputation.changed',
                    kya_id,
                    payload: {
                        event_id: autoEvent.eventId,
                        delta: autoEvent.delta,
                        old_score: autoEvent.oldScore,
                        new_score: autoEvent.newScore,
                        old_zone: autoEvent.oldZone,
                        new_zone: autoEvent.newZone,
                        source: 'peer_auto',
                        report_id: reportId,
                    },
                }).catch(() => {});
            }
            const revoked = (autoEvent.sideEffects || []).some((s) => s.type === 'CERT_REVOKED');
            if (revoked) {
                developerWebhooks.emit(pool, {
                    event: 'cert.revoked',
                    kya_id,
                    payload: { side_effects: autoEvent.sideEffects, report_id: reportId },
                }).catch(() => {});
            }
        }
        log.info({ kya_id, report_type, status, autoApplied, reportId, sybil: sybilBreakdown }, 'report recorded');
        
        return res.json({
            report_id: reportId,
            status,
            signed: isSigned,
            auto_applied: autoApplied,
            sybil_weighting: sybilBreakdown || null,
            event: autoEvent ? {
                event_id: autoEvent.eventId,
                delta: autoEvent.delta,
                new_score: autoEvent.newScore,
                new_zone: autoEvent.newZone,
            } : null,
            message: status === 'PENDING_REVIEW' ? 'Report čaká na admin review (anonymný report alebo bez podpisu).'
                   : status === 'ESCALATED' ? 'Vážny report eskalovaný na admin review.'
                   : 'Negative peer review aplikovaný.',
        });
    } catch (e) {
        await client.query('ROLLBACK');
        log.error({ err: e.message }, 'report handler error');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});


// ----------------------------------------------------------------------------
// 16) GET /api/agent/:kya_id/events — reputation event history
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/events', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    
    try {
        const r = await pool.query(
            `SELECT id, event_type, source, delta, score_before, score_after, zone_before, zone_after,
                    reason, evidence, reporter_kya_id, admin_user, occurred_at
             FROM reputation_events WHERE kya_id = $1
             ORDER BY occurred_at DESC LIMIT $2 OFFSET $3`,
            [kya_id, limit, offset]
        );
        const total = await pool.query(`SELECT COUNT(*) AS n FROM reputation_events WHERE kya_id = $1`, [kya_id]);
        res.json({
            kya_id, count: r.rowCount, total: parseInt(total.rows[0].n, 10),
            offset, limit, events: r.rows,
        });
    } catch (e) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});


// ----------------------------------------------------------------------------
// 17) Admin: manual slashing / restore
// ----------------------------------------------------------------------------
app.post('/api/admin/agent/:kya_id/slash', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { event_type, delta, reason } = req.body || {};
    if (!event_type) return res.status(400).json({ error: 'MISSING_EVENT_TYPE' });
    
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await repEngine.applyEvent(client, {
            agent_id: af.row.id, kya_id,
            event_type,
            source: 'admin',
            delta: (delta !== undefined) ? parseInt(delta, 10) : reputation.SLASHING[event_type],
            reason: reason || `Admin manual slash: ${event_type}`,
            admin_user: req.headers['x-admin-user'] || 'admin',
            client_ip: req.ip,
        });
        await client.query('COMMIT');
        if (result) {
            const zoneChanged = result.oldZone !== result.newZone;
            if (result.delta !== 0 || zoneChanged) {
                developerWebhooks.emit(pool, {
                    event: 'reputation.changed',
                    kya_id,
                    payload: {
                        event_id: result.eventId,
                        delta: result.delta,
                        old_score: result.oldScore,
                        new_score: result.newScore,
                        old_zone: result.oldZone,
                        new_zone: result.newZone,
                        source: 'admin',
                        event_type,
                    },
                }).catch(() => {});
            }
            const revoked = (result.sideEffects || []).some((s) => s.type === 'CERT_REVOKED');
            if (revoked) {
                developerWebhooks.emit(pool, {
                    event: 'cert.revoked',
                    kya_id,
                    payload: { side_effects: result.sideEffects },
                }).catch(() => {});
            }
        }
        res.json(result);
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ err: e.message, kya_id }, 'admin slash FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/agent/:kya_id/restore', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { delta, reason } = req.body || {};
    
    const af = await findAgent(kya_id);
    if (af.error) return res.status(af.status).json({ error: af.error });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await repEngine.applyEvent(client, {
            agent_id: af.row.id, kya_id,
            event_type: 'ADMIN_RESTORE',
            source: 'admin',
            delta: (delta !== undefined) ? Math.abs(parseInt(delta, 10)) : reputation.SLASHING.ADMIN_RESTORE,
            reason: reason || 'Admin restore',
            admin_user: req.headers['x-admin-user'] || 'admin',
            client_ip: req.ip,
        });
        await client.query('COMMIT');
        if (result) {
            const zoneChanged = result.oldZone !== result.newZone;
            if (result.delta !== 0 || zoneChanged) {
                developerWebhooks.emit(pool, {
                    event: 'reputation.changed',
                    kya_id,
                    payload: {
                        event_id: result.eventId,
                        delta: result.delta,
                        old_score: result.oldScore,
                        new_score: result.newScore,
                        old_zone: result.oldZone,
                        new_zone: result.newZone,
                        source: 'admin',
                        event_type: 'ADMIN_RESTORE',
                    },
                }).catch(() => {});
            }
        }
        res.json(result);
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ err: e.message, kya_id }, 'admin restore FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/reports/:id/resolve', security.adminAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { resolution, delta, note } = req.body || {};
    const ALLOWED_RES = ['VALID', 'INVALID', 'INSUFFICIENT_EVIDENCE', 'OUT_OF_SCOPE'];
    if (!ALLOWED_RES.includes(resolution)) return res.status(400).json({ error: 'INVALID_RESOLUTION', allowed: ALLOWED_RES });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const rr = await client.query(`SELECT * FROM reports WHERE id = $1 FOR UPDATE`, [id]);
        if (rr.rowCount === 0) { await client.query('COMMIT'); return res.status(404).json({ error: 'REPORT_NOT_FOUND' }); }
        const rep = rr.rows[0];
        if (rep.status !== 'PENDING_REVIEW' && rep.status !== 'ESCALATED') {
            await client.query('COMMIT');
            return res.status(409).json({ error: 'ALREADY_RESOLVED', status: rep.status });
        }
        
        let appliedEvent = null;
        let appliedDelta = null;
        
        if (resolution === 'VALID') {
            const eventType = rep.report_type === 'FRAUD' ? 'FRAUD_PROVEN'
                            : rep.report_type === 'SPAM' ? 'SPAM_REPORT'
                            : rep.report_type === 'PROTOCOL_VIOLATION' ? 'PROTOCOL_VIOLATION'
                            : 'NEGATIVE_PEER_REVIEW';
            appliedDelta = (delta !== undefined) ? parseInt(delta, 10) : reputation.SLASHING[eventType];
            appliedEvent = await repEngine.applyEvent(client, {
                agent_id: rep.target_agent_id, kya_id: rep.target_kya_id,
                event_type: eventType,
                source: 'admin',
                delta: appliedDelta,
                reason: `Admin resolved report #${id} as VALID (${rep.report_type})`,
                evidence: { reportId: id, originalReport: rep.report_type, note: note || null },
                related_report_id: id,
                admin_user: req.headers['x-admin-user'] || 'admin',
                client_ip: req.ip,
            });
        }
        
        await client.query(
            `UPDATE reports SET status = 'RESOLVED', resolution = $1, resolution_delta = $2,
                                resolution_note = $3, resolved_by = $4, resolved_at = CURRENT_TIMESTAMP
             WHERE id = $5`,
            [resolution, appliedDelta, note || null, req.headers['x-admin-user'] || 'admin', id]
        );
        
        await client.query('COMMIT');
        if (appliedEvent) {
            const zoneChanged = appliedEvent.oldZone !== appliedEvent.newZone;
            if (appliedEvent.delta !== 0 || zoneChanged) {
                developerWebhooks.emit(pool, {
                    event: 'reputation.changed',
                    kya_id: rep.target_kya_id,
                    payload: {
                        event_id: appliedEvent.eventId,
                        delta: appliedEvent.delta,
                        old_score: appliedEvent.oldScore,
                        new_score: appliedEvent.newScore,
                        old_zone: appliedEvent.oldZone,
                        new_zone: appliedEvent.newZone,
                        source: 'admin_report_resolve',
                        report_id: id,
                    },
                }).catch(() => {});
            }
            const revoked = (appliedEvent.sideEffects || []).some((s) => s.type === 'CERT_REVOKED');
            if (revoked) {
                developerWebhooks.emit(pool, {
                    event: 'cert.revoked',
                    kya_id: rep.target_kya_id,
                    payload: { side_effects: appliedEvent.sideEffects, report_id: id },
                }).catch(() => {});
            }
        }
        res.json({ report_id: id, resolution, event: appliedEvent });
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ err: e.message, report_id: id }, 'admin resolve report FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});

// Admin: manuálny run decay worker-a (pre testy / debug)
app.post('/api/admin/run-decay', security.adminAuth, async (req, res) => {
    try {
        const stats = await decayWorker.runOnce(logger, pool);
        res.json({ ran: true, stats });
    } catch (e) {
        logger.error({ err: e.message }, 'manual decay FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ============================================================================
// PHASE 2.2 — Anti-Abuse Admin endpoints
// ============================================================================

/**
 * GET /api/admin/abuse — prehľad abuse statu
 *   ?include=bans,rejections,signature_failures,pow,anomalies
 *   default: vráti všetko v skrátenej forme
 */
app.get('/api/admin/abuse', security.adminAuth, async (req, res) => {
    const include = (req.query.include || 'bans,rejections,signature_failures,pow,summary').split(',').map(s => s.trim());
    const out = {};
    
    try {
        if (include.includes('summary')) {
            const sum = await pool.query(`
                SELECT
                    (SELECT COUNT(*) FROM ip_bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())) AS active_bans,
                    (SELECT COUNT(*) FROM ip_bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) AND banned_by = 'system') AS auto_bans,
                    (SELECT COUNT(*) FROM rejected_requests WHERE occurred_at > NOW() - INTERVAL '1 hour') AS rejections_1h,
                    (SELECT COUNT(*) FROM rejected_requests WHERE occurred_at > NOW() - INTERVAL '24 hours') AS rejections_24h,
                    (SELECT COUNT(*) FROM rejected_requests WHERE occurred_at > NOW() - INTERVAL '1 hour' AND severity IN ('high','critical')) AS critical_1h,
                    (SELECT COUNT(*) FROM signature_failures WHERE occurred_at > NOW() - INTERVAL '1 hour') AS sigfails_1h,
                    (SELECT COUNT(DISTINCT kya_id) FROM signature_failures WHERE occurred_at > NOW() - INTERVAL '1 hour') AS sigfail_agents_1h,
                    (SELECT COUNT(*) FROM pow_challenges WHERE created_at > NOW() - INTERVAL '1 hour') AS pow_issued_1h,
                    (SELECT COUNT(*) FROM pow_challenges WHERE solved_at > NOW() - INTERVAL '1 hour') AS pow_solved_1h
            `);
            out.summary = sum.rows[0];
        }
        
        if (include.includes('bans')) {
            const bans = await pool.query(`
                SELECT id, client_ip::text AS ip, reason, severity, rejection_count, notes,
                       banned_at, expires_at, banned_by, revoked_at, revoked_by, revoke_reason
                FROM ip_bans
                WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
                ORDER BY banned_at DESC LIMIT 200
            `);
            out.active_bans = bans.rows;
        }
        
        if (include.includes('rejections')) {
            const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
            const filter = req.query.client_ip
                ? `client_ip = $1::inet`
                : '1=1';
            const params = req.query.client_ip ? [req.query.client_ip] : [];
            const rej = await pool.query(
                `SELECT id, path, method, reason, http_status, severity, client_ip::text AS ip,
                        kya_id, error_detail, occurred_at
                 FROM rejected_requests WHERE ${filter}
                 ORDER BY occurred_at DESC LIMIT ${limit}`,
                params
            );
            out.recent_rejections = rej.rows;
            
            // Top offenders za 24h
            const top = await pool.query(`
                SELECT client_ip::text AS ip,
                       COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE severity IN ('high','critical')) AS critical,
                       array_agg(DISTINCT reason ORDER BY reason) FILTER (WHERE severity IN ('high','critical')) AS critical_reasons,
                       MAX(occurred_at) AS last_seen
                FROM rejected_requests
                WHERE occurred_at > NOW() - INTERVAL '24 hours'
                GROUP BY client_ip
                HAVING COUNT(*) > 5
                ORDER BY critical DESC, total DESC
                LIMIT 20
            `);
            out.top_offenders_24h = top.rows;
        }
        
        if (include.includes('signature_failures')) {
            const sigfails = await pool.query(`
                SELECT kya_id, endpoint, failure_type,
                       COUNT(*) AS n,
                       MAX(occurred_at) AS last_failure
                FROM signature_failures
                WHERE occurred_at > NOW() - INTERVAL '1 hour'
                GROUP BY kya_id, endpoint, failure_type
                ORDER BY n DESC LIMIT 50
            `);
            out.signature_failures_1h = sigfails.rows;
        }
        
        if (include.includes('pow')) {
            const powStats = await pool.query(`
                SELECT
                    purpose,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS issued_1h,
                    COUNT(*) FILTER (WHERE solved_at > NOW() - INTERVAL '1 hour') AS solved_1h,
                    COUNT(*) FILTER (WHERE expires_at < NOW() AND solved_at IS NULL AND created_at > NOW() - INTERVAL '24 hours') AS expired_unsolved_24h,
                    ROUND(AVG(solution_iterations) FILTER (WHERE solved_at > NOW() - INTERVAL '24 hours'), 0) AS avg_iterations_24h
                FROM pow_challenges
                WHERE created_at > NOW() - INTERVAL '24 hours'
                GROUP BY purpose
            `);
            out.pow_stats = powStats.rows;
            out.pow_config = {
                enabled: pow.CFG.ENABLED,
                default_difficulty: pow.CFG.DEFAULT_DIFFICULTY,
                register_difficulty: pow.CFG.REGISTER_DIFFICULTY,
                solve_max_iterations_default: pow.CFG.SOLVE_MAX_ITERATIONS,
                ttl_sec: pow.CFG.TTL_SEC,
                required_for: pow.CFG.REQUIRED_FOR,
            };
        }
        
        if (include.includes('anomalies')) {
            const anomalies = await pool.query(`
                SELECT kya_id, target, anomaly_reason, COUNT(*) AS n,
                       MAX(received_at) AS last_seen
                FROM action_log
                WHERE anomaly_flagged = TRUE
                  AND received_at > NOW() - INTERVAL '7 days'
                GROUP BY kya_id, target, anomaly_reason
                ORDER BY last_seen DESC LIMIT 50
            `);
            out.anomalies_7d = anomalies.rows;
        }
        
        out.config = {
            ip_ban_thresholds: {
                gross_per_10min: abuseTracker.CFG.IP_BAN_GROSS_VIOLATIONS_10MIN,
                total_per_10min: abuseTracker.CFG.IP_BAN_TOTAL_REJECTIONS_10MIN,
                duration_hours: abuseTracker.CFG.IP_BAN_DURATION_HOURS,
            },
            bad_sig_auto_slash: {
                threshold_per_hour: abuseTracker.CFG.BAD_SIG_PER_HOUR_THRESHOLD,
                delta: abuseTracker.CFG.BAD_SIG_AUTO_SLASH_DELTA,
            },
            anomaly: {
                target_spam_threshold: abuseTracker.CFG.ANOMALY_TARGET_SPAM_THRESHOLD,
                auto_slash_delta: abuseTracker.CFG.ANOMALY_AUTO_SLASH_DELTA,
            },
        };
        
        res.json(out);
    } catch (err) {
        logger.error({ err: err.message }, 'admin/abuse FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

/**
 * POST /api/admin/abuse/ban — manuálny ban IP
 *   body: { client_ip, duration_hours?, reason, notes? }
 *   duration_hours=null → permanent ban
 */
app.post('/api/admin/abuse/ban', security.adminAuth, async (req, res) => {
    const { client_ip, duration_hours, reason, notes } = req.body || {};
    
    if (!client_ip || typeof client_ip !== 'string') {
        return res.status(400).json({ error: 'MISSING_CLIENT_IP' });
    }
    // Simple IP validation (v4/v6) — DB INET typ urobí finálny check
    if (!/^[0-9a-fA-F.:]+$/.test(client_ip)) {
        return res.status(400).json({ error: 'INVALID_IP_FORMAT' });
    }
    
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const result = await abuseTracker.adminBanIp(pool, {
            client_ip, duration_hours: duration_hours ? parseInt(duration_hours, 10) : null,
            reason: reason || 'admin manual ban',
            admin_user,
        });
        logger.warn({ client_ip, admin_user, duration_hours, ban_id: result.ban_id }, 'admin manual IP ban');
        res.json({
            banned: true,
            ban_id: result.ban_id,
            client_ip,
            expires_at: result.expires_at,
            permanent: duration_hours === null || duration_hours === undefined,
            banned_by: admin_user,
        });
    } catch (err) {
        logger.error({ err: err.message, client_ip }, 'admin ban FAIL');
        res.status(500).json({ error: 'BAN_FAILED' });
    }
});

/**
 * POST /api/admin/abuse/unban — odbanovať IP
 *   body: { client_ip, reason? }
 */
app.post('/api/admin/abuse/unban', security.adminAuth, async (req, res) => {
    const { client_ip, reason } = req.body || {};
    if (!client_ip) return res.status(400).json({ error: 'MISSING_CLIENT_IP' });
    if (!/^[0-9a-fA-F.:]+$/.test(client_ip)) {
        return res.status(400).json({ error: 'INVALID_IP_FORMAT' });
    }
    
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const result = await abuseTracker.adminUnbanIp(pool, {
            client_ip, admin_user, reason: reason || 'admin manual unban',
        });
        logger.info({ client_ip, admin_user, unbanned: result.unbanned_count }, 'admin manual unban');
        if (result.unbanned_count === 0) {
            return res.status(404).json({ error: 'NO_ACTIVE_BAN', client_ip });
        }
        res.json({
            unbanned: true,
            client_ip,
            count: result.unbanned_count,
            unbanned_by: admin_user,
        });
    } catch (err) {
        logger.error({ err: err.message, client_ip }, 'admin unban FAIL');
        res.status(500).json({ error: 'UNBAN_FAILED' });
    }
});

/**
 * POST /api/admin/abuse/reset-rate-limit — reset IP rate-limit buckets (test helper)
 *   body: { which?: 'all' | 'pay' | 'global' | 'challenge' | 'pow', client_ip? }
 *   Default: reset všetky pre client_ip (alebo všetkých keys ak ip nie je dané).
 */
app.post('/api/admin/abuse/reset-rate-limit', security.adminAuth, async (req, res) => {
    const { which, client_ip } = req.body || {};
    const targets = which && which !== 'all'
        ? [which]
        : Object.keys(_rateLimiters);
    const stats = {};
    for (const name of targets) {
        const lim = _rateLimiters[name];
        if (!lim) continue;
        try {
            if (client_ip) {
                if (typeof lim.resetKey === 'function') { lim.resetKey(client_ip); stats[name] = 'reset-key'; }
                else stats[name] = 'not-supported';
            } else {
                // express-rate-limit MemoryStore má .resetAll na store, ale limiter sám nie.
                // Try store.resetAll alebo iterujeme cez vnútorné dáta
                const store = lim.store || lim;
                if (typeof store.resetAll === 'function') { store.resetAll(); stats[name] = 'reset-all'; }
                else stats[name] = 'no-resetAll';
            }
        } catch (e) {
            stats[name] = 'error:' + e.message;
        }
    }
    res.json({ reset: true, stats });
});

/**
 * GET /api/admin/abuse/agent/:kya_id — view abuse history for specific agent
 */
app.get('/api/admin/abuse/agent/:kya_id', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    try {
        const sigfails = await pool.query(
            `SELECT endpoint, failure_type, client_ip::text AS ip, occurred_at
             FROM signature_failures
             WHERE kya_id = $1 AND occurred_at > NOW() - INTERVAL '24 hours'
             ORDER BY occurred_at DESC LIMIT 100`,
            [kya_id]
        );
        const rejections = await pool.query(
            `SELECT path, reason, http_status, severity, client_ip::text AS ip, occurred_at
             FROM rejected_requests
             WHERE kya_id = $1 AND occurred_at > NOW() - INTERVAL '7 days'
             ORDER BY occurred_at DESC LIMIT 100`,
            [kya_id]
        );
        const anomalies = await pool.query(
            `SELECT target, anomaly_reason, COUNT(*) AS n, MAX(received_at) AS last_seen
             FROM action_log
             WHERE kya_id = $1 AND anomaly_flagged = TRUE
             GROUP BY target, anomaly_reason
             ORDER BY last_seen DESC LIMIT 50`,
            [kya_id]
        );
        res.json({
            kya_id,
            signature_failures_24h: sigfails.rows,
            rejections_7d: rejections.rows,
            flagged_anomalies: anomalies.rows,
        });
    } catch (err) {
        logger.error({ err: err.message, kya_id }, 'admin abuse/agent FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// Admin: zoznam pending reportov
app.get('/api/admin/reports', security.adminAuth, async (req, res) => {
    const status = req.query.status || 'PENDING_REVIEW,ESCALATED';
    const statuses = status.split(',').map(s => s.trim());
    try {
        const r = await pool.query(
            `SELECT id, target_kya_id, report_type, description, status, reporter_kya_id,
                    created_at, resolved_at, resolution
             FROM reports WHERE status = ANY($1::varchar[])
             ORDER BY created_at DESC LIMIT 100`,
            [statuses]
        );
        res.json({ count: r.rowCount, reports: r.rows });
    } catch (e) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});


// ----------------------------------------------------------------------------
// 17) GET /api/agent/:kya_id/actions — self-action audit log
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/actions', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    
    try {
        const r = await pool.query(
            `SELECT id, action_type, target, context, evidence_hash, score_delta,
                    rate_limited, rejected_reason, bot_timestamp, received_at
             FROM action_log
             WHERE kya_id = $1
             ORDER BY received_at DESC LIMIT $2 OFFSET $3`,
            [kya_id, limit, offset]
        );
        const total = await pool.query(`SELECT COUNT(*) AS n FROM action_log WHERE kya_id = $1`, [kya_id]);
        res.json({
            kya_id, count: r.rowCount, total: parseInt(total.rows[0].n, 10),
            offset, limit, actions: r.rows,
        });
    } catch (e) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});


// ----------------------------------------------------------------------------
// 18) Admin: POST /api/admin/agent/:kya_id/reissue-cert — vystaviť nový cert
//     (užitočné po ADMIN_RESTORE z SUSPENDED, alebo pri zmene meta-údajov)
// ----------------------------------------------------------------------------
app.post('/api/admin/agent/:kya_id/reissue-cert', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    const { reason } = req.body || {};
    
    const client = await pool.connect();
    try {
        const ag = await client.query(
            `SELECT id, kya_id, agent_name, agent_pubkey, tier, conduct_grade, valid_until,
                    reputation_score, manifest_hash, manufacturer_id, agent_manifest
             FROM agents WHERE kya_id = $1`,
            [kya_id]
        );
        if (ag.rowCount === 0) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        const a = ag.rows[0];
        
        await client.query('BEGIN');
        
        // Označ predchádzajúce ako non-current + log do CRL ledger
        const oldCerts = await client.query(
            `UPDATE certificates SET is_current = FALSE,
                                      revoked_at = COALESCE(revoked_at, NOW()),
                                      revoke_reason = COALESCE(revoke_reason, 'admin_reissue')
             WHERE kya_id = $1 AND is_current = TRUE
             RETURNING serial, revoked_at`,
            [kya_id]
        );
        // Phase 5 — record each replaced cert into revocation_events
        try {
            const crl = require('./lib/crl');
            for (const row of oldCerts.rows) {
                await crl.recordRevocation(client, {
                    cert_serial: row.serial,
                    kya_id,
                    agent_id: a.id,
                    revoked_at: row.revoked_at,
                    revoked_by: 'admin',
                    revocation_reason: reason ? `admin_reissue: ${String(reason).slice(0, 400)}` : 'admin_reissue',
                    revocation_category: 'REISSUED',
                    admin_user: req.headers['x-admin-user'] || 'admin',
                    client_ip: req.ip,
                });
            }
        } catch (_) { /* never break reissue */ }
        
        // Zvýš serial counter
        const cnt = await client.query(`SELECT COUNT(*)::int AS c FROM certificates WHERE kya_id = $1`, [kya_id]);
        const serial = certs.makeSerial(kya_id, cnt.rows[0].c + 1);
        
        const tier = a.tier === 'ELITE' ? { name: 'ELITE', grade: a.conduct_grade } : { name: 'BASIC', grade: a.conduct_grade };
        const manifestSnap = a.agent_manifest && typeof a.agent_manifest === 'object' ? a.agent_manifest : {};
        const body = certs.buildCertBody({
            kya_id: a.kya_id,
            agentName: a.agent_name,
            pubkey: a.agent_pubkey,
            tier: tier.name,
            grade: a.conduct_grade,
            validUntil: a.valid_until,
            manifestHash: a.manifest_hash,
            manufacturerId: a.manufacturer_id,
            reputationScore: a.reputation_score,
            paymentMethod: 'reissue',
            paymentHash: `reissue:${serial}`,
            amountSats: 0,
            serial,
            paymentHints: integrationsManifest.paymentHintsForCert(manifestSnap),
            integrationsPublic: integrationsManifest.integrationsPublicForCert(manifestSnap),
        });
        const signed = certs.signCert(body, {
            purpose: 'cert_reissue', serial, kya_id, admin_user: req.headers['x-admin-user'] || 'admin', client_ip: req.ip,
        });
        const proofMeta = _extractProofMeta(signed);
        let signingKeyId = null;
        try {
            const meta = await hubkeys.store.lookupKeyByPubkey(client, proofMeta.issuerPubkey);
            signingKeyId = meta ? meta.key_id : null;
        } catch (_) {}

        await client.query(
            `INSERT INTO certificates (
                serial, agent_id, kya_id, cert_body, hub_signature, issuer_pubkey,
                valid_until, issued_by, signing_key_id,
                proof_type, proof_threshold, proof_signing_roles
            )
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                serial, a.id, a.kya_id, JSON.stringify(signed),
                proofMeta.signatureForLegacyColumn, proofMeta.issuerPubkey,
                a.valid_until, 'admin-reissue', signingKeyId,
                proofMeta.proofType, proofMeta.threshold, proofMeta.signingRoles,
            ]
        );
        await client.query(
            `UPDATE agents SET cert_serial = $1, cert_issued_at = CURRENT_TIMESTAMP,
                                revoked_at = NULL, revoke_reason = NULL
             WHERE id = $2`,
            [serial, a.id]
        );
        
        // Audit log
        await client.query(
            `INSERT INTO reputation_events (agent_id, kya_id, event_type, source, delta, score_before, score_after, zone_before, zone_after, reason, admin_user, client_ip)
             VALUES ($1, $2, 'CERT_REISSUED', 'admin', 0, $3, $3, $4, $4, $5, 'admin', $6)`,
            [a.id, kya_id, a.reputation_score, reputation.zoneOf(a.reputation_score), `Reissue ${serial}: ${reason || 'admin action'}`, req.ip]
        );
        
        await client.query('COMMIT');
        developerWebhooks.emit(pool, {
            event: 'cert.reissued',
            kya_id,
            payload: { serial, reason: reason || null },
        }).catch(() => {});
        res.json({ reissued: true, serial, certificate: signed, reason: reason || null });
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err: err.message, kya_id }, 'reissue FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});


// ----------------------------------------------------------------------------
// 19) Admin: Dashboard
// ----------------------------------------------------------------------------
app.get('/api/dashboard', security.adminAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, kya_id, agent_name, status, tier, conduct_grade, reputation_score,
                    initial_deposit, payment_method, payment_amount_sats, payment_settled_at,
                    anchor_status, anchor_txid, valid_until, is_active, last_seen
             FROM agents
             ORDER BY last_seen DESC NULLS LAST
             LIMIT 500`
        );
        res.json({ count: result.rowCount, agents: result.rows });
    } catch (err) {
        logger.error({ err: err.message, route: 'dashboard' }, 'dashboard FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 8) Admin: pending anchors queue (read-only zobrazenie pre Phase 2 debug)
// ----------------------------------------------------------------------------
app.get('/api/anchors/pending', security.adminAuth, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT pa.id, pa.agent_id, a.agent_name, pa.tier, pa.status,
                    pa.hmac_hash, pa.bitcoin_txid, pa.attempts, pa.last_error,
                    pa.created_at, pa.broadcast_at, pa.confirmed_at
             FROM pending_anchors pa
             LEFT JOIN agents a ON a.id = pa.agent_id
             WHERE pa.status IN ('PENDING','BROADCASTING','FAILED')
             ORDER BY pa.created_at ASC`
        );
        res.json({ count: r.rowCount, items: r.rows });
    } catch (err) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ============================================================================
// Phase 4 — Anchor admin endpoints (P4-2)
// ============================================================================

// GET /api/admin/anchor/queue — full anchor worker queue + stats + worker config
app.get('/api/admin/anchor/queue', security.adminAuth, async (req, res) => {
    try {
        const queue = await pool.query(
            `SELECT pa.id, pa.agent_id, a.kya_id, a.agent_name, a.tier AS agent_tier,
                    pa.status, pa.attempts, pa.max_attempts, pa.cert_serial, pa.cert_hash,
                    pa.bitcoin_txid, pa.fee_sats, pa.block_height, pa.confirmations,
                    pa.last_error, pa.created_at, pa.broadcast_at, pa.confirmed_at,
                    pa.next_attempt_at, pa.reissued_cert_serial
             FROM pending_anchors pa
             LEFT JOIN agents a ON a.id = pa.agent_id
             ORDER BY pa.created_at DESC
             LIMIT 100`
        );
        const stats = await pool.query(
            `SELECT status, COUNT(*)::int AS count FROM pending_anchors GROUP BY status`
        );
        const recentAudit = await pool.query(
            `SELECT event_type, COUNT(*)::int AS count
             FROM anchor_audit
             WHERE created_at > NOW() - INTERVAL '24 hours'
             GROUP BY event_type ORDER BY count DESC`
        );
        let bitcoindStatus = null;
        try {
            const info = await bitcoindRpc.getBlockchainInfo();
            bitcoindStatus = {
                ok: true,
                chain: info.chain,
                blocks: info.blocks,
                mempool_size: undefined, // shown via /api/admin/system-health
                progress: info.verificationprogress,
            };
        } catch (e) {
            bitcoindStatus = { ok: false, error: e.message };
        }
        let feerate = null;
        try { feerate = await anchorLib.estimateAnchorFeerate(); } catch (_) {}
        res.json({
            worker_config: {
                broadcast_enabled: process.env.ANCHOR_WORKER_BROADCAST_ENABLED === 'true',
                interval_ms: parseInt(process.env.ANCHOR_WORKER_INTERVAL_MS || '60000', 10),
                confirm_interval_ms: parseInt(process.env.ANCHOR_WORKER_CONFIRM_INTERVAL_MS || '600000', 10),
                require_confirmations: parseInt(process.env.ANCHOR_REQUIRE_CONFIRMATIONS || '1', 10),
                max_attempts: parseInt(process.env.ANCHOR_WORKER_MAX_ATTEMPTS || '3', 10),
            },
            bitcoind: bitcoindStatus,
            recommended_feerate_sat_vb: feerate,
            stats: stats.rows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
            audit_24h: recentAudit.rows,
            queue: queue.rows,
        });
    } catch (err) {
        logger.error({ err: err.message }, 'admin/anchor/queue FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// POST /api/admin/anchor/force
//   Body: { kya_id, simulate_txid?, simulate_block_height?, mark_status? }
//
//   simulate_txid prítomné → bypassuje BTCPay broadcast, priamo zapíše BROADCAST stav
//     s daným txid (pre testy bez peňazí, idempotent ak rovnaký txid).
//   simulate_block_height prítomné spolu s simulate_txid → priamo ANCHORED stav
//     + spustí cert reissue (P4-3).
//   Bez simulate_*: enqueue / re-enqueue daného agenta — worker ho vyzdvihne v ďalšom ticku.
//   mark_status (optional): ak === 'ANCHORED' a poskytnutý simulate_txid, predpokladá
//     potvrdenie a vykoná reissue (used by test-phase4.js).
app.post('/api/admin/anchor/force', security.adminAuth, async (req, res) => {
    const { kya_id, simulate_txid, simulate_block_height, mark_status } = req.body || {};
    if (!kya_id || !/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) {
        return res.status(400).json({ error: 'INVALID_KYA_ID' });
    }
    const client = await pool.connect();
    try {
        const a = await client.query(
            `SELECT id, kya_id, agent_name, tier, anchor_status, anchor_txid
             FROM agents WHERE kya_id = $1`,
            [kya_id]
        );
        if (a.rowCount === 0) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        const agent = a.rows[0];

        // Get or create pending_anchors row + cert hash
        const cert = await anchorLib.fetchCertForAgent(client, agent.id);
        if (!cert) return res.status(409).json({ error: 'NO_CURRENT_CERT', message: 'Agent has no current certificate to anchor' });
        const certHash = anchorLib.certHashOf(cert.cert_body);
        const opReturnHex = anchorLib.buildOpReturnPayload(cert.cert_body);
        const hmac = require('crypto').createHash('sha256').update(`force:${agent.id}:${certHash}`).digest('hex');

        await client.query('BEGIN');

        let paId = null;
        const existing = await client.query(
            `SELECT id, status, bitcoin_txid FROM pending_anchors WHERE agent_id = $1 ORDER BY id DESC LIMIT 1`,
            [agent.id]
        );
        if (existing.rowCount === 0) {
            const ins = await client.query(
                `INSERT INTO pending_anchors (agent_id, hmac_hash, tier, status, cert_serial, cert_hash, op_return_hex)
                 VALUES ($1, $2, $3, 'PENDING', $4, $5, $6) RETURNING id`,
                [agent.id, hmac, agent.tier || 'ELITE', cert.serial, certHash, opReturnHex]
            );
            paId = ins.rows[0].id;
        } else {
            paId = existing.rows[0].id;
            await client.query(
                `UPDATE pending_anchors SET cert_serial=$2, cert_hash=$3, op_return_hex=$4,
                                             status='PENDING', last_error=NULL,
                                             next_attempt_at = NOW(), attempts = 0
                 WHERE id = $1`,
                [paId, cert.serial, certHash, opReturnHex]
            );
        }

        await anchorLib.writeAudit(client, {
            pending_anchor_id: paId, agent_id: agent.id, kya_id,
            event_type: 'FORCED_BY_ADMIN', cert_serial: cert.serial, cert_hash: certHash,
            bitcoin_txid: simulate_txid || null,
            detail: { admin_user: req.headers['x-admin-user'] || 'admin', simulate_txid, simulate_block_height, mark_status, op_return_hex: opReturnHex },
        });

        let resultPayload = { pending_anchor_id: paId, cert_serial: cert.serial, cert_hash: certHash, op_return_hex: opReturnHex };

        if (simulate_txid) {
            // Bypass BTCPay — simulate broadcast
            if (!/^[0-9a-fA-F]{64}$/.test(simulate_txid)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'INVALID_SIMULATE_TXID' });
            }
            await client.query(
                `UPDATE pending_anchors SET status='BROADCAST', bitcoin_txid=$2, broadcast_at=NOW(),
                                             attempts = attempts + 1, last_error = NULL
                 WHERE id = $1`,
                [paId, simulate_txid.toLowerCase()]
            );
            await client.query(
                `UPDATE agents SET anchor_txid=$2, anchor_status='BROADCAST' WHERE id = $1`,
                [agent.id, simulate_txid.toLowerCase()]
            );
            resultPayload.simulated_broadcast = true;
            resultPayload.txid = simulate_txid.toLowerCase();

            if (simulate_block_height || mark_status === 'ANCHORED') {
                const bh = simulate_block_height || 0;
                await client.query(
                    `UPDATE pending_anchors SET status='ANCHORED', confirmations=1,
                                                 block_height=$2, confirmed_at=NOW()
                     WHERE id = $1`,
                    [paId, bh]
                );
                const hbDays = parseInt(process.env.ELITE_LISTING_HEARTBEAT_DAYS || '30', 10);
                await client.query(
                    `UPDATE agents SET anchor_status='ANCHORED', anchor_block_height=$2,
                                        anchor_confirmed_at=NOW(), status='VERIFIED',
                                        elite_listing_status = CASE WHEN tier = 'ELITE' THEN 'LISTED' ELSE elite_listing_status END,
                                        elite_listing_heartbeat_paid_at = CASE WHEN tier = 'ELITE' THEN NOW() ELSE elite_listing_heartbeat_paid_at END,
                                        elite_listing_next_due_at = CASE WHEN tier = 'ELITE' THEN NOW() + ($3::int * INTERVAL '1 day') ELSE elite_listing_next_due_at END,
                                        elite_listing_grace_until = CASE WHEN tier = 'ELITE' THEN NULL ELSE elite_listing_grace_until END,
                                        elite_listing_miss_streak = CASE WHEN tier = 'ELITE' THEN 0 ELSE elite_listing_miss_streak END
                     WHERE id = $1`,
                    [agent.id, bh, hbDays]
                );
                const reissue = await anchorLib.reissueCertWithAnchor(client, {
                    agent: { id: agent.id, kya_id: agent.kya_id, agent_name: agent.agent_name, tier: agent.tier },
                    anchor: {
                        txid: simulate_txid.toLowerCase(),
                        vout: 0,
                        op_return_hex: opReturnHex,
                        cert_hash: certHash,
                        block_height: bh || null,
                        block_hash: null,
                        confirmed_at: new Date().toISOString(),
                    },
                    logger,
                });
                if (reissue.reissued) {
                    await client.query(
                        `UPDATE pending_anchors SET reissued_cert_serial = $2 WHERE id = $1`,
                        [paId, reissue.serial]
                    );
                    await anchorLib.writeAudit(client, {
                        pending_anchor_id: paId, agent_id: agent.id, kya_id,
                        event_type: 'CERT_REISSUED', cert_serial: reissue.serial, cert_hash: certHash,
                        bitcoin_txid: simulate_txid.toLowerCase(), block_height: bh || null,
                        detail: { simulated: true, old_serial: reissue.oldSerial },
                    });
                    resultPayload.reissued_cert_serial = reissue.serial;
                }
                resultPayload.simulated_anchored = true;
            }
        }

        await client.query('COMMIT');
        res.json({ ok: true, ...resultPayload });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error({ err: err.message, kya_id }, 'admin/anchor/force FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    } finally {
        client.release();
    }
});

// GET /api/admin/anchor/audit/:kya_id — full forensic trail
app.get('/api/admin/anchor/audit/:kya_id', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    try {
        const r = await pool.query(
            `SELECT id, pending_anchor_id, event_type, cert_serial, cert_hash, bitcoin_txid,
                    fee_sats, block_height, detail, created_at
             FROM anchor_audit
             WHERE kya_id = $1
             ORDER BY created_at ASC`,
            [kya_id]
        );
        res.json({ kya_id, count: r.rowCount, events: r.rows });
    } catch (err) {
        logger.error({ err: err.message, kya_id }, 'admin anchor audit FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/admin/webhooks/queue — priority view of unprocessed webhooks (P4-5)
app.get('/api/admin/webhooks/queue', security.adminAuth, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT id, source, delivery_id, invoice_id, event_type,
                    agent_tier, priority, processed, processing_started_at,
                    received_at, processed_at, processing_result
             FROM webhook_deliveries
             ORDER BY processed ASC,
                      priority DESC,
                      received_at ASC
             LIMIT 200`
        );
        const stats = await pool.query(
            `SELECT processed, agent_tier, COUNT(*)::int AS count
             FROM webhook_deliveries
             WHERE received_at > NOW() - INTERVAL '24 hours'
             GROUP BY processed, agent_tier`
        );
        const elitePending = r.rows.filter(w => !w.processed && w.agent_tier === 'ELITE').length;
        res.json({
            count: r.rowCount,
            elite_pending: elitePending,
            stats_24h: stats.rows,
            queue: r.rows,
        });
    } catch (err) {
        logger.error({ err: err.message }, 'admin webhooks queue FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ============================================================================
// Phase 2.3 — Trust & Governance Layer
// ============================================================================

// ----------------------------------------------------------------------------
// 20) POST /api/agent/:kya_id/appeal — submit signed dispute appeal
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/appeal', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    const { against_event_id, appeal_text, evidence, signature, nonce, timestamp } = req.body || {};
    
    const result = await appealService.submitAppeal(pool, hubkeys, {
        kya_id,
        against_event_id: against_event_id ? parseInt(against_event_id, 10) : null,
        appeal_text,
        evidence,
        signature,
        nonce,
        timestamp,
        client_ip: req.ip,
        user_agent: req.headers['user-agent'],
    });
    
    if (result.error) {
        // Replay protection: zapíš REPLAY_NONCE_REUSED do abuse trackera ako medium severity
        if (result.error === 'REPLAY_NONCE_REUSED') {
            abuseTracker.recordRejection(pool, {
                path: req.path, method: req.method, reason: 'APPEAL_REPLAY',
                http_status: 409, kya_id, client_ip: req.ip,
                user_agent: req.headers['user-agent'],
                error_detail: 'appeal nonce already used',
            }).catch(() => {});
            return res.status(409).json({ error: result.error });
        }
        if (result.error === 'BAD_SIGNATURE') {
            abuseTracker.recordSignatureFailure(pool, {
                kya_id, client_ip: req.ip, endpoint: 'appeal', failure_type: 'BAD_SIGNATURE', logger,
            }).catch(() => {});
            return rejectAndLog(req, res, 401, 'BAD_SIGNATURE', { kya_id });
        }
        const httpStatus = ({
            INVALID_KYA_ID: 400, INVALID_APPEAL_TEXT: 400, BAD_SIGNATURE_FORMAT: 400,
            INVALID_NONCE_FORMAT: 400, MISSING_TIMESTAMP: 400, TIMESTAMP_SKEW: 400,
            AGENT_NOT_FOUND: 404, AGENT_HAS_NO_PUBKEY: 400, AGENT_RETIRED: 410,
            EVENT_NOT_FOUND: 404, EVENT_NOT_APPEALABLE: 409, POSITIVE_EVENT_NOT_APPEALABLE: 400,
            APPEAL_ALREADY_EXISTS_FOR_EVENT: 409,
        })[result.error] || 400;
        return res.status(httpStatus).json(result);
    }
    
    logger.info({ kya_id, appeal_id: result.appeal_id, sla: result.sla_deadline }, 'appeal submitted');
    res.json(result);
});

// ----------------------------------------------------------------------------
// 21) GET /api/agent/:kya_id/appeals — verejné: zoznam apelácií agenta
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/appeals', async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    try {
        const out = await appealService.listForAgent(pool, kya_id, { limit, offset });
        res.json({ kya_id, ...out, limit, offset });
    } catch (e) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 22) Admin: GET /api/admin/appeals
// ----------------------------------------------------------------------------
app.get('/api/admin/appeals', security.adminAuth, async (req, res) => {
    const status = req.query.status || 'PENDING';
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    try {
        const out = await appealService.listForAdmin(pool, { status, limit, offset });
        res.json({ status_filter: status, ...out, limit, offset });
    } catch (e) {
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 23) Admin: POST /api/admin/appeals/:id/resolve
// ----------------------------------------------------------------------------
app.post('/api/admin/appeals/:id/resolve', security.adminAuth, async (req, res) => {
    const appeal_id = parseInt(req.params.id, 10);
    if (!Number.isFinite(appeal_id)) return res.status(400).json({ error: 'INVALID_ID' });
    const { resolution, note } = req.body || {};
    try {
        const out = await appealService.resolveAppeal(pool, repEngine, {
            appeal_id, resolution, note,
            admin_user: req.headers['x-admin-user'] || 'admin',
            client_ip: req.ip,
        });
        if (out.error) {
            const code = ({ INVALID_RESOLUTION: 400, APPEAL_NOT_FOUND: 404, ALREADY_RESOLVED: 409 })[out.error] || 400;
            return res.status(code).json(out);
        }
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, appeal_id }, 'resolve appeal FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 24) POST /api/agent/:kya_id/retire — signed self-unregister
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/retire', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    const { retire_reason, signature, nonce, timestamp } = req.body || {};
    
    try {
        const out = await retireService.retire(pool, hubkeys, {
            kya_id, retire_reason, signature, nonce, timestamp,
            client_ip: req.ip,
            user_agent: req.headers['user-agent'],
        });
        if (out.error) {
            if (out.error === 'BAD_SIGNATURE') {
                abuseTracker.recordSignatureFailure(pool, {
                    kya_id, client_ip: req.ip, endpoint: 'retire', failure_type: 'BAD_SIGNATURE', logger,
                }).catch(() => {});
                return rejectAndLog(req, res, 401, 'BAD_SIGNATURE', { kya_id });
            }
            const code = ({
                INVALID_KYA_ID: 400, INVALID_RETIRE_REASON: 400, BAD_SIGNATURE_FORMAT: 400,
                INVALID_NONCE_FORMAT: 400, MISSING_TIMESTAMP: 400, TIMESTAMP_SKEW: 400,
                AGENT_NOT_FOUND: 404, AGENT_HAS_NO_PUBKEY: 400, ALREADY_RETIRED: 409,
            })[out.error] || 400;
            return res.status(code).json(out);
        }
        logger.info({ kya_id, revoked_certs: out.revoked_certs }, 'agent retired');
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, kya_id, stack: (e.stack || '').slice(0, 500) },
            'retire FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 24a) POST /api/agent/:kya_id/data-export — Strategic Sprint §30 Item 8
//      Agent-signed Subject Access Request (GDPR). Returns a one-time URL.
// ----------------------------------------------------------------------------
app.post('/api/agent/:kya_id/data-export', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    const { signature, nonce, timestamp } = req.body || {};
    try {
        const out = await dataExportService.createExport(pool, hubkeys, {
            kya_id, signature, nonce, timestamp,
            client_ip: req.ip,
            user_agent: req.headers['user-agent'],
        });
        if (out.error) {
            if (out.error === 'BAD_SIGNATURE') {
                abuseTracker.recordSignatureFailure(pool, {
                    kya_id, client_ip: req.ip, endpoint: 'data-export', failure_type: 'BAD_SIGNATURE', logger,
                }).catch(() => {});
                return rejectAndLog(req, res, 401, 'BAD_SIGNATURE', { kya_id });
            }
            const code = ({
                INVALID_KYA_ID: 400, BAD_SIGNATURE_FORMAT: 400, INVALID_NONCE_FORMAT: 400,
                MISSING_TIMESTAMP: 400, TIMESTAMP_SKEW: 400,
                AGENT_NOT_FOUND: 404, AGENT_HAS_NO_PUBKEY: 400,
                RATE_LIMIT: 429, BUILD_FAILED: 500,
            })[out.error] || 400;
            if (out.error === 'RATE_LIMIT') res.set('Retry-After', String(out.retry_after_seconds || 3600));
            return res.status(code).json(out);
        }
        logger.info({
            kya_id, export_id: out.export_id, bytes: out.archive_size_bytes,
        }, 'agent data export created');
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, kya_id, stack: (e.stack || '').slice(0, 500) },
            'data-export FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 24b) GET /api/agent/:kya_id/data-export/:export_id?token=<hex>
//      One-time signed-URL download for the archive built above.
// ----------------------------------------------------------------------------
app.get('/api/agent/:kya_id/data-export/:export_id', async (req, res) => {
    const kya_id = req.params.kya_id;
    const exportId = parseInt(req.params.export_id, 10);
    const token = String(req.query.token || '');
    try {
        const out = await dataExportService.resolveDownload(pool, { export_id: exportId, kya_id, token });
        if (out.error) {
            return res.status(out.status || 400).json({ error: out.error, current_status: out.current_status });
        }
        await dataExportService.markDownloaded(pool, exportId, { client_ip: req.ip });
        const fs = require('fs');
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename="EXPORT-${kya_id}-${exportId}.json.zip"`);
        res.set('X-Archive-SHA256', out.archive_sha256 || '');
        fs.createReadStream(out.archive_path).pipe(res);
    } catch (e) {
        logger.error({ err: e.message, kya_id, export_id: exportId, stack: (e.stack || '').slice(0, 500) },
            'data-export download FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 24c) Admin: GET /api/admin/data-exports — recent SAR audit, list rows.
//      Admin: POST /api/admin/data-exports/prune — delete expired archives.
// ----------------------------------------------------------------------------
app.get('/api/admin/data-exports', security.adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
        const r = await pool.query(
            `SELECT id, kya_id, agent_id, requested_at, completed_at, status,
                    expires_at, archive_size_bytes, archive_sha256,
                    download_count, downloaded_at, pruned_at, error_message
               FROM data_exports
              ORDER BY requested_at DESC
              LIMIT $1 OFFSET $2`,
            [limit, offset]);
        const total = await pool.query('SELECT COUNT(*)::int AS c FROM data_exports');
        res.json({ total: total.rows[0].c, rows: r.rows, limit, offset });
    } catch (e) {
        logger.error({ err: e.message }, 'admin list data-exports FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

app.post('/api/admin/data-exports/prune', security.adminAuth, async (req, res) => {
    try {
        const dryRun = !!(req.body && req.body.dry_run);
        const out = await dataExportService.prune(pool, { dryRun });
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message }, 'admin prune data-exports FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 25) Admin: POST /api/admin/agent/:kya_id/purge — GDPR full delete
// ----------------------------------------------------------------------------
app.post('/api/admin/agent/:kya_id/purge', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    const { hard_delete } = req.body || {};
    try {
        const out = await retireService.adminPurge(pool, {
            kya_id,
            admin_user: req.headers['x-admin-user'] || 'admin',
            client_ip: req.ip,
            hard_delete: !!hard_delete,
        });
        if (out.error) {
            const code = ({ INVALID_KYA_ID: 400, AGENT_NOT_FOUND: 404 })[out.error] || 400;
            return res.status(code).json(out);
        }
        logger.warn({ kya_id, hard_delete: !!hard_delete, admin: out.purged_by }, 'admin purge done');
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, kya_id }, 'admin purge FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// 26) Admin: GET /api/admin/hub-keys — list keys + audit
// ----------------------------------------------------------------------------
app.get('/api/admin/hub-keys', security.adminAuth, async (req, res) => {
    try {
        const dbKeys = await pool.query(
            `SELECT key_id, role, alg, pubkey_hex, status,
                    created_at, activated_at, deprecated_at, deprecation_reason,
                    replaces_key_id, notes
             FROM hub_keys ORDER BY role, status, created_at DESC`
        );
        const loaded = hubkeys.store.listLoaded();
        
        const signSummary = await pool.query(
            `SELECT key_id, role, COUNT(*)::int AS signs_24h,
                    COUNT(*) FILTER (WHERE anomaly_flagged) ::int AS anomalies
             FROM cert_signing_log
             WHERE signed_at > NOW() - INTERVAL '24 hours'
             GROUP BY key_id, role
             ORDER BY signs_24h DESC`
        );
        
        const perms = filePermWatcher.checkAll(['.env'], process.cwd());
        
        res.json({
            keys_in_db: dbKeys.rows,
            keys_loaded_in_process: loaded,
            signing_activity_24h: signSummary.rows,
            file_perms: perms,
            perm_watcher: filePermWatcher.getStats(),
        });
    } catch (e) {
        logger.error({ err: e.message }, 'admin hub-keys FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// 27) Admin: GET /api/admin/cert-signing-log — forensics
// ----------------------------------------------------------------------------
app.get('/api/admin/cert-signing-log', security.adminAuth, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 1000);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const kya_id = req.query.kya_id;
    const role = req.query.role;
    try {
        const conds = [];
        const params = [];
        if (kya_id) { params.push(kya_id); conds.push(`kya_id = $${params.length}`); }
        if (role) { params.push(role); conds.push(`role = $${params.length}`); }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        params.push(limit); params.push(offset);
        const r = await pool.query(
            `SELECT id, serial, kya_id, key_id, role, signing_purpose, message_hash,
                    signature_prefix, requested_by_admin, requested_by_ip, signed_at,
                    anomaly_flagged, anomaly_reason
             FROM cert_signing_log ${where}
             ORDER BY signed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        res.json({ count: r.rowCount, limit, offset, entries: r.rows });
    } catch (e) {
        logger.error({ err: e.message }, 'admin cert-signing-log FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ============================================================================
// Phase 2.4 — Admin endpoints (pricing, retention, sybil monitoring)
// ============================================================================

// GET /api/admin/pricing — aktuálny tier pricing + history
app.get('/api/admin/pricing', security.adminAuth, async (req, res) => {
    try {
        const current = pricing.getAll();
        const includeHistory = req.query.history === 'true';
        const history = includeHistory ? await pricing.getHistory(pool, req.query.tier, 50) : null;
        res.json({ current, history });
    } catch (e) {
        logger.error({ err: e.message }, 'admin pricing fetch FAIL');
        res.status(500).json({ error: 'PRICING_FETCH_FAIL' });
    }
});

// POST /api/admin/pricing — live update tier ceny (zachová históriu)
// body: { tier_name, amount_sats, [grade, duration_months, requires_anchor, base_reputation, change_reason] }
app.post('/api/admin/pricing', security.adminAuth, async (req, res) => {
    const { tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation, change_reason } = req.body || {};
    if (!tier_name || !Number.isInteger(amount_sats)) {
        return res.status(400).json({ error: 'MISSING_FIELDS', required: ['tier_name', 'amount_sats'] });
    }
    try {
        const r = await pricing.update(pool, {
            tier_name, amount_sats, grade, duration_months, requires_anchor, base_reputation,
            changed_by: req.headers['x-admin-user'] || 'admin',
            change_reason: change_reason || null,
        });
        logger.warn({
            tier_name, amount_sats,
            previous_sats: r.previous?.amount_sats,
            admin: req.headers['x-admin-user'] || 'admin',
            ip: req.ip,
        }, 'admin pricing UPDATE');
        res.json({ ok: true, previous: r.previous, current: r.current, active_snapshot: pricing.getAll() });
    } catch (e) {
        logger.error({ err: e.message }, 'admin pricing update FAIL');
        res.status(400).json({ error: 'PRICING_UPDATE_FAIL' });
    }
});

// POST /api/admin/pricing/reload — force reload z DB (ak edit prebehol mimo API)
// GET /api/admin/developer-keys — list integrator API keys (no secrets)
app.get('/api/admin/developer-keys', security.adminAuth, async (req, res) => {
    try {
        const keys = await developerApiKeys.listKeys(pool);
        res.json({ count: keys.length, keys });
    } catch (e) {
        logger.error({ err: e.message }, 'admin developer-keys list FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// POST /api/admin/developer-keys — create umb_live_… key (shown once)
app.post('/api/admin/developer-keys', security.adminAuth, async (req, res) => {
    const body = req.body || {};
    try {
        const created = await developerApiKeys.createKey(pool, {
            label: body.label,
            owner_contact: body.owner_contact,
            scopes: body.scopes,
            tier: body.tier,
            rate_limit_per_min: body.rate_limit_per_min,
        });
        logger.info({
            id: created.id,
            prefix: created.key_prefix,
            tier: created.tier,
            admin: req.headers['x-admin-user'] || 'admin',
        }, 'developer API key created');
        res.status(201).json(created);
    } catch (e) {
        logger.error({ err: e.message }, 'admin developer-keys create FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/admin/integrator-key-requests — pending partner key requests
app.get('/api/admin/integrator-key-requests', security.adminAuth, async (req, res) => {
    try {
        const rows = await integratorKeyRequests.list(pool, {
            status: (req.query.status || '').trim() || undefined,
        });
        res.json({ count: rows.length, requests: rows });
    } catch (e) {
        logger.error({ err: e.message }, 'admin integrator-key-requests list FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.post('/api/admin/integrator-key-requests/:id/approve', security.adminAuth, async (req, res) => {
    const id = (req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    try {
        const out = await integratorKeyRequests.approve(pool, id, {
            tier: (req.body || {}).tier,
            label: (req.body || {}).label,
            admin_notes: (req.body || {}).admin_notes,
            admin_user: req.headers['x-admin-user'] || 'admin',
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        logger.info({ request_id: id, key_prefix: out.key_prefix }, 'integrator key request approved');
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, id }, 'integrator-key-request approve FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.post('/api/admin/integrator-key-requests/:id/reject', security.adminAuth, async (req, res) => {
    const id = (req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    try {
        const out = await integratorKeyRequests.reject(pool, id, {
            admin_notes: (req.body || {}).admin_notes,
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, id }, 'integrator-key-request reject FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// POST /api/admin/developer-keys/:id/revoke
app.post('/api/admin/developer-keys/:id/revoke', security.adminAuth, async (req, res) => {
    const id = (req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'MISSING_ID' });
    try {
        const row = await developerApiKeys.revokeKey(pool, id);
        if (!row) return res.status(404).json({ error: 'KEY_NOT_FOUND' });
        logger.warn({ id, prefix: row.key_prefix }, 'developer API key revoked');
        res.json({ ok: true, id: row.id, key_prefix: row.key_prefix, revoked_at: row.revoked_at });
    } catch (e) {
        logger.error({ err: e.message, id }, 'admin developer-keys revoke FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/admin/developer-webhooks/deliveries — outbox queue inspection
app.get('/api/admin/developer-webhooks/deliveries', security.adminAuth, async (req, res) => {
    try {
        const rows = await developerWebhookQueue.listDeliveries(pool, {
            status: req.query.status,
            kya_id: req.query.kya_id,
            limit: parseInt(req.query.limit || '50', 10),
        });
        const counts = await developerWebhookQueue.countByStatus(pool);
        res.json({ counts, deliveries: rows });
    } catch (e) {
        logger.error({ err: e.message }, 'admin developer-webhooks deliveries FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// POST /api/admin/developer-webhooks/process — run one worker batch (ops)
app.post('/api/admin/developer-webhooks/process', security.adminAuth, async (req, res) => {
    try {
        const limit = parseInt(req.body?.limit || req.query?.limit || String(developerWebhookQueue.BATCH_SIZE), 10);
        const out = await developerWebhookQueue.processPending(pool, { limit });
        res.json({ ok: true, ...out });
    } catch (e) {
        logger.error({ err: e.message }, 'admin developer-webhooks process FAIL');
        res.status(500).json({ error: 'WORKER_ERROR', message: e.message });
    }
});

app.post('/api/admin/pricing/reload', security.adminAuth, async (req, res) => {
    try {
        const snap = await pricing.reload(pool);
        res.json({ ok: true, snapshot: snap });
    } catch (e) {
        logger.error({ err: e.message }, 'admin pricing reload FAIL');
        res.status(500).json({ error: 'RELOAD_FAIL' });
    }
});

// ============================================================================
// Strategic Sprint §31 D — No-custody penalty endpoints (A+B+D)
// ----------------------------------------------------------------------------
// Public read:
//   GET /api/registration/quote?tier=ELITE&pubkey=<hex>
//
// Admin (X-Admin-Key):
//   POST /api/admin/agents/:kya_id/ban
//        body: { reason, evidence_hash?, ban_duration_days? }
//   POST /api/admin/agents/:kya_id/unban
//        body: { reason? } — clears deny-list cooldown but ban_count persists
//   GET  /api/admin/deny-list?limit=100&offset=0&only_active=true
// ============================================================================

// Public read-only quote — lets bots estimate the price BEFORE submitting
// a registration. Rate-limited via phase2Limiter (declared earlier in server.js).
app.get('/api/registration/quote', phase2Limiter, async (req, res) => {
    const { tier, pubkey } = req.query;
    if (!tier) return res.status(400).json({ error: 'MISSING_TIER' });
    if (pubkey && !security.isValidPubkey(String(pubkey))) {
        return res.status(400).json({ error: 'INVALID_PUBKEY' });
    }
    try {
        const out = await regQuote.getQuote(pool, { tier: String(tier), pubkey: pubkey ? String(pubkey) : null });
        if (out.error) return res.status(400).json(out);
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message, tier, pubkey: pubkey ? String(pubkey).slice(0, 16) : null },
            'GET /api/registration/quote FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

app.post('/api/admin/agents/:kya_id/ban', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { reason, evidence_hash, ban_duration_days } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.length > 500) {
        return res.status(400).json({ error: 'MISSING_OR_OVERLONG_REASON' });
    }
    if (evidence_hash && !/^[0-9a-f]{64}$/i.test(evidence_hash)) {
        return res.status(400).json({ error: 'INVALID_EVIDENCE_HASH_FORMAT' });
    }
    const admin_user = req.headers['x-admin-user'] || 'admin';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const banRes = await regQuote.banAgent(client, {
            kya_id, reason, evidence_hash,
            ban_duration_days, admin_user,
        });
        await client.query('COMMIT');

        // Best-effort: also revoke the active cert(s) and record into CRL.
        // Doesn't block the response — operator dashboard sees both records.
        try {
            const revClient = await pool.connect();
            try {
                await revClient.query('BEGIN');
                const af = await revClient.query(
                    'SELECT id FROM agents WHERE kya_id = $1', [kya_id]);
                const agentDbId = af.rowCount > 0 ? af.rows[0].id : null;
                const oldCerts = await revClient.query(
                    `UPDATE certificates SET is_current = FALSE,
                                              revoked_at = COALESCE(revoked_at, NOW()),
                                              revoke_reason = COALESCE(revoke_reason, $2)
                     WHERE kya_id = $1 AND is_current = TRUE
                     RETURNING serial, revoked_at`,
                    [kya_id, `ban: ${String(reason).slice(0, 400)}`]
                );
                for (const row of oldCerts.rows) {
                    await crlLib.recordRevocation(revClient, {
                        cert_serial: row.serial,
                        kya_id, agent_id: agentDbId,
                        revoked_at: row.revoked_at,
                        revoked_by: admin_user,
                        revocation_reason: `ban: ${String(reason).slice(0, 400)}`,
                        revocation_category: 'BANNED',
                        admin_user, client_ip: req.ip,
                    });
                }
                await revClient.query('COMMIT');
            } catch (innerErr) {
                await revClient.query('ROLLBACK');
                throw innerErr;
            } finally {
                revClient.release();
            }
        } catch (e) {
            logger.warn({ err: e.message, kya_id }, 'cert revocation after ban FAIL (non-fatal)');
        }

        notifications.notify({
            category: 'warning',
            title: `Agent BANNED ${kya_id}`,
            body: `kya_id: ${kya_id}\nreason: ${reason}\nban_count: ${banRes.ban_count}\nexpires_at: ${banRes.expires_at}\nadmin: ${admin_user}`,
            dedupe_key: `ban_${kya_id}`,
        }).catch(() => {});

        res.json({ ok: true, ...banRes });
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ err: e.message, kya_id }, 'admin ban FAIL');
        const status = /AGENT_NOT_FOUND/.test(e.message) ? 404
            : /AGENT_HAS_NO_PUBKEY|AGENT_PUBKEY_INVALID/.test(e.message) ? 400
            : 500;
        res.status(status).json({ error: e.code || 'BAN_FAILED' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/agents/:kya_id/unban', security.adminAuth, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { reason } = req.body || {};
    const admin_user = req.headers['x-admin-user'] || 'admin';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const ag = await client.query(
            `SELECT agent_pubkey, status FROM agents WHERE kya_id = $1 FOR UPDATE`,
            [kya_id]
        );
        if (ag.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        }
        const pubkey = ag.rows[0].agent_pubkey;
        if (!pubkey) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'AGENT_HAS_NO_PUBKEY' });
        }
        const cleared = await regQuote.unbanPubkey(client, pubkey, {
            admin_user, reason: reason || null,
        });
        await client.query('COMMIT');
        logger.info({ kya_id, admin_user, pubkey_prefix: pubkey.slice(0, 16), ban_count: cleared.ban_count },
            'admin unban (deny-list cleared; ban_count preserved)');
        res.json({ ok: true, kya_id, pubkey_prefix: pubkey.slice(0, 16), ...cleared });
    } catch (e) {
        await client.query('ROLLBACK');
        logger.error({ err: e.message, kya_id }, 'admin unban FAIL');
        res.status(500).json({ error: 'UNBAN_FAILED' });
    } finally {
        client.release();
    }
});

// ============================================================================
// Strategic Sprint §31 C — Invoice endpoints
// ----------------------------------------------------------------------------
//   GET    /api/admin/invoices                       paginated list
//   GET    /api/admin/invoices/:invoice_number.json  metadata
//   GET    /api/admin/invoices/:invoice_number/pdf   streams PDF (local or R2)
//   POST   /api/admin/invoices/regenerate/:invoice_number
//   GET    /api/agent/invoice/:kya_id                Ed25519-signed self-fetch
// ============================================================================

app.get('/api/admin/invoices', security.adminAuth, async (req, res) => {
    try {
        const out = await invoicePdf.listInvoices(pool, {
            limit: req.query.limit, offset: req.query.offset,
            kya_id: req.query.kya_id,
        });
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message }, 'admin list invoices FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.get('/api/admin/invoices/:invoice_number.json', security.adminAuth, async (req, res) => {
    try {
        const inv = await invoicePdf.getByNumber(pool, req.params.invoice_number);
        if (!inv) return res.status(404).json({ error: 'INVOICE_NOT_FOUND' });
        res.json(inv);
    } catch (e) {
        logger.error({ err: e.message }, 'admin invoice metadata FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.get('/api/admin/invoices/:invoice_number/pdf', security.adminAuth, async (req, res) => {
    try {
        await invoicePdf.streamPdfToResponse(pool, req.params.invoice_number, res);
    } catch (e) {
        logger.error({ err: e.message, inv: req.params.invoice_number }, 'admin invoice pdf stream FAIL');
        if (!res.headersSent) res.status(500).json({ error: 'INTERNAL' });
    }
});

app.post('/api/admin/invoices/regenerate/:invoice_number', security.adminAuth, async (req, res) => {
    try {
        const out = await invoicePdf.regenerate(pool, req.params.invoice_number, { logger });
        if (out.error) return res.status(404).json(out);
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message }, 'admin invoice regenerate FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// Agent self-fetch: same Ed25519 signing pattern as /api/agent/:kya_id/data-export
// (request body { signature, nonce, timestamp } — signed canonical payload).
app.post('/api/agent/:kya_id/invoice', phase2Limiter, async (req, res) => {
    const kya_id = req.params.kya_id;
    if (!/^UMBRA-[A-F0-9]{6}$/.test(kya_id)) return res.status(400).json({ error: 'INVALID_KYA_ID' });
    const { signature, nonce, timestamp } = req.body || {};
    if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return res.status(400).json({ error: 'BAD_SIGNATURE_FORMAT' });
    if (!nonce || !/^[0-9a-fA-F]{16,64}$/.test(nonce)) return res.status(400).json({ error: 'INVALID_NONCE_FORMAT' });
    if (!timestamp) return res.status(400).json({ error: 'MISSING_TIMESTAMP' });
    const tsMs = new Date(timestamp).getTime();
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > TIMESTAMP_SKEW_MS) {
        return res.status(400).json({ error: 'TIMESTAMP_SKEW' });
    }
    try {
        const ag = await pool.query(
            'SELECT id, kya_id, agent_pubkey FROM agents WHERE kya_id = $1', [kya_id]);
        if (ag.rowCount === 0) return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        const a = ag.rows[0];
        if (!a.agent_pubkey) return res.status(400).json({ error: 'AGENT_HAS_NO_PUBKEY' });

        const canonical = JSON.stringify({ v: 1, op: 'invoice-fetch', kya_id, nonce, timestamp });
        const digest = crypto.createHash('sha256').update(canonical).digest();
        if (!hubkeys.verify(digest, signature, a.agent_pubkey)) {
            abuseTracker.recordSignatureFailure(pool, {
                kya_id, client_ip: req.ip, endpoint: 'invoice', failure_type: 'BAD_SIGNATURE', logger,
            }).catch(() => {});
            return res.status(401).json({ error: 'BAD_SIGNATURE' });
        }

        const list = await invoicePdf.listInvoices(pool, { kya_id, limit: 20 });
        res.json({ kya_id, items: list.items, total: list.total });
    } catch (e) {
        logger.error({ err: e.message, kya_id }, 'agent invoice fetch FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

app.get('/api/admin/deny-list', security.adminAuth, async (req, res) => {
    try {
        const out = await regQuote.listDenyList(pool, {
            limit: req.query.limit,
            offset: req.query.offset,
            only_active: req.query.only_active === 'true' || req.query.only_active === '1',
        });
        // Redact pubkeys to first 16 chars when returning to admin UI; full pubkey
        // still available via a dedicated single-record endpoint if we add one.
        res.json({
            ...out,
            items: out.items.map(r => ({
                ...r,
                pubkey_prefix: (r.pubkey_hex || '').slice(0, 16),
                pubkey_hex: undefined,
            })),
        });
    } catch (e) {
        logger.error({ err: e.message }, 'admin list deny-list FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/admin/retention/sizes — aktuálne sizes log tabuliek
app.get('/api/admin/retention/sizes', security.adminAuth, async (req, res) => {
    try {
        const rows = await retentionWorker.getSizes(pool);
        res.json({ tables: rows, retention_config: retentionWorker.CFG });
    } catch (e) {
        logger.error({ err: e.message }, 'admin retention sizes FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// POST /api/admin/retention/run — manuálne spustenie retention tick
app.post('/api/admin/retention/run', security.adminAuth, async (req, res) => {
    try {
        const stats = await retentionWorker.tick(pool, logger);
        res.json({ ok: true, stats });
    } catch (e) {
        logger.error({ err: e.message }, 'admin retention run FAIL');
        res.status(500).json({ error: 'RETENTION_FAIL' });
    }
});

// GET /api/admin/sybil/circles — detect potential review circles in last N days
app.get('/api/admin/sybil/circles', security.adminAuth, async (req, res) => {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const minPairs = parseInt(req.query.min_pairs || '1', 10);
    try {
        const r = await pool.query(`
            WITH pairs AS (
                SELECT a.reporter_kya_id AS A, a.target_kya_id AS B, COUNT(*) AS a_to_b
                FROM reports a
                WHERE a.created_at > NOW() - INTERVAL '${days} days'
                  AND a.auto_applied_delta IS NOT NULL
                GROUP BY a.reporter_kya_id, a.target_kya_id
            )
            SELECT p1.A, p1.B, p1.a_to_b AS a_reports_b, p2.a_to_b AS b_reports_a
            FROM pairs p1
            JOIN pairs p2 ON p1.A = p2.B AND p1.B = p2.A
            WHERE p1.A < p1.B
              AND p1.a_to_b >= $1 AND p2.a_to_b >= $1
            ORDER BY (p1.a_to_b + p2.a_to_b) DESC
            LIMIT 100
        `, [minPairs]);
        res.json({ window_days: days, suspect_pairs: r.rows });
    } catch (e) {
        logger.error({ err: e.message }, 'admin sybil circles FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/admin/breakers — circuit breaker state pre upstream služby
app.get('/api/admin/breakers', security.adminAuth, (_req, res) => {
    res.json({
        breakers: breaker.snapshotAll(),
        config: breaker.CFG,
        cert_issuance: certIssuanceBreaker.state(),
    });
});

// Ops dashboard JSON — DB agregáty (základ + extended blok pre správanie botov / traffic).
app.get('/api/admin/ops-summary', security.adminAuth, async (req, res) => {
    try {
        const [data, recentR] = await Promise.all([
            fetchOpsSummaryFull(pool),
            pool.query(
                `SELECT occurred_at, reason, path, method, http_status, severity, client_ip::text AS client_ip
                 FROM rejected_requests ORDER BY occurred_at DESC LIMIT 20`
            ),
        ]);
        res.json({
            ...data,
            recent_rejected_requests: recentR.rows,
        });
    } catch (e) {
        logger.error({ err: e.message, route: 'ops-summary' }, 'ops-summary FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// Strategic Sprint §30 Item 10 — Prometheus scrape endpoint. Admin-auth
// gated to prevent third-party scraping. Netdata's Prometheus collector
// is configured to send `X-Admin-Key` so this works transparently.
app.get('/api/metrics', security.adminAuth, async (req, res) => {
    try {
        let liquidityMonitor = null;
        try { liquidityMonitor = require('./scripts/lightning-liquidity-monitor'); } catch (_) {}
        await metrics.refreshFromDeps({
            pool,
            breakers: breaker,
            certBreaker: certIssuanceBreaker,
            forkDetector,
            liquidityMonitor,
        });
        res.set('Content-Type', metrics.contentType());
        res.end(await metrics.render());
    } catch (e) {
        logger.error({ err: e.message }, 'metrics scrape FAIL');
        res.status(500).type('text/plain').send(`# scrape error: ${e.message}\n`);
    }
});

// Strategic Sprint §30 Item 3 — cert issuance breaker admin endpoints.
app.get('/api/admin/breaker/cert-issuance/state', security.adminAuth, (_req, res) => {
    res.json({ ok: true, state: certIssuanceBreaker.state(), config: certIssuanceBreaker.CFG });
});

app.post('/api/admin/breaker/cert-issuance/reset', security.adminAuth, (req, res) => {
    const reason = String((req.body && req.body.reason) || req.query.reason || 'manual reset').slice(0, 256);
    const admin = String(req.headers['x-admin-user'] || req.body?.admin || 'admin').slice(0, 64);
    const r = certIssuanceBreaker.reset({ admin, reason });
    res.json(r);
});

// ============================================================================
// Strategic Sprint §30 Item 4 — Volumetric AML limits admin endpoints
// ============================================================================
app.get('/api/admin/volumetric-limits', security.adminAuth, async (_req, res) => {
    try {
        const limits = await volumetricLimits.listLimits(pool);
        // Augment each with current window utilization (global subject only — for
        // per_agent we can't show every subject; admin can /peek with subject_id).
        const enriched = await Promise.all(limits.map(async (l) => {
            const peek = l.scope === 'global'
                ? await volumetricLimits.peek(pool, l.limit_key).catch(() => null)
                : null;
            return {
                id: l.id,
                limit_key: l.limit_key,
                threshold_value: Number(l.threshold_value),
                window_seconds: l.window_seconds,
                enabled: l.enabled,
                unit: l.unit,
                scope: l.scope,
                description: l.description,
                change_reason: l.change_reason,
                last_changed_by: l.last_changed_by,
                last_changed_at: l.last_changed_at,
                current_global_window: peek,
            };
        }));
        res.json({ ok: true, limits: enriched });
    } catch (e) {
        logger.error({ err: e.message }, 'admin volumetric limits list FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

app.get('/api/admin/volumetric-limits/:limit_key', security.adminAuth, async (req, res) => {
    const limit_key = String(req.params.limit_key || '').slice(0, 96);
    const subject_id = req.query.subject_id ? String(req.query.subject_id).slice(0, 96) : null;
    const peek = await volumetricLimits.peek(pool, limit_key, { subject_id });
    if (!peek) return res.status(404).json({ error: 'UNKNOWN_LIMIT_KEY' });
    res.json({ ok: true, peek });
});

app.post('/api/admin/volumetric-limits', security.adminAuth, async (req, res) => {
    const admin_user = String(req.headers['x-admin-user'] || req.body?.admin_user || 'admin').slice(0, 64);
    const r = await volumetricLimits.upsertLimit(pool, {
        limit_key: req.body?.limit_key,
        threshold_value: req.body?.threshold_value,
        window_seconds: req.body?.window_seconds,
        enabled: req.body?.enabled,
        unit: req.body?.unit,
        scope: req.body?.scope,
        description: req.body?.description,
        change_reason: req.body?.change_reason,
        admin_user,
    });
    if (r.error) return res.status(400).json(r);
    res.json(r);
});

app.post('/api/admin/volumetric-limits/prune', security.adminAuth, async (req, res) => {
    const dry_run = req.body?.dry_run === true || req.query.dry_run === '1';
    const extra = Math.min(Math.max(parseInt(req.body?.extra_margin_days || req.query.extra_margin_days || '7', 10), 0), 90);
    try {
        const r = await volumetricLimits.prune(pool, { extra_margin_days: extra, dry_run });
        res.json({ ok: true, ...r });
    } catch (e) {
        logger.error({ err: e.message }, 'admin volumetric prune FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// ============================================================================
// Strategic Sprint §30 Item 5 — Bitcoin fork detector admin endpoint
// ============================================================================
// Strategic Sprint §30 Item 6 — Lightning liquidity admin endpoint
app.get('/api/admin/lightning/liquidity', security.adminAuth, async (req, res) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    try {
        const liquidity = require('./scripts/lightning-liquidity-monitor');
        if (fresh) {
            const r = await liquidity.runOnce();
            return res.json({ ok: true, fresh: true, result: r.result, config: liquidity.CFG });
        }
        const r = liquidity.getLastResult();
        if (!r) {
            return res.json({
                ok: true, fresh: false,
                message: 'No probe has run yet in this process. Pass ?fresh=1 to force one, or wait for the kya-liquidity-monitor cron tick (every 15 min).',
                config: liquidity.CFG,
            });
        }
        res.json({ ok: true, fresh: false, result: r, config: liquidity.CFG });
    } catch (e) {
        logger.error({ err: e.message }, 'admin lightning liquidity FAIL');
        res.status(500).json({ error: 'PROBE_ERROR' });
    }
});

// GET /api/admin/chain-status
//   ?fresh=1 → force a fresh probe (3 HTTP calls, ~3–6s); default returns
//              the in-memory lastResult (zero-cost; populated by the PM2 cron).
app.get('/api/admin/chain-status', security.adminAuth, async (req, res) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    try {
        const r = fresh
            ? await forkDetector.probe({ alert: false })
            : forkDetector.getLastResult();
        if (!r) {
            return res.json({
                ok: true,
                fresh: false,
                message: 'No probe has run yet in this process. Pass ?fresh=1 to force one, or wait for the kya-fork-detector cron tick (every 10 min).',
                config: forkDetector.CFG,
            });
        }
        res.json({ ok: true, fresh, result: r, config: forkDetector.CFG });
    } catch (e) {
        logger.error({ err: e.message }, 'admin chain-status FAIL');
        res.status(500).json({ error: 'PROBE_ERROR' });
    }
});

// ----------------------------------------------------------------------------
// GET /api/admin/system-health — server capacity / OS metrics (Phase 2.4 follow-up)
// ----------------------------------------------------------------------------
// Disk usage, RAM, load average, PG pool stats, DB size, swap.
// Vhodné pre cron alert script (kontroluje, či < 10% disk free alebo > 90% RAM).
app.get('/api/admin/system-health', security.adminAuth, async (req, res) => {
    try {
        const os = require('os');
        const { execSync } = require('child_process');

        const safeExec = (cmd) => {
            try { return execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim(); }
            catch (e) { return null; }
        };

        // Disk usage cez `df` (root volume)
        let disk = null;
        const dfOut = safeExec('df -BM / | tail -n 1');
        if (dfOut) {
            const parts = dfOut.split(/\s+/);
            const total = parseInt(parts[1], 10);
            const used = parseInt(parts[2], 10);
            const avail = parseInt(parts[3], 10);
            const pct = parseInt(parts[4], 10);
            disk = {
                total_mb: total, used_mb: used, available_mb: avail,
                percent_used: pct, mount: parts[5] || '/',
            };
        }

        // Swap
        let swap = null;
        const swapOut = safeExec('free -m | grep -i swap');
        if (swapOut) {
            const parts = swapOut.split(/\s+/);
            swap = { total_mb: +parts[1], used_mb: +parts[2], free_mb: +parts[3] };
        }

        // RAM
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const ram = {
            total_mb: Math.round(totalMem / 1024 / 1024),
            free_mb: Math.round(freeMem / 1024 / 1024),
            used_mb: Math.round((totalMem - freeMem) / 1024 / 1024),
            percent_used: Math.round(((totalMem - freeMem) / totalMem) * 100),
        };

        // Load average
        const loadavg = os.loadavg();
        const cpus = os.cpus().length;
        const load = {
            cpu_count: cpus,
            load1: loadavg[0], load5: loadavg[1], load15: loadavg[2],
            load_per_cpu_1m: +(loadavg[0] / cpus).toFixed(2),
        };

        // PG pool stats
        const dbPool = {
            total_count: pool.totalCount,
            idle_count: pool.idleCount,
            waiting_count: pool.waitingCount,
            max: pool.options.max,
            percent_used: pool.options.max ? Math.round((pool.totalCount / pool.options.max) * 100) : null,
        };

        // PG DB size
        let dbSize = null;
        try {
            const r = await pool.query(
                "SELECT pg_size_pretty(pg_database_size(current_database())) AS pretty, pg_database_size(current_database()) AS bytes"
            );
            dbSize = { pretty: r.rows[0].pretty, bytes: parseInt(r.rows[0].bytes, 10) };
        } catch (_) { /* non-fatal */ }

        // Aktívne PG spojenia
        let pgConnections = null;
        try {
            const r = await pool.query(`SELECT count(*)::int AS active FROM pg_stat_activity WHERE state = 'active'`);
            pgConnections = { active: r.rows[0].active };
        } catch (_) { /* non-fatal */ }

        // Alert flags (pre cron consumer)
        const alerts = [];
        if (disk && disk.percent_used >= 90) alerts.push({ level: 'critical', kind: 'disk', message: `Disk ${disk.percent_used}% used` });
        else if (disk && disk.percent_used >= 80) alerts.push({ level: 'warning', kind: 'disk', message: `Disk ${disk.percent_used}% used` });
        if (ram.percent_used >= 90) alerts.push({ level: 'critical', kind: 'ram', message: `RAM ${ram.percent_used}% used` });
        else if (ram.percent_used >= 80) alerts.push({ level: 'warning', kind: 'ram', message: `RAM ${ram.percent_used}% used` });
        if (load.load_per_cpu_1m >= 2) alerts.push({ level: 'critical', kind: 'load', message: `1m load ${load.load1.toFixed(2)} (${load.load_per_cpu_1m}× cpu count)` });
        else if (load.load_per_cpu_1m >= 1) alerts.push({ level: 'warning', kind: 'load', message: `1m load ${load.load1.toFixed(2)} (${load.load_per_cpu_1m}× cpu count)` });
        if (dbPool.percent_used !== null && dbPool.percent_used >= 80) alerts.push({ level: 'warning', kind: 'db_pool', message: `DB pool ${dbPool.percent_used}% used (${dbPool.total_count}/${dbPool.max})` });

        const status = alerts.some(a => a.level === 'critical') ? 'critical'
            : alerts.some(a => a.level === 'warning') ? 'warning' : 'ok';

        res.json({
            status,
            timestamp: new Date().toISOString(),
            uptime_seconds: Math.floor(process.uptime()),
            node_version: process.version,
            disk, ram, swap, load,
            db_pool: dbPool,
            db_size: dbSize,
            pg_connections: pgConnections,
            alerts,
        });
    } catch (e) {
        logger.error({ err: e.message }, 'admin system-health FAIL');
        res.status(500).json({ error: 'HEALTH_FAIL' });
    }
});

// ============================================================================
// Phase 4 — Public whitelist + anchor verify API (P4-4)
// ----------------------------------------------------------------------------
// Read-only verejné endpointy s vlastnou CORS politikou (allow *) a in-memory
// TTL cache (default 60 s). Verzia/epoch sa generuje z aktuálneho ISO week.
// ============================================================================
const _whitelistCache = new Map();
const WHITELIST_TTL_MS = parseInt(process.env.WHITELIST_CACHE_TTL_MS || '60000', 10);

function _cacheGet(key) {
    const e = _whitelistCache.get(key);
    if (e && (Date.now() - e.ts) < WHITELIST_TTL_MS) return e.data;
    _whitelistCache.delete(key);
    return null;
}
function _cacheSet(key, data) {
    _whitelistCache.set(key, { ts: Date.now(), data });
    if (_whitelistCache.size > 64) {
        const k0 = _whitelistCache.keys().next().value;
        _whitelistCache.delete(k0);
    }
}

process.on('kya:whitelist-invalidate', () => {
    try {
        _whitelistCache.clear();
    } catch (_) { /* ignore */ }
});

function _epochISOWeek() {
    const d = new Date();
    const yr = d.getUTCFullYear();
    const onejan = new Date(Date.UTC(yr, 0, 1));
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
    return `${yr}-W${String(week).padStart(2, '0')}`;
}

function _publicCors(req, res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Cache-Control', `public, max-age=${Math.floor(WHITELIST_TTL_MS / 1000)}`);
}

function _serializeAgent(row) {
    const o = {
        kya_id: row.kya_id,
        tier: row.tier,
        grade: row.conduct_grade,
        agent_name: row.agent_name,
        pubkey: row.agent_pubkey || null,
        reputation_score: row.reputation_score,
        reputation_zone: row.reputation_score != null
            ? reputation.describe(row.reputation_score).zone : null,
        anchor_status: row.anchor_status,
        anchor_txid: row.anchor_txid,
        anchor_block_height: row.anchor_block_height,
        verified_at: row.verified_at,
        valid_until: row.valid_until,
        cert_serial: row.cert_serial,
        issuer_did: hubkeys.getPublicInfo().pubkey_hex
            ? `did:key:ed25519:${hubkeys.getPublicInfo().pubkey_hex}`
            : null,
        verification_url: row.anchor_txid ? `https://mempool.space/tx/${row.anchor_txid}` : null,
    };
    if (row.tier === 'ELITE') {
        o.elite_listing_status = row.elite_listing_status || 'LISTED';
        o.elite_listing_next_due_at = row.elite_listing_next_due_at || null;
        o.elite_publicly_indexed = (row.elite_listing_status || 'LISTED') === 'LISTED';
    }
    return o;
}

// GET /api/whitelist — VERIFIED agents (BASIC+ELITE; ELITE musia byť ANCHORED + LISTED pre index)
app.get('/api/whitelist', async (req, res) => {
    _publicCors(req, res);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const cacheKey = `whitelist:${limit}:${offset}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return res.json(cached);
    try {
        const r = await pool.query(
            `SELECT kya_id, agent_name, tier, conduct_grade, reputation_score, agent_pubkey,
                    anchor_status, anchor_txid, anchor_block_height,
                    verified_at, valid_until, cert_serial,
                    elite_listing_status, elite_listing_next_due_at
             FROM agents
             WHERE is_active = TRUE
               AND status = 'VERIFIED'
               AND (tier = 'BASIC' OR (tier = 'ELITE' AND anchor_status = 'ANCHORED'))
               AND retired_at IS NULL
               AND (tier <> 'ELITE' OR COALESCE(elite_listing_status, 'LISTED') = 'LISTED')
             ORDER BY verified_at DESC NULLS LAST
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        const total = await pool.query(
            `SELECT COUNT(*)::int AS c FROM agents
             WHERE is_active = TRUE
               AND status = 'VERIFIED'
               AND (tier = 'BASIC' OR (tier = 'ELITE' AND anchor_status = 'ANCHORED'))
               AND retired_at IS NULL
               AND (tier <> 'ELITE' OR COALESCE(elite_listing_status, 'LISTED') = 'LISTED')`
        );
        const payload = {
            epoch: _epochISOWeek(),
            count: r.rowCount,
            total: total.rows[0].c,
            limit, offset,
            next_offset: (offset + r.rowCount) < total.rows[0].c ? offset + r.rowCount : null,
            issuer: {
                did: `did:key:ed25519:${hubkeys.getPublicInfo().pubkey_hex}`,
                hub_name: hubkeys.getPublicInfo().hub_name,
                hub_url: hubkeys.getPublicInfo().hub_url,
            },
            agents: r.rows.map(_serializeAgent),
        };
        _cacheSet(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        logger.error({ err: err.message }, 'whitelist FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/whitelist/elite — ELITE only, must be ANCHORED
app.get('/api/whitelist/elite', async (req, res) => {
    _publicCors(req, res);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const cacheKey = `whitelist-elite:${limit}:${offset}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return res.json(cached);
    try {
        const r = await pool.query(
            `SELECT kya_id, agent_name, tier, conduct_grade, reputation_score, agent_pubkey,
                    anchor_status, anchor_txid, anchor_block_height,
                    verified_at, valid_until, cert_serial,
                    elite_listing_status, elite_listing_next_due_at
             FROM agents
             WHERE is_active = TRUE
               AND status = 'VERIFIED'
               AND tier = 'ELITE'
               AND anchor_status = 'ANCHORED'
               AND retired_at IS NULL
               AND COALESCE(elite_listing_status, 'LISTED') = 'LISTED'
             ORDER BY anchor_confirmed_at DESC NULLS LAST, verified_at DESC NULLS LAST
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        const total = await pool.query(
            `SELECT COUNT(*)::int AS c FROM agents
             WHERE is_active = TRUE AND tier = 'ELITE' AND anchor_status = 'ANCHORED' AND retired_at IS NULL
               AND COALESCE(elite_listing_status, 'LISTED') = 'LISTED'`
        );
        const payload = {
            epoch: _epochISOWeek(),
            tier_filter: 'ELITE',
            count: r.rowCount,
            total: total.rows[0].c,
            limit, offset,
            next_offset: (offset + r.rowCount) < total.rows[0].c ? offset + r.rowCount : null,
            issuer: {
                did: `did:key:ed25519:${hubkeys.getPublicInfo().pubkey_hex}`,
                hub_name: hubkeys.getPublicInfo().hub_name,
            },
            agents: r.rows.map(_serializeAgent),
        };
        _cacheSet(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        logger.error({ err: err.message }, 'whitelist/elite FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/verify/anchor/:txid — overí, či TX obsahuje KYA1 OP_RETURN a vráti agenta
app.get('/api/verify/anchor/:txid', async (req, res) => {
    _publicCors(req, res);
    const txid = (req.params.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) {
        return res.status(400).json({ error: 'INVALID_TXID', message: 'expected 64-char hex' });
    }
    const cacheKey = `verify-anchor:${txid}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return res.json(cached);
    try {
        const onChain = await anchorLib.verifyAnchorOnChain(txid);
        let agentInfo = null;
        let certInfo = null;
        // Reverse lookup ak je to KYA1 anchor: nájdi agenta cez pending_anchors.bitcoin_txid
        const dbRow = await pool.query(
            `SELECT pa.id AS pa_id, pa.cert_hash, pa.cert_serial, pa.reissued_cert_serial,
                    pa.status AS anchor_state, pa.block_height,
                    a.id, a.kya_id, a.agent_name, a.tier, a.conduct_grade, a.agent_pubkey,
                    a.reputation_score, a.anchor_status, a.anchor_txid, a.anchor_block_height,
                    a.verified_at, a.valid_until, a.cert_serial AS current_cert_serial
             FROM pending_anchors pa
             JOIN agents a ON a.id = pa.agent_id
             WHERE LOWER(pa.bitcoin_txid) = $1
             LIMIT 1`,
            [txid]
        );
        if (dbRow.rowCount > 0) {
            const row = dbRow.rows[0];
            agentInfo = _serializeAgent(row);
            const cert = await pool.query(
                `SELECT serial, issued_at, valid_until, is_current, revoked_at
                 FROM certificates
                 WHERE agent_id = $1
                 ORDER BY issued_at DESC LIMIT 5`,
                [row.id]
            );
            certInfo = {
                anchored_cert_serial: row.cert_serial,
                reissued_cert_serial: row.reissued_cert_serial,
                cert_hash_in_anchor: row.cert_hash,
                cert_history: cert.rows,
            };
        }
        const payload = {
            txid,
            on_chain: onChain,
            is_kya_anchor: onChain.is_kya_anchor || false,
            agent: agentInfo,
            cert: certInfo,
            verified_at: new Date().toISOString(),
        };
        _cacheSet(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        logger.error({ err: err.message, txid }, 'verify/anchor FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ============================================================================
// Phase 5 — Public CRL (Revocation Transparency Log) endpoints
// ----------------------------------------------------------------------------
// GET /api/crl                       — paginated list of revocations + anchors
// GET /api/crl/proof/:cert_serial    — Merkle proof for a specific cert
// GET /api/crl/epoch/:epoch_id       — full epoch (tree + revocations + signature)
// GET /api/crl/file/:epoch_label     — serve the signed CRL JSON file (also via /crl/)
//
// Relying parties can verify offline:
//   1. Fetch /api/crl/proof/CERT-XXX → proof + epoch_id + bitcoin_txid
//   2. Fetch on-chain via /api/verify/anchor/:txid (or any explorer)
//   3. Decode KYAR OP_RETURN → 32B Merkle root
//   4. Recompute root from proof + revocation_hash → must equal on-chain root
// ============================================================================

const CRL_CACHE_TTL_MS = parseInt(process.env.CRL_CACHE_TTL_MS || '60000', 10);
const _crlCache = new Map();
function _crlCacheGet(key) {
    const e = _crlCache.get(key);
    if (e && (Date.now() - e.ts) < CRL_CACHE_TTL_MS) return e.data;
    _crlCache.delete(key);
    return null;
}
function _crlCacheSet(key, data) {
    _crlCache.set(key, { ts: Date.now(), data });
    if (_crlCache.size > 64) {
        const k0 = _crlCache.keys().next().value;
        _crlCache.delete(k0);
    }
}

function _serializeCrlAnchor(row) {
    return {
        id: Number(row.id),
        epoch_id: row.epoch_id,
        epoch_label: row.epoch_label,
        merkle_root: row.merkle_root,
        leaf_count: row.leaf_count,
        status: row.status,
        bitcoin_txid: row.bitcoin_txid,
        fee_sats: row.fee_sats,
        broadcast_at: row.broadcast_at,
        confirmed_at: row.confirmed_at,
        block_height: row.block_height,
        block_hash: row.block_hash,
        confirmations: row.confirmations,
        signed_by_role: row.crl_signed_by_role,
        signed_by_pubkey: row.crl_signed_by_pubkey,
        signature_hex: row.crl_signature_hex,
        verification_url: row.bitcoin_txid ? `https://mempool.space/tx/${row.bitcoin_txid}` : null,
        signed_crl_file_url: `/crl/${(row.epoch_label || '').toLowerCase()}.json`,
    };
}

// GET /api/crl?limit=&offset=&kya_id=&cert_serial=
app.get('/api/crl', async (req, res) => {
    _publicCors(req, res);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const kya_id = (req.query.kya_id || '').trim();
    const cert_serial = (req.query.cert_serial || '').trim();
    const cacheKey = `crl:${limit}:${offset}:${kya_id}:${cert_serial}`;
    const cached = _crlCacheGet(cacheKey);
    if (cached) return res.json(cached);
    try {
        const where = [];
        const params = [];
        if (kya_id) { params.push(kya_id); where.push(`r.kya_id = $${params.length}`); }
        if (cert_serial) { params.push(cert_serial); where.push(`r.cert_serial = $${params.length}`); }
        params.push(limit, offset);
        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const r = await pool.query(
            `SELECT r.id, r.cert_serial, r.kya_id, r.revoked_at, r.revoked_by,
                    r.revocation_reason, r.revocation_category, r.revocation_hash,
                    r.crl_anchor_id, r.merkle_leaf_index, r.merkle_proof,
                    r.crl_anchored_at,
                    a.epoch_id, a.epoch_label, a.merkle_root, a.bitcoin_txid,
                    a.status AS anchor_status, a.block_height, a.confirmed_at
             FROM revocation_events r
             LEFT JOIN crl_anchors a ON a.id = r.crl_anchor_id
             ${whereClause}
             ORDER BY r.revoked_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        const totalParams = params.slice(0, params.length - 2);
        const total = await pool.query(
            `SELECT COUNT(*)::int AS c FROM revocation_events r ${whereClause}`,
            totalParams
        );
        const payload = {
            count: r.rowCount,
            total: total.rows[0].c,
            limit, offset,
            next_offset: (offset + r.rowCount) < total.rows[0].c ? offset + r.rowCount : null,
            issuer: {
                did: `did:key:ed25519:${hubkeys.getPublicInfo().pubkey_hex}`,
                hub_name: hubkeys.getPublicInfo().hub_name,
                hub_url: hubkeys.getPublicInfo().hub_url,
            },
            revocations: r.rows.map(row => ({
                cert_serial: row.cert_serial,
                kya_id: row.kya_id,
                revoked_at: row.revoked_at,
                revoked_by: row.revoked_by,
                revocation_reason: row.revocation_reason,
                revocation_category: row.revocation_category,
                revocation_hash: row.revocation_hash,
                anchor: row.crl_anchor_id ? {
                    epoch_id: row.epoch_id,
                    epoch_label: row.epoch_label,
                    merkle_root: row.merkle_root,
                    merkle_leaf_index: row.merkle_leaf_index,
                    merkle_proof: row.merkle_proof,
                    status: row.anchor_status,
                    bitcoin_txid: row.bitcoin_txid,
                    block_height: row.block_height,
                    confirmed_at: row.confirmed_at,
                    verification_url: row.bitcoin_txid ? `https://mempool.space/tx/${row.bitcoin_txid}` : null,
                    signed_crl_file_url: `/crl/${(row.epoch_label || '').toLowerCase()}.json`,
                } : null,
            })),
        };
        _crlCacheSet(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        logger.error({ err: err.message }, '/api/crl FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/crl/proof/:cert_serial — for a specific cert, return the most-recent
// anchored revocation event + Merkle proof
app.get('/api/crl/proof/:cert_serial', async (req, res) => {
    _publicCors(req, res);
    const serial = (req.params.cert_serial || '').trim();
    if (!/^CERT-[A-F0-9]{6}-\d{3}$/i.test(serial)) {
        return res.status(400).json({ error: 'INVALID_CERT_SERIAL' });
    }
    try {
        const r = await pool.query(
            `SELECT r.cert_serial, r.kya_id, r.revoked_at, r.revoked_by,
                    r.revocation_reason, r.revocation_category, r.revocation_hash,
                    r.merkle_leaf_index, r.merkle_proof, r.crl_anchored_at,
                    a.epoch_id, a.epoch_label, a.merkle_root, a.bitcoin_txid,
                    a.status AS anchor_status, a.block_height, a.block_hash,
                    a.confirmed_at, a.confirmations, a.crl_signature_hex,
                    a.crl_signed_by_role, a.crl_signed_by_pubkey
             FROM revocation_events r
             LEFT JOIN crl_anchors a ON a.id = r.crl_anchor_id
             WHERE r.cert_serial = $1
             ORDER BY r.id DESC LIMIT 1`,
            [serial]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ error: 'NOT_REVOKED', message: 'No revocation event for this cert' });
        }
        const row = r.rows[0];
        if (!row.epoch_id) {
            return res.json({
                cert_serial: row.cert_serial,
                kya_id: row.kya_id,
                revoked_at: row.revoked_at,
                revoked_by: row.revoked_by,
                revocation_reason: row.revocation_reason,
                revocation_category: row.revocation_category,
                revocation_hash: row.revocation_hash,
                anchor: null,
                state: 'PENDING_ANCHOR',
                message: 'Revocation is recorded but not yet anchored on-chain. Try again in <24h.',
            });
        }
        res.json({
            cert_serial: row.cert_serial,
            kya_id: row.kya_id,
            revoked_at: row.revoked_at,
            revoked_by: row.revoked_by,
            revocation_reason: row.revocation_reason,
            revocation_category: row.revocation_category,
            revocation_hash: row.revocation_hash,
            anchor: {
                epoch_id: row.epoch_id,
                epoch_label: row.epoch_label,
                merkle_root: row.merkle_root,
                merkle_leaf_index: row.merkle_leaf_index,
                merkle_proof: row.merkle_proof,
                bitcoin_txid: row.bitcoin_txid,
                block_height: row.block_height,
                block_hash: row.block_hash,
                confirmed_at: row.confirmed_at,
                confirmations: row.confirmations,
                anchor_status: row.anchor_status,
                signed_by_role: row.crl_signed_by_role,
                signed_by_pubkey: row.crl_signed_by_pubkey,
                signature_hex: row.crl_signature_hex,
                verification_url: row.bitcoin_txid ? `https://mempool.space/tx/${row.bitcoin_txid}` : null,
                signed_crl_file_url: `/crl/${(row.epoch_label || '').toLowerCase()}.json`,
            },
            // Self-contained verifier instructions
            verifier_recipe: {
                'leaf_hash_input': `${row.cert_serial}|${row.kya_id}|${(new Date(row.revoked_at)).toISOString()}|${(row.revocation_reason || '').slice(0, 500)}`,
                'leaf_hash_algorithm': 'sha256-hex',
                'proof_fold': "running=leaf; for s in proof: running = s.pos==='left' ? sha256(s.hash || running) : sha256(running || s.hash)",
                'expected_root': row.merkle_root,
                'on_chain_magic': 'KYAR (0x4B594152) + 32B Merkle root in OP_RETURN',
            },
        });
    } catch (err) {
        logger.error({ err: err.message, serial }, '/api/crl/proof FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/crl/epoch/:epoch_id — full epoch dump (Merkle tree + all leaves)
app.get('/api/crl/epoch/:epoch_id', async (req, res) => {
    _publicCors(req, res);
    const epoch_id = parseInt(req.params.epoch_id, 10);
    if (!Number.isFinite(epoch_id) || epoch_id < 0) {
        return res.status(400).json({ error: 'INVALID_EPOCH_ID' });
    }
    try {
        const ar = await pool.query(
            `SELECT id, epoch_id, epoch_label, merkle_root, leaf_count, op_return_hex,
                    status, bitcoin_txid, fee_sats, broadcast_at, confirmed_at,
                    block_height, block_hash, confirmations, tree_snapshot,
                    crl_signature_hex, crl_signed_by_role, crl_signed_by_pubkey
             FROM crl_anchors WHERE epoch_id = $1`,
            [epoch_id]
        );
        if (ar.rowCount === 0) return res.status(404).json({ error: 'EPOCH_NOT_FOUND' });
        const a = ar.rows[0];
        const rr = await pool.query(
            `SELECT cert_serial, kya_id, revoked_at, revoked_by, revocation_reason,
                    revocation_category, revocation_hash, merkle_leaf_index, merkle_proof
             FROM revocation_events
             WHERE crl_anchor_id = $1
             ORDER BY merkle_leaf_index ASC`,
            [a.id]
        );
        const sf = await pool.query(
            `SELECT epoch_label, file_path, file_sha256, file_size_bytes,
                    signed_by_role, signed_by_pubkey, signature_hex, generated_at
             FROM crl_signed_files WHERE epoch_id = $1`,
            [epoch_id]
        );
        res.json({
            anchor: _serializeCrlAnchor(a),
            op_return_hex: a.op_return_hex,
            tree_snapshot: a.tree_snapshot,
            revocations: rr.rows,
            signed_file: sf.rowCount > 0 ? {
                ...sf.rows[0],
                url: `/crl/${(a.epoch_label || '').toLowerCase()}.json`,
            } : null,
            verifier_recipe: {
                op_return_payload_format: '4B "KYAR" magic (4b594152) || 32B Merkle root',
                merkle_root: a.merkle_root,
                root_check: 'Re-build Merkle tree from revocations.revocation_hash[*] in leaf-index order; root MUST equal anchor.merkle_root.',
                on_chain_check: a.bitcoin_txid
                    ? `Fetch tx ${a.bitcoin_txid} from any Bitcoin explorer; extract OP_RETURN; assert magic=4b594152 and payload[4:36] === merkle_root.`
                    : 'Not yet anchored on-chain.',
            },
        });
    } catch (err) {
        logger.error({ err: err.message, epoch_id }, '/api/crl/epoch FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// GET /api/crl/anchors — paginated list of CRL anchors (audit / monitoring)
app.get('/api/crl/anchors', async (req, res) => {
    _publicCors(req, res);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    try {
        const r = await pool.query(
            `SELECT id, epoch_id, epoch_label, merkle_root, leaf_count, status,
                    bitcoin_txid, fee_sats, broadcast_at, confirmed_at,
                    block_height, block_hash, confirmations,
                    crl_signature_hex, crl_signed_by_role, crl_signed_by_pubkey,
                    created_at
             FROM crl_anchors
             ORDER BY epoch_id DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        const total = await pool.query(`SELECT COUNT(*)::int AS c FROM crl_anchors`);
        res.json({
            count: r.rowCount,
            total: total.rows[0].c,
            limit, offset,
            anchors: r.rows.map(_serializeCrlAnchor),
        });
    } catch (err) {
        logger.error({ err: err.message }, '/api/crl/anchors FAIL');
        res.status(500).json({ error: 'DB_ERROR' });
    }
});

// Admin: force CRL anchor NOW (bypasses 24h schedule).
// Same opt-in gate as anchor worker: with ANCHOR_WORKER_BROADCAST_ENABLED-equivalent
// flag CRL_WORKER_BROADCAST_ENABLED. If broadcast=true and flag isn't set,
// returns 403 (defense in depth — admin cannot accidentally fire from UI).
app.post('/api/admin/crl/anchor-now', security.adminAuth, async (req, res) => {
    const wantBroadcast = !!(req.body && req.body.broadcast);
    if (wantBroadcast && process.env.CRL_WORKER_BROADCAST_ENABLED !== 'true') {
        return res.status(403).json({
            error: 'BROADCAST_GATED',
            message: 'CRL_WORKER_BROADCAST_ENABLED must be "true" in .env (and worker restarted) before admin can force a live broadcast.',
        });
    }
    try {
        // Shell out to the worker to keep all CRL-anchor logic in one file.
        const { spawnSync } = require('child_process');
        const argv = ['scripts/crl-worker.js', '--once'];
        if (!wantBroadcast) argv.push('--dry-run');
        if (req.body && req.body.force) argv.push('--force');
        const r = spawnSync('node', argv, {
            cwd: __dirname, encoding: 'utf-8',
            timeout: 120000,
            env: { ...process.env, CRL_WORKER_BROADCAST_ENABLED: wantBroadcast ? 'true' : 'false' },
        });
        if (r.status !== 0) {
            return res.status(500).json({
                error: 'CRL_WORKER_FAIL',
                exit_code: r.status,
                stdout_tail: (r.stdout || '').split('\n').slice(-10).join('\n'),
                stderr_tail: (r.stderr || '').split('\n').slice(-10).join('\n'),
            });
        }
        // Parse last JSON line (pino) for the result
        const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
        let lastResult = null;
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const j = JSON.parse(lines[i]);
                if (j.result || j.msg === 'one-shot anchor done') { lastResult = j.result || j; break; }
            } catch (_) {}
        }
        res.json({
            triggered: true,
            broadcast: wantBroadcast,
            worker_result: lastResult,
            stdout_tail: lines.slice(-3),
        });
    } catch (e) {
        logger.error({ err: e.message }, 'force CRL anchor FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// PHASE 4B: Manufacturer Onboarding API
// ----------------------------------------------------------------------------
// Public:
//   GET  /api/manufacturers                           — list verified mfrs
//   GET  /api/manufacturer/:manufacturer_id           — public mfr info
//   POST /api/manufacturer/attestation                — mfr submits signed
//                                                        pre-attestation for an
//                                                        agent manifest
// Admin (X-Admin-Key):
//   POST /api/admin/manufacturer/register             — create PENDING mfr
//   POST /api/admin/manufacturer/:mid/verify          — promote to VERIFIED
//   POST /api/admin/manufacturer/:mid/suspend         — suspend
//   POST /api/admin/manufacturer/:mid/revoke          — permanent revoke
//   POST /api/admin/manufacturer/attestation/:id/revoke — revoke a single attestation
//   GET  /api/admin/manufacturer/:mid/attestations    — admin listing (incl. raw)
// ----------------------------------------------------------------------------

// --- Public listing of verified manufacturers --------------------------------
app.get('/api/manufacturers', async (req, res) => {
    _publicCors(req, res);
    try {
        const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
        const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
        const out = await manufacturer.listVerified(pool, { limit, offset });
        res.json(out);
    } catch (e) {
        logger.error({ err: e.message }, 'GET /api/manufacturers FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Public single-manufacturer lookup ---------------------------------------
app.get('/api/manufacturer/:manufacturer_id', async (req, res) => {
    _publicCors(req, res);
    try {
        const m = await manufacturer.lookupByExtId(pool, req.params.manufacturer_id);
        if (!m) return res.status(404).json({ error: 'NOT_FOUND' });
        // Hide PENDING/REVOKED/SUSPENDED from public unless admin
        const adminOk = _adminBypass(req);
        if (!adminOk && m.status !== 'VERIFIED') {
            return res.status(404).json({ error: 'NOT_FOUND' });
        }
        res.json(adminOk
            ? manufacturer.serializeMfrAdmin(m)
            : manufacturer.serializeMfrPublic(m)
        );
    } catch (e) {
        logger.error({ err: e.message }, 'GET /api/manufacturer/:id FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Public attestation submission -------------------------------------------
// Manufacturer submits a signed Ed25519 attestation for an agent manifest.
// The mfr does NOT need a KYA-Hub session; we authenticate them by verifying
// the Ed25519 signature against their registered pubkey.
app.post('/api/manufacturer/attestation', mfrAttestLimiter, async (req, res) => {
    _publicCors(req, res);
    try {
        const body = req.body || {};
        const input = {
            manufacturer_id: body.manufacturer_id,
            manifest: body.manifest,
            mfr_signature: body.mfr_signature || body.signature,
            expected_agent_pubkey: body.expected_agent_pubkey || null,
            expected_agent_name: body.expected_agent_name || null,
            attestation_metadata: body.attestation_metadata || null,
            expires_at: body.expires_at || null,
        };
        const r = await manufacturer.submitAttestation(pool, input);
        if (r.error) {
            if (r.error === 'MFR_RATE_LIMITED') {
                if (Number.isFinite(r.retry_after_seconds) && r.retry_after_seconds > 0) {
                    res.set('Retry-After', String(r.retry_after_seconds));
                }
                return res.status(429).json(r);
            }
            const code = (r.error === 'MANUFACTURER_NOT_FOUND') ? 404
                       : (r.error === 'MANUFACTURER_NOT_VERIFIED') ? 403
                       : (r.error === 'BAD_MFR_SIGNATURE') ? 401
                       : (r.error === 'ATTESTATION_METADATA_TOO_LARGE'
                          || r.error === 'MANIFEST_METADATA_TOO_LARGE') ? 413
                       : 400;
            return res.status(code).json(httpPublicError.sanitizeLibError(r));
        }
        logger.info({
            manufacturer_id: r.manufacturer_id,
            manifest_hash: r.manifest_hash,
            attestation_id: r.attestation_id,
        }, 'mfr attestation submitted');
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message, stack: (e.stack || '').slice(0, 500) },
            'POST /api/manufacturer/attestation FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: register a new manufacturer --------------------------------------
app.post('/api/admin/manufacturer/register', security.adminAuth, async (req, res) => {
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const b = req.body || {};
        const r = await manufacturer.registerMfr(pool, {
            manufacturer_id: b.manufacturer_id,
            name: b.name,
            pubkey: b.pubkey,
            legal_entity: b.legal_entity,
            country: b.country,
            contact_email: b.contact_email,
            homepage: b.homepage,
            description: b.description,
            tier: b.tier,
            kyc_metadata: b.kyc_metadata,
            admin_user,
            client_ip: req.ip,
        });
        if (r.error) return res.status(400).json(r);
        logger.info({
            manufacturer_id: r.manufacturer.manufacturer_id,
            tier: r.manufacturer.tier, admin: admin_user,
        }, 'mfr registered');
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message }, 'POST /api/admin/manufacturer/register FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: verify a PENDING manufacturer ------------------------------------
app.post('/api/admin/manufacturer/:manufacturer_id/verify', security.adminAuth, async (req, res) => {
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const b = req.body || {};
        const r = await manufacturer.verifyMfr(pool, {
            manufacturer_id: req.params.manufacturer_id,
            admin_user,
            tier_override: b.tier,
            kyc_metadata: b.kyc_metadata,
        });
        if (r.error) {
            return res.status(r.error === 'MANUFACTURER_NOT_FOUND' ? 404 : 400).json(r);
        }
        logger.info({
            manufacturer_id: req.params.manufacturer_id,
            tier: r.manufacturer.tier, admin: admin_user,
        }, 'mfr verified');
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message }, 'mfr verify FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: suspend a manufacturer (reversible) ------------------------------
app.post('/api/admin/manufacturer/:manufacturer_id/suspend', security.adminAuth, async (req, res) => {
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const b = req.body || {};
        const r = await manufacturer.suspendMfr(pool, {
            manufacturer_id: req.params.manufacturer_id,
            admin_user, reason: b.reason,
        });
        if (r.error) {
            return res.status(r.error === 'MANUFACTURER_NOT_FOUND' ? 404 : 400).json(r);
        }
        logger.warn({
            manufacturer_id: req.params.manufacturer_id,
            reason: b.reason, admin: admin_user,
        }, 'mfr SUSPENDED');
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message }, 'mfr suspend FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: revoke a manufacturer (irreversible) -----------------------------
app.post('/api/admin/manufacturer/:manufacturer_id/revoke', security.adminAuth, async (req, res) => {
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const b = req.body || {};
        const r = await manufacturer.revokeMfr(pool, {
            manufacturer_id: req.params.manufacturer_id,
            admin_user, reason: b.reason,
        });
        if (r.error) {
            return res.status(r.error === 'MANUFACTURER_NOT_FOUND' ? 404 : 400).json(r);
        }
        logger.warn({
            manufacturer_id: req.params.manufacturer_id,
            reason: b.reason, admin: admin_user,
        }, 'mfr REVOKED');
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message }, 'mfr revoke FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: revoke a single attestation --------------------------------------
app.post('/api/admin/manufacturer/attestation/:id/revoke', security.adminAuth, async (req, res) => {
    const admin_user = req.headers['x-admin-user'] || 'admin';
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'INVALID_ID' });
        const b = req.body || {};
        const r = await manufacturer.revokeAttestation(pool, {
            attestation_id: id,
            revoked_by: admin_user,
            reason: b.reason,
        });
        if (r.error) return res.status(404).json(r);
        res.json(r);
    } catch (e) {
        logger.error({ err: e.message }, 'attestation revoke FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// --- Admin: list a manufacturer's attestations -------------------------------
app.get('/api/admin/manufacturer/:manufacturer_id/attestations', security.adminAuth, async (req, res) => {
    try {
        const m = await manufacturer.lookupByExtId(pool, req.params.manufacturer_id);
        if (!m) return res.status(404).json({ error: 'NOT_FOUND' });
        const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
        const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
        const rows = await pool.query(
            `SELECT id, agent_manifest_hash, expected_agent_pubkey, expected_agent_name,
                    attestation_metadata, attested_at, expires_at,
                    agent_id, consumed_at, revoked_at, revoked_by, revoke_reason
             FROM manufacturer_attestations
             WHERE manufacturer_id = $1
             ORDER BY attested_at DESC
             LIMIT $2 OFFSET $3`,
            [m.id, limit, offset]
        );
        const total = await pool.query(
            `SELECT COUNT(*)::int AS c FROM manufacturer_attestations WHERE manufacturer_id = $1`,
            [m.id]
        );
        res.json({
            manufacturer: manufacturer.serializeMfrAdmin(m),
            count: rows.rowCount,
            total: total.rows[0].c,
            limit, offset,
            attestations: rows.rows.map((r) => ({
                ...r,
                id: Number(r.id),
                agent_id: r.agent_id != null ? Number(r.agent_id) : null,
            })),
        });
    } catch (e) {
        logger.error({ err: e.message }, 'admin mfr attestations FAIL');
        res.status(500).json({ error: 'INTERNAL' });
    }
});

// ----------------------------------------------------------------------------
// Static serving for signed CRL JSON files (Phase 5b offline-cacheable CRL).
// nginx can also serve /crl/ directly from /root/kya-hub/public/crl/ — this
// Express handler is a backup so the app works even without nginx config.
// ----------------------------------------------------------------------------
app.use('/crl', (req, res, next) => {
    _publicCors(req, res);
    res.set('Cache-Control', 'public, max-age=300');
    next();
}, express.static(__dirname + '/public/crl', {
    extensions: ['json'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.json')) {
            res.set('Content-Type', 'application/json; charset=utf-8');
        }
    },
}));

// ----------------------------------------------------------------------------
// Error handlers
// ----------------------------------------------------------------------------
app.use((err, req, res, _next) => {
    // Capture into Sentry if enabled (and still return our fixed 500 shape).
    sentry.captureException(err, { route: req?.path, method: req?.method });
    const eh = sentry.errorHandler();
    if (eh) {
        // Let Sentry enrich the event with the express request context.
        // Then fall through to our own response.
        try { eh(err, req, res, () => {}); } catch (_) {}
    }
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    res.status(500).json({ error: 'INTERNAL' });
});

process.on('uncaughtException', (err) => {
    sentry.captureException(err, { kind: 'uncaughtException' });
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
    logger.error({ reason: String(reason) }, 'unhandledRejection');
});

// ----------------------------------------------------------------------------
// Štart
// ----------------------------------------------------------------------------
async function start() {
    // Alby connect (best effort)
    if (alby.isConfigured()) {
        try {
            await alby.connect(logger);
            // Listener na payment_received notifikácie
            alby.onSettled(async (event) => {
                const log = logger.child({ source: 'alby-nwc' });
                try {
                    let meta = event.metadata || {};
                    if (typeof meta === 'string') {
                        try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
                    }

                    if (meta.eliteListingPayment === 'heartbeat' || meta.eliteListingPayment === 'reactivation') {
                        const isNew = await recordWebhookDelivery({
                            source: 'alby-nwc',
                            deliveryId: event.paymentHash,
                            invoiceId: event.paymentHash,
                            eventType: 'payment_received',
                            payloadHash: crypto.createHash('sha256').update(`${event.paymentHash}:elite_listing`).digest('hex'),
                            agentTier: 'ELITE',
                        });
                        if (!isNew) {
                            log.info({ paymentHash: event.paymentHash }, 'duplicate elite listing payment, skipping');
                            return;
                        }
                        const settled = await eliteListing.handlePaymentSettled(pool, {
                            invoiceId: event.paymentHash,
                            paymentHash: event.paymentHash,
                            amountSats: event.amountSats,
                            metadata: meta,
                            source: 'alby-nwc',
                            logger: log,
                        });
                        await markWebhookProcessed({
                            source: 'alby-nwc',
                            deliveryId: event.paymentHash,
                            success: !!settled.ok,
                            message: settled.duplicate ? 'elite_listing_dup' : 'elite_listing',
                        });
                        return;
                    }

                    // Phase 1.5: ak má registrationId, vyzdvihni validated intent
                    let intent = null;
                    if (meta.registrationId) {
                        const r = await pool.query(
                            `SELECT * FROM registration_intents WHERE registration_id = $1 AND status = 'PENDING_PAYMENT'`,
                            [meta.registrationId]
                        );
                        if (r.rowCount > 0) intent = r.rows[0];
                    }
                    
                    const effAgentName = intent ? intent.agent_name : meta.agentName;
                    const effPubkey = intent ? intent.agent_pubkey : meta.pubkey;
                    const effManifest = intent ? intent.manifest : meta.manifest;
                    const effAmount = intent
                        ? (intent.tier_requested === 'ELITE' ? TIERS.ELITE.total : TIERS.BASIC.total)
                        : (meta.amount || event.amountSats);
                    
                    if (!effAgentName) {
                        log.warn({ paymentHash: event.paymentHash }, 'platba bez agentName — preskakujem');
                        return;
                    }
                    const tier = getTierByAmount(effAmount);
                    if (!tier) {
                        log.warn({ amount: effAmount }, 'platba s neznámym tierom — preskakujem');
                        return;
                    }
                    
                    // Idempotency cez webhook_deliveries (paymentHash ako delivery_id)
                    const isNew = await recordWebhookDelivery({
                        source: 'alby-nwc',
                        deliveryId: event.paymentHash,
                        invoiceId: event.paymentHash,
                        eventType: 'payment_received',
                        payloadHash: crypto.createHash('sha256').update(event.paymentHash + ':' + event.amountSats).digest('hex'),
                        agentTier: tier.name,
                    });
                    if (!isNew) {
                        log.info({ paymentHash: event.paymentHash }, 'duplicate notification, skipping');
                        return;
                    }
                    
                    // Phase 4 (P4-5): ELITE platby sa logujú s vyššou prioritou.
                    if (tier.name === 'ELITE') {
                        log.info({ paymentHash: event.paymentHash, priority: 9 }, 'ELITE payment — priority processing');
                    }

                    const result = await registerAgent({
                        tier,
                        agentName: effAgentName,
                        pubkey: effPubkey,
                        manifest: effManifest,
                        paymentMethod: 'lightning',
                        invoiceId: event.paymentHash,
                        amountSats: event.amountSats,
                        registrationIntent: intent,
                    });

                    // Strategic Sprint §31 C — PDF invoice (fire-and-forget).
                    if (!result.duplicate && result.axisId) {
                        try {
                            const ag = await pool.query(
                                'SELECT id, kya_id, agent_name, tier, anchor_txid FROM agents WHERE kya_id = $1',
                                [result.axisId]);
                            if (ag.rowCount > 0) {
                                invoicePdf.issueForPayment(pool, {
                                    agent: ag.rows[0],
                                    paymentMethod: 'lightning',
                                    amountSats: event.amountSats,
                                    paymentHash: event.paymentHash,
                                    paymentPreimage: event.preimage,
                                    paidAt: new Date(),
                                    logger: log,
                                }).catch(e => log.warn({ err: e.message, kya_id: result.axisId },
                                    'invoice PDF issue FAIL (non-fatal)'));
                            }
                        } catch (e) {
                            log.warn({ err: e.message }, 'invoice PDF lookup FAIL (non-fatal)');
                        }
                    }

                    await markWebhookProcessed({
                        source: 'alby-nwc',
                        deliveryId: event.paymentHash,
                        success: true,
                        message: result.duplicate ? 'duplicate' : `created ${result.axisId}`,
                    });
                } catch (err) {
                    log.error({ err: err.message, paymentHash: event.paymentHash }, 'registerAgent FAIL');
                    await markWebhookProcessed({
                        source: 'alby-nwc',
                        deliveryId: event.paymentHash,
                        success: false,
                        message: err.message,
                    });
                }
            });
            // Subscriptions
            await alby.startSubscriptions(logger);
        } catch (err) {
            logger.warn({ err: err.message }, 'Alby connect FAIL — pokračujem bez Alby integrácie');
        }
    }
    
    // Phase 2.3: napoj audit pool a synchronizuj hub_keys s DB
    hubkeys.setAuditPool(pool, logger);
    try {
        const syncRes = await hubkeys.store.syncWithDb(pool, logger);
        logger.info({
            loaded: syncRes.loaded.map(k => ({ keyId: k.keyId, role: k.role, source: k.source })),
            errors: syncRes.errors,
        }, 'hub_keys DB sync done');
    } catch (e) {
        logger.error({ err: e.message }, 'hub_keys DB sync failed (continuing)');
    }
    
    // Phase 2.4: init dynamic pricing (hot-reload tier_pricing tabuľka)
    try {
        await pricing.init(pool, logger);
    } catch (e) {
        logger.error({ err: e.message }, 'pricing init failed — používam env fallback');
    }
    
    // Phase 2.3: file perm watcher (chmod 600 na .env)
    if (process.env.FILE_PERM_WATCHER !== 'false') {
        filePermWatcher.start({
            logger,
            files: ['.env'],
            basePath: __dirname,
            intervalMs: 60 * 1000,
            strict: process.env.FILE_PERM_STRICT === 'true',
            autoFix: process.env.FILE_PERM_AUTOFIX === 'true',
        });
    }
    
    // Strategic Sprint §31 E P0-1 — bind kya-hub to 127.0.0.1 ONLY. The hub
    // sits behind nginx (443 with rate-limits + body-size cap + slowloris). A
    // public bind on 0.0.0.0 lets attackers bypass nginx entirely. Operator can
    // override via BIND_ADDR=0.0.0.0 if they truly want to skip nginx (do not).
    const bindAddr = process.env.BIND_ADDR || '127.0.0.1';
    app.listen(cfg.PORT, bindAddr, () => {
        logger.info({
            port: cfg.PORT,
            bind_addr: bindAddr,
            env: cfg.NODE_ENV,
            tiers: { BASIC: TIERS.BASIC.total, ELITE: TIERS.ELITE.total },
            alby: alby.isConfigured() ? (alby.isConnected() ? 'connected' : 'configured-but-disconnected') : 'not-configured',
            db_user: cfg.DB.user,
            pow_enabled: pow.CFG.ENABLED,
            pow_required_for: pow.CFG.REQUIRED_FOR,
        }, 'UMBRAXON KYA-Hub ONLINE');
        
        // Phase 2.2: spusti background refresh ban cache (60s interval)
        abuseTracker.startCacheRefresh(pool, logger);
        
        // Spusti decay worker (Phase 2). Beží v rovnakom procese, žiadny externý cron.
        // Pre vypnutie nastav DECAY_WORKER_ENABLED=false v .env (default: ON)
        if (process.env.DECAY_WORKER_ENABLED !== 'false') {
            decayWorker.start(logger, pool);
        } else {
            logger.warn('decay worker DISABLED (DECAY_WORKER_ENABLED=false)');
        }

        // /api/health snapshot probe loop (§32 hardening — was per-request,
        // now cached on HEALTH_PROBE_INTERVAL_MS so /api/health no longer
        // amplifies traffic against the BTCPay upstream).
        _runHealthProbe().catch(() => {});
        _startHealthProbeLoop();

        // Phase 2.4 follow-up: periodic upstream health monitor (DB + BTCPay).
        // Pri zlyhaní pošle Telegram alert, pri obnove "recovered". Dedupe je
        // riešený v lib/notifications.js (5 min default).
        const HEALTH_MONITOR_MS = parseInt(process.env.HEALTH_MONITOR_INTERVAL_MS || '60000', 10);
        let dbHealthy = true;
        let btcpayHealthy = true;
        setInterval(async () => {
            // DB
            try {
                await pool.query('SELECT 1');
                if (!dbHealthy) {
                    dbHealthy = true;
                    notifications.notify({
                        category: 'info', title: 'Database recovered',
                        body: 'connectivity restored', dedupe_key: 'db_recovered',
                    }).catch(() => {});
                }
            } catch (e) {
                if (dbHealthy) {
                    dbHealthy = false;
                    notifications.notifyDbDown({ error: e.message }).catch(() => {});
                }
            }
            // BTCPay (best-effort, low frequency)
            try {
                await axios.get(
                    `${cfg.BTCPAY_URL}/api/v1/stores/${cfg.BTCPAY_STORE_ID}/invoices?take=1`,
                    { headers: { 'Authorization': `token ${cfg.BTCPAY_API_KEY}` }, timeout: 5000, proxy: false }
                );
                if (!btcpayHealthy) {
                    btcpayHealthy = true;
                    notifications.notify({
                        category: 'info', title: 'BTCPay recovered',
                        body: 'upstream restored', dedupe_key: 'btcpay_recovered',
                    }).catch(() => {});
                }
            } catch (e) {
                if (btcpayHealthy) {
                    btcpayHealthy = false;
                    notifications.notifyBtcpayOutage({
                        error: e.message,
                        httpStatus: e.response ? e.response.status : null,
                    }).catch(() => {});
                }
            }
        }, HEALTH_MONITOR_MS).unref();
    });
}

start().catch(err => {
    logger.fatal({ err: err.message }, 'Startup FAIL');
    process.exit(1);
});
