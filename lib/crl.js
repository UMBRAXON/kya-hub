// ============================================================================
// UMBRAXON KYA-Hub — Phase 5 / CRL Merkle Transparency Library
// ----------------------------------------------------------------------------
// Helpers for building a Merkle tree over revocation_hash leaves, producing
// per-leaf inclusion proofs, building an OP_RETURN payload ("KYAR" magic +
// 32-byte Merkle root), and signing the daily CRL JSON file with the ROOT
// hub key.
//
// Design choices (locked):
//
// - Leaf hash format: sha256(`${cert_serial}|${kya_id}|${revoked_at_iso}|${revoke_reason}`)
//   Encoded with PostgreSQL `digest('sha256')` in the backfill SQL so that
//   migration 009 backfill and live Node code produce IDENTICAL leaves.
//   Reason format is left-trimmed/right-truncated to 500 chars (matches
//   migration's `LEFT(revoke_reason, 500)`).
//
// - Tree construction: classic Merkle of SHA-256 leaves with single-leaf
//   duplication for odd-sized levels (Bitcoin-style). Empty tree → root =
//   sha256("KYAR_EMPTY_CRL") sentinel so we still have a 32-byte payload
//   for "no revocations this epoch" anchors (kept as an option; default
//   behavior is to SKIP anchoring epochs with zero new revocations).
//
// - Proof format: array of { pos: 'left'|'right', hash: hex } from leaf
//   toward the root. Verifier folds with `pos` semantics:
//     pos=left  → new = sha256(sibling || running)
//     pos=right → new = sha256(running || sibling)
//
// - OP_RETURN payload: 4-byte magic "KYAR" (0x4B594152) followed by 32-byte
//   Merkle root. Total 36 B, identical envelope size to KYA1. Decoder shares
//   the same parseOpReturnHex code in lib/anchor.js (different magic only).
//
// - CRL JSON signing: canonical-sorted JSON, sha256 digest, ROOT key Ed25519
//   signature. Verifier uses hubkeys.verify() with ROOT pubkey (offline).
// ============================================================================
'use strict';

const crypto = require('crypto');

const hubkeys = require('./hubkeys');

// 4-byte magic for CRL anchors: ASCII "KYAR" = 0x4B 0x59 0x41 0x52
const CRL_MAGIC_HEX = '4b594152';

const EMPTY_ROOT = sha256Hex(Buffer.from('KYAR_EMPTY_CRL'));

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Concat(aHex, bHex) {
    const h = crypto.createHash('sha256');
    h.update(Buffer.from(aHex, 'hex'));
    h.update(Buffer.from(bHex, 'hex'));
    return h.digest('hex');
}

/**
 * Canonicalize revoked_at timestamp into the exact same string that
 * PostgreSQL's `TO_CHAR(revoked_at AT TIME ZONE 'UTC',
 * 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` produces. That format gives ISO 8601
 * UTC with millisecond precision and a trailing Z, e.g.
 * "2026-05-12T07:42:13.123Z" — same shape as JS `new Date(...).toISOString()`.
 *
 * @param {Date|string|number} d
 * @returns {string} ISO-ms-Z string (zero-padded ms)
 */
function canonicalIsoMs(d) {
    let dt;
    if (d instanceof Date) dt = d;
    else if (typeof d === 'number') dt = new Date(d);
    else if (typeof d === 'string') dt = new Date(d);
    else throw new Error('canonicalIsoMs: invalid date input');
    if (!Number.isFinite(dt.getTime())) throw new Error('canonicalIsoMs: invalid date value');
    // Both JS Date.toISOString and Postgres MS format yield ms-precision UTC.
    // JS toISOString gives "...nnnZ" already with 3-digit ms padding, so we
    // can use it directly.
    return dt.toISOString();
}

/**
 * Compute the canonical leaf hash for a revocation. Must match the SQL
 * backfill in migration 009 exactly (cf. ENCODE(DIGEST('serial|kya|iso|reason', 'sha256'), 'hex')).
 *
 * @param {object} input
 *   - cert_serial: string
 *   - kya_id: string
 *   - revoked_at: Date|string|number
 *   - revocation_reason: string|null
 * @returns {string} 64-char hex sha256
 */
function computeRevocationHash({ cert_serial, kya_id, revoked_at, revocation_reason }) {
    if (!cert_serial || !kya_id) throw new Error('computeRevocationHash: cert_serial and kya_id required');
    const iso = canonicalIsoMs(revoked_at || new Date());
    // Match Postgres LEFT(revoke_reason, 500) trimming and COALESCE('') → empty.
    const reason = (revocation_reason == null) ? '' : String(revocation_reason).slice(0, 500);
    const payload = `${cert_serial}|${kya_id}|${iso}|${reason}`;
    return sha256Hex(Buffer.from(payload, 'utf8'));
}

// ----------------------------------------------------------------------------
// Merkle tree construction
// ----------------------------------------------------------------------------
/**
 * Build a Merkle tree from leaf hashes. Returns the full level array so
 * proofs can be extracted for any leaf in O(log n).
 *
 * Behaviour:
 *   leaves.length === 0 → root = EMPTY_ROOT, levels = [[EMPTY_ROOT]]
 *   leaves.length === 1 → root = leaves[0], levels = [[leaves[0]]]
 *   odd-length level    → last leaf is duplicated (Bitcoin-style)
 *
 * @param {string[]} leaves - 64-char hex sha256 strings, in insertion order
 * @returns {{root: string, levels: string[][], leafCount: number}}
 */
function buildMerkleTree(leaves) {
    if (!Array.isArray(leaves)) throw new Error('buildMerkleTree: leaves must be array');
    leaves.forEach((h, i) => {
        if (!/^[0-9a-f]{64}$/.test(h)) {
            throw new Error(`buildMerkleTree: leaf[${i}] is not 32B hex: ${h}`);
        }
    });

    if (leaves.length === 0) {
        return { root: EMPTY_ROOT, levels: [[EMPTY_ROOT]], leafCount: 0 };
    }
    if (leaves.length === 1) {
        return { root: leaves[0], levels: [leaves.slice()], leafCount: 1 };
    }

    const levels = [leaves.slice()];
    let cur = leaves.slice();
    while (cur.length > 1) {
        const next = [];
        for (let i = 0; i < cur.length; i += 2) {
            const left = cur[i];
            const right = (i + 1 < cur.length) ? cur[i + 1] : cur[i]; // duplicate last on odd
            next.push(sha256Concat(left, right));
        }
        levels.push(next);
        cur = next;
    }
    return { root: cur[0], levels, leafCount: leaves.length };
}

/**
 * Extract inclusion proof for `leafIndex` (0-based) from a tree built by
 * buildMerkleTree(). Proof is an array of { pos, hash } objects, from
 * adjacent-to-leaf upward to one below root.
 *
 * Verifier code:
 *   let running = leafHash;
 *   for (const step of proof) {
 *     running = step.pos === 'left'
 *       ? sha256(step.hash || running)
 *       : sha256(running || step.hash);
 *   }
 *   return running === root;
 *
 * @param {{levels: string[][]}} tree
 * @param {number} leafIndex
 * @returns {{leaf: string, leafIndex: number, proof: Array<{pos:'left'|'right', hash:string}>, root: string}}
 */
function buildProof(tree, leafIndex) {
    if (!tree || !Array.isArray(tree.levels) || tree.levels.length === 0) {
        throw new Error('buildProof: invalid tree');
    }
    if (leafIndex < 0 || leafIndex >= tree.levels[0].length) {
        throw new Error(`buildProof: leafIndex out of range (0..${tree.levels[0].length - 1})`);
    }
    const leaves = tree.levels[0];
    const leaf = leaves[leafIndex];
    const proof = [];
    let idx = leafIndex;
    for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
        const level = tree.levels[lvl];
        const isRight = (idx % 2) === 1;
        const siblingIdx = isRight ? (idx - 1) : (idx + 1);
        // Sibling may be the same as self when level had odd count
        const sibling = (siblingIdx < level.length) ? level[siblingIdx] : level[idx];
        proof.push({
            pos: isRight ? 'left' : 'right', // sibling's position relative to running
            hash: sibling,
        });
        idx = Math.floor(idx / 2);
    }
    return {
        leaf,
        leafIndex,
        proof,
        root: tree.levels[tree.levels.length - 1][0],
    };
}

/**
 * Pure verifier — recompute root from a leaf hash + proof and compare.
 * Safe to call from offline relying parties.
 *
 * @param {string} leafHash
 * @param {Array<{pos:'left'|'right', hash:string}>} proof
 * @param {string} expectedRoot
 * @returns {boolean}
 */
function verifyProof(leafHash, proof, expectedRoot) {
    if (!/^[0-9a-f]{64}$/.test(leafHash)) return false;
    if (!Array.isArray(proof)) return false;
    if (!/^[0-9a-f]{64}$/.test(expectedRoot)) return false;
    let running = leafHash;
    for (const step of proof) {
        if (!step || (step.pos !== 'left' && step.pos !== 'right')) return false;
        if (!/^[0-9a-f]{64}$/.test(step.hash)) return false;
        running = step.pos === 'left'
            ? sha256Concat(step.hash, running)
            : sha256Concat(running, step.hash);
    }
    return running === expectedRoot;
}

// ----------------------------------------------------------------------------
// OP_RETURN payload
// ----------------------------------------------------------------------------
/**
 * 36-byte OP_RETURN payload: 4B KYAR magic || 32B Merkle root.
 * @param {string} merkleRootHex 64-char hex
 * @returns {string} 72-char hex
 */
function buildCrlOpReturnPayload(merkleRootHex) {
    if (!/^[0-9a-f]{64}$/.test(merkleRootHex)) {
        throw new Error('buildCrlOpReturnPayload: merkleRootHex must be 32B hex');
    }
    return CRL_MAGIC_HEX + merkleRootHex;
}

/**
 * Parse OP_RETURN scriptPubKey hex looking for KYAR magic. Returns null if
 * not a KYAR anchor. Same push-opcode handling as lib/anchor.js parseOpReturnHex.
 */
function parseCrlOpReturnHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const h = hex.toLowerCase();
    if (!h.startsWith('6a')) return null;
    let i = 2;
    if (h.length < i + 2) return null;
    const opByte = parseInt(h.slice(i, i + 2), 16);
    i += 2;
    let payloadLen;
    if (opByte >= 0x01 && opByte <= 0x4b) payloadLen = opByte;
    else if (opByte === 0x4c) { payloadLen = parseInt(h.slice(i, i + 2), 16); i += 2; }
    else if (opByte === 0x4d) { payloadLen = parseInt(h.slice(i + 2, i + 4) + h.slice(i, i + 2), 16); i += 4; }
    else return null;
    const payload = h.slice(i, i + payloadLen * 2);
    if (payload.length !== payloadLen * 2) return null;
    if (payload.length !== 72) return null;
    const magic = payload.slice(0, 8);
    if (magic !== CRL_MAGIC_HEX) return null;
    return { magic, merkleRoot: payload.slice(8), raw: payload, format: 'KYAR' };
}

// ----------------------------------------------------------------------------
// Epoch helpers (unix-day UTC)
// ----------------------------------------------------------------------------
const SECONDS_PER_DAY = 86400;

/**
 * Returns the unix-day (UTC) for the given date. Used as epoch_id.
 * E.g. 2026-05-12T14:00:00Z → 20585.
 */
function epochIdFor(date) {
    const d = (date instanceof Date) ? date : new Date(date || Date.now());
    return Math.floor(d.getTime() / 1000 / SECONDS_PER_DAY);
}

function epochLabelFor(date) {
    const d = (date instanceof Date) ? date : new Date(date || Date.now());
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `CRL-${y}-${m}-${day}`;
}

// ----------------------------------------------------------------------------
// Signed CRL JSON body
// ----------------------------------------------------------------------------
/**
 * Build CRL JSON body (BEFORE signing). The body is canonicalized + signed
 * with ROOT key. Verifier reproduces canonicalization and validates.
 *
 * @param {object} input
 *   - epoch_id, epoch_label, merkle_root (hex), leaf_count
 *   - bitcoin_txid (string | null until anchored)
 *   - revocations: array of {
 *       cert_serial, kya_id, revoked_at (ISO), revoked_by,
 *       revocation_reason, revocation_category, revocation_hash,
 *       merkle_leaf_index, merkle_proof
 *     }
 *   - issuer_url: optional, default from env
 * @returns {object} unsigned CRL JSON body
 */
function buildCrlBody({
    epoch_id, epoch_label, merkle_root, leaf_count,
    bitcoin_txid, revocations, generated_at, issuer_url
}) {
    const hubPub = hubkeys.getPublicInfo();
    return {
        '@context': [
            'https://www.w3.org/2018/credentials/v1',
            'https://umbraxon.xyz/contexts/kya-crl-v1',
        ],
        type: ['VerifiableCredential', 'KYACertRevocationList'],
        id: `urn:kya:crl:${epoch_label}`,
        issuer: {
            id: `did:key:ed25519:${hubPub.pubkey_hex}`,
            name: hubPub.hub_name,
            url: issuer_url || hubPub.hub_url || null,
        },
        issuanceDate: generated_at || new Date().toISOString(),
        epoch: {
            epoch_id,
            epoch_label,
            cadence: 'daily',
            magic: 'KYAR',
            anchor: bitcoin_txid ? {
                type: 'Bitcoin-OP_RETURN',
                txid: bitcoin_txid,
                verification_url: `https://mempool.space/tx/${bitcoin_txid}`,
            } : null,
        },
        merkle_root,
        leaf_count,
        revocations: (revocations || []).map(r => ({
            cert_serial: r.cert_serial,
            kya_id: r.kya_id,
            revoked_at: typeof r.revoked_at === 'string' ? r.revoked_at : canonicalIsoMs(r.revoked_at),
            revoked_by: r.revoked_by,
            revocation_reason: r.revocation_reason || null,
            revocation_category: r.revocation_category || 'OTHER',
            revocation_hash: r.revocation_hash,
            merkle_leaf_index: r.merkle_leaf_index,
            merkle_proof: r.merkle_proof || null,
        })),
    };
    // 'proof' is appended by signCrlBody().
}

/**
 * Canonical JSON serialization (deterministic sorted keys, no whitespace).
 * Matches certs.canonicalize() byte-for-byte so we can re-use the same
 * verification primitive.
 */
function canonicalize(obj) {
    return JSON.stringify(_sortKeys(obj));
}

function _sortKeys(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(_sortKeys);
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = _sortKeys(v[k]); return acc; }, {});
}

/**
 * Signs a CRL JSON body with the ROOT key (or BASIC fallback if ROOT is not
 * yet configured — server logs a warning). Returns the body with 'proof'
 * appended. Verifier re-canonicalizes the body without proof and verifies.
 *
 * @param {object} crlBody (from buildCrlBody)
 * @param {object} [opts] — { role: 'ROOT' (default) | 'ELITE' | 'BASIC' }
 * @returns {object} signed CRL body
 */
function signCrlBody(crlBody, opts = {}) {
    const preferRole = opts.role || 'ROOT';
    const canonical = canonicalize(crlBody);
    const digest = crypto.createHash('sha256').update(canonical).digest();

    let signature;
    let usedRole = preferRole;
    try {
        signature = hubkeys.sign(digest, { role: preferRole });
    } catch (e) {
        if (preferRole === 'ROOT') {
            // Fallback: ROOT not configured → use ELITE (and warn at caller)
            try {
                signature = hubkeys.sign(digest, { role: 'ELITE' });
                usedRole = 'ELITE';
            } catch (_) {
                signature = hubkeys.sign(digest, { role: 'BASIC' });
                usedRole = 'BASIC';
            }
        } else {
            throw e;
        }
    }
    const pubHex = hubkeys.getPubkeyForRole(usedRole) || hubkeys.getPublicInfo().pubkey_hex;

    return {
        ...crlBody,
        proof: {
            type: 'Ed25519Signature2020',
            created: new Date().toISOString(),
            verificationMethod: `did:key:ed25519:${pubHex}#key-1`,
            proofPurpose: 'assertionMethod',
            algorithm: 'Ed25519',
            canonicalizationAlgorithm: 'urn:umbraxon:json-sorted-keys-v1',
            digestAlgorithm: 'SHA-256',
            signatureValue: signature,
            signingRole: usedRole,
        },
    };
}

/**
 * Verifies a signed CRL JSON body offline (signature only — NOT chain anchor).
 * Returns { valid, reason, issuerPubkey, signingRole }.
 */
function verifyCrlSignature(signedCrlBody) {
    if (!signedCrlBody || !signedCrlBody.proof || !signedCrlBody.proof.signatureValue) {
        return { valid: false, reason: 'NO_PROOF' };
    }
    const vm = signedCrlBody.proof.verificationMethod || '';
    const m = vm.match(/^did:key:ed25519:([0-9a-fA-F]{64})/);
    if (!m) return { valid: false, reason: 'INVALID_VERIFICATION_METHOD' };
    const issuerPubkey = m[1].toLowerCase();
    const { proof, ...bodyOnly } = signedCrlBody;
    const canonical = canonicalize(bodyOnly);
    const digest = crypto.createHash('sha256').update(canonical).digest();
    const ok = hubkeys.verify(digest, proof.signatureValue, issuerPubkey);
    return {
        valid: !!ok,
        reason: ok ? 'OK' : 'SIGNATURE_MISMATCH',
        issuerPubkey,
        signingRole: proof.signingRole || null,
    };
}

// ----------------------------------------------------------------------------
// recordRevocation — insert a revocation_events row at the moment of revocation.
// ----------------------------------------------------------------------------
// Called from every cert-revoking code path (reputation-engine SUSPENDED,
// retire-service voluntary + GDPR purge, anchor-worker cert reissue, admin
// reissue endpoint).
//
// Behaviour:
//   - Uses the SAME canonical leaf-hash formula as the migration 009 backfill,
//     so that pre-existing revocations and live ones can be combined in the
//     same Merkle tree without inconsistency.
//   - On unique-constraint conflict (un-anchored event for this serial already
//     exists), returns the existing row instead of inserting a duplicate.
//   - Never throws — all errors are caught and returned in { error } so that
//     a CRL insert never blocks the actual revoke operation.
//
// @param {pg.PoolClient | pg.Pool} client — transaction client preferred
// @param {object} input
//   - cert_serial (required)
//   - kya_id (required)
//   - revoked_at (Date|string) — defaults to NOW()
//   - revoked_by — 'system' | 'admin' | 'owner' | 'gdpr_purge' | 'anchor-worker'
//                  | 'retire-service' | 'reputation-engine'
//   - revocation_reason (string, ≤500 chars)
//   - revocation_category — 'SUSPENDED_ZONE' | 'VOLUNTARY_RETIRE' | 'GDPR_PURGE'
//                            | 'REISSUED' | 'ADMIN_REVOKE' | 'OTHER'
//   - agent_id, cert_hash, admin_user, client_ip, detail (all optional)
//
// @returns {Promise<{ id, revocation_hash, inserted: boolean, existing?: row, error?: string }>}
async function recordRevocation(client, input) {
    try {
        const cert_serial = input.cert_serial;
        const kya_id = input.kya_id;
        if (!cert_serial || !kya_id) return { error: 'cert_serial and kya_id required' };

        const revoked_at = input.revoked_at ? new Date(input.revoked_at) : new Date();
        const revocation_reason = input.revocation_reason
            ? String(input.revocation_reason).slice(0, 500)
            : '';
        const revocation_hash = computeRevocationHash({
            cert_serial, kya_id, revoked_at, revocation_reason,
        });
        const revoked_by = input.revoked_by || 'system';
        const revocation_category = input.revocation_category || 'OTHER';

        const r = await client.query(
            `INSERT INTO revocation_events (
                cert_serial, kya_id, agent_id, revoked_at, revoked_by,
                revocation_reason, revocation_category, cert_hash, revocation_hash,
                admin_user, client_ip, detail
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT (cert_serial) WHERE crl_anchor_id IS NULL DO NOTHING
            RETURNING id, revocation_hash`,
            [
                cert_serial, kya_id, input.agent_id || null,
                revoked_at, revoked_by,
                revocation_reason || null, revocation_category,
                input.cert_hash || null, revocation_hash,
                input.admin_user || null, input.client_ip || null,
                input.detail ? JSON.stringify(input.detail) : null,
            ]
        );

        if (r.rowCount > 0) {
            return { id: Number(r.rows[0].id), revocation_hash, inserted: true };
        }
        // No insert → existing pending event for this serial. Return it.
        const ex = await client.query(
            `SELECT id, revocation_hash FROM revocation_events
             WHERE cert_serial = $1 AND crl_anchor_id IS NULL
             LIMIT 1`,
            [cert_serial]
        );
        if (ex.rowCount > 0) {
            return { id: Number(ex.rows[0].id), revocation_hash: ex.rows[0].revocation_hash, inserted: false, existing: true };
        }
        return { error: 'race-condition: insert did nothing but no existing row' };
    } catch (e) {
        // Never throw — caller's main revoke op must continue.
        return { error: e.message || String(e) };
    }
}

module.exports = {
    CRL_MAGIC_HEX,
    EMPTY_ROOT,
    SECONDS_PER_DAY,
    sha256Hex,
    sha256Concat,
    canonicalIsoMs,
    computeRevocationHash,
    buildMerkleTree,
    buildProof,
    verifyProof,
    buildCrlOpReturnPayload,
    parseCrlOpReturnHex,
    epochIdFor,
    epochLabelFor,
    buildCrlBody,
    signCrlBody,
    verifyCrlSignature,
    canonicalize,
    recordRevocation,
};
