// ============================================================================
// UMBRAXON KYA-Hub — Anchor Library (Phase 4)
// ----------------------------------------------------------------------------
// Pomocný modul pre OP_RETURN anchor worker. Obsahuje:
//   - canonical cert hash výpočet
//   - OP_RETURN payload builder (4-byte magic "KYA1" + 32-byte sha256(cert))
//   - BTCPay create-tx integration (with proceedWithBroadcast flag)
//   - bitcoind RPC confirmation poll
//   - state-machine helpers: PENDING → BROADCAST → ANCHORED, alebo FAILED
//   - cert reissue s anchor proof (revoke old, insert new)
//   - audit log writes
//
// Bezpečnostné poznámky:
//   - LIVE broadcast vyžaduje EXPLICITNE  ANCHOR_WORKER_BROADCAST_ENABLED=true.
//   - Dry-run režim nevolá BTCPay vôbec — generuje len intended payload.
//   - Force-anchor endpoint môže prijať `simulate_txid` pre testy bez peňazí.
//   - BTCPay 2.3.9 podporuje OP_RETURN cez payment-methods/onchain/.../wallet/transactions
//     s formátom `destination: "OP_RETURN:<hex>"`, amount=0.
//     Server policy `AllowHotwalletForAll` MUSÍ byť enabled, inak HTTP 503.
// ============================================================================
const crypto = require('crypto');
const axios = require('axios');

const certs = require('./certs');
const hubkeys = require('./hubkeys');
const reputation = require('./reputation');
const bitcoindRpc = require('./bitcoind-rpc');

// ----------------------------------------------------------------------------
// Magic + payload
// ----------------------------------------------------------------------------
const MAGIC_HEX = '4b594131'; // "KYA1" (4 bytes)

function magicBytes() {
    return Buffer.from(MAGIC_HEX, 'hex');
}

/**
 * Vypočíta SHA-256 z canonical cert body (vrátane proof).
 * Hash je deterministický → kotví podpísaný cert ako celok.
 */
function certHashOf(certObj) {
    const canon = certs.canonicalize(certObj);
    return crypto.createHash('sha256').update(canon).digest('hex');
}

/**
 * 36-byte OP_RETURN payload: 4B magic || 32B sha256(cert).
 * Bitcoin standard OP_RETURN limit: 80 B (našich 36 B → bezpečne pod limitom).
 */
function buildOpReturnPayload(certBodyOrCert) {
    const h = certHashOf(certBodyOrCert);
    return MAGIC_HEX + h;
}

/**
 * Parse OP_RETURN script ASM na (magic, certHash) ak match.
 * Toleruje obidva formáty:
 *   1) bitcoind 0.18+ legacy: "OP_RETURN 4b594131..."
 *   2) bitcoind modern + mempool.space: "OP_RETURN OP_PUSHBYTES_36 4b594131..."
 * Stripuje akýkoľvek OP_PUSHBYTES_* / OP_PUSHDATA{1,2,4} token medzi OP_RETURN
 * a payload hexom.
 */
function parseOpReturnAsm(asm) {
    if (!asm || !asm.startsWith('OP_RETURN')) return null;
    const tokens = asm.trim().split(/\s+/);
    if (tokens.length < 2 || tokens[0] !== 'OP_RETURN') return null;
    // Find the last all-hex token — that's the payload regardless of push opcode prefix.
    let hex = null;
    for (let i = tokens.length - 1; i >= 1; i--) {
        const t = tokens[i].toLowerCase();
        if (/^[0-9a-f]+$/.test(t) && t.length % 2 === 0) { hex = t; break; }
    }
    if (!hex) return null;
    if (hex.length !== 72) return { magic: null, certHash: null, raw: hex, format: 'unknown' };
    const magic = hex.slice(0, 8);
    if (magic !== MAGIC_HEX) return { magic, certHash: null, raw: hex, format: 'unknown' };
    return { magic, certHash: hex.slice(8), raw: hex, format: 'KYA1' };
}

/**
 * Parse OP_RETURN scriptPubKey hex priamo (bez závislosti na ASM textovom formáte).
 * Hex layout: `6a` (OP_RETURN) + push opcode + payload.
 *   push opcodes:
 *     0x01..0x4b → direct push, opcode = length
 *     0x4c (OP_PUSHDATA1) → next 1B length
 *     0x4d (OP_PUSHDATA2) → next 2B little-endian length
 *     0x4e (OP_PUSHDATA4) → next 4B little-endian length
 */
function parseOpReturnHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const h = hex.toLowerCase();
    if (!h.startsWith('6a')) return null;
    let i = 2; // past 6a
    if (h.length < i + 2) return null;
    const opByte = parseInt(h.slice(i, i + 2), 16);
    i += 2;
    let payloadLen;
    if (opByte >= 0x01 && opByte <= 0x4b) {
        payloadLen = opByte;
    } else if (opByte === 0x4c) {
        if (h.length < i + 2) return null;
        payloadLen = parseInt(h.slice(i, i + 2), 16);
        i += 2;
    } else if (opByte === 0x4d) {
        if (h.length < i + 4) return null;
        payloadLen = parseInt(h.slice(i + 2, i + 4) + h.slice(i, i + 2), 16); // little-endian
        i += 4;
    } else if (opByte === 0x4e) {
        if (h.length < i + 8) return null;
        const b = h.slice(i, i + 8);
        payloadLen = parseInt(b.slice(6, 8) + b.slice(4, 6) + b.slice(2, 4) + b.slice(0, 2), 16);
        i += 8;
    } else {
        return null;
    }
    const payload = h.slice(i, i + payloadLen * 2);
    if (payload.length !== payloadLen * 2) return null;
    if (payload.length !== 72) return { magic: null, certHash: null, raw: payload, format: 'unknown', byte_len: payloadLen };
    const magic = payload.slice(0, 8);
    if (magic !== MAGIC_HEX) return { magic, certHash: null, raw: payload, format: 'unknown', byte_len: payloadLen };
    return { magic, certHash: payload.slice(8), raw: payload, format: 'KYA1', byte_len: payloadLen };
}

// ----------------------------------------------------------------------------
// Backend selector
// ----------------------------------------------------------------------------
// ANCHOR_FUNDING_BACKEND:
//   'bitcoind' (default) — uses bitcoind RPC wallet directly. Required as of
//     2026-05-12 because BTCPay 2.3.9 silently drops OP_RETURN outputs
//     (silently ignores BIP21 ?op_return= and `destinations[].opReturn` fields).
//     OP_RETURN was added to BTCPay only in 2.4.0+.
//   'btcpay' (legacy, broken on 2.3.x) — kept for fallback / future versions.
//
// Selecting 'bitcoind' also requires:
//   BITCOIND_ANCHOR_WALLET=kya-anchor   (descriptor wallet name in bitcoind)
//   BITCOIND_ANCHOR_ADDRESS=<bech32>    (optional: pin change to a known address;
//                                        if unset, bitcoind picks change from its
//                                        keypool)
// ----------------------------------------------------------------------------
function getAnchorBackend() {
    return (process.env.ANCHOR_FUNDING_BACKEND || 'bitcoind').toLowerCase();
}

// ----------------------------------------------------------------------------
// BTCPay broadcast (legacy — broken for OP_RETURN on BTCPay 2.3.9)
// ----------------------------------------------------------------------------
const BTCPAY_TIMEOUT_MS = parseInt(process.env.BTCPAY_TIMEOUT_MS || '20000', 10);

function btcpayBase() {
    return {
        url: process.env.BTCPAY_URL,
        store: process.env.BTCPAY_STORE_ID,
        key: process.env.BTCPAY_API_KEY,
    };
}

/**
 * Volá BTCPay create-tx s OP_RETURN destination.
 * @param {object} opts
 *   - opReturnHex: 36B hex (s magic-om)
 *   - feerateSatVb: integer sat/vB (estimateFee fallback)
 *   - broadcast: bool — true volá s proceedWithBroadcast=true (LIVE!), false dry-run
 * @returns { txid, transactionHex, fee_sats, broadcast, raw }
 */
async function btcpayBuildAndOptionallyBroadcast({ opReturnHex, feerateSatVb, broadcast }) {
    const cfg = btcpayBase();
    if (!cfg.url || !cfg.store || !cfg.key) {
        throw new Error('BTCPay not configured');
    }
    const body = {
        destinations: [
            { destination: `OP_RETURN:${opReturnHex}`, amount: '0', subtractFromAmount: false },
        ],
        feerate: feerateSatVb,
        proceedWithBroadcast: !!broadcast,
        proceedWithPayjoin: false,
        noChange: false,
        rbf: true,
        selectedInputs: null,
    };
    const res = await axios.post(
        `${cfg.url}/api/v1/stores/${cfg.store}/payment-methods/onchain/BTC/wallet/transactions`,
        body,
        {
            headers: { 'Authorization': `token ${cfg.key}`, 'Content-Type': 'application/json' },
            timeout: BTCPAY_TIMEOUT_MS,
            validateStatus: () => true,
        }
    );
    if (res.status >= 400) {
        const e = new Error(`BTCPay create-tx fail HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}`);
        e.httpStatus = res.status;
        e.btcpayResponse = res.data;
        throw e;
    }
    // BTCPay returns: { transactionHash, transactionHex, fee, totalAmount, ... }
    return {
        txid: res.data.transactionHash || null,
        transactionHex: res.data.transactionHex || null,
        fee_sats: typeof res.data.fee === 'number' ? Math.round(res.data.fee * 1e8) : null,
        broadcast: !!broadcast,
        raw: res.data,
    };
}

// ----------------------------------------------------------------------------
// bitcoind broadcast (Option B — preferred)
// ----------------------------------------------------------------------------
// Builds a raw tx with a single OP_RETURN output (and one auto-funded change
// output), signs it with the kya-anchor wallet, optionally broadcasts via
// sendrawtransaction. Whole flow is wallet-scoped — bitcoind picks UTXOs +
// inserts change automatically.
//
// Inputs:
//   - opReturnHex: hex string (must be ≤80 bytes after hex-decoding)
//   - feerateSatVb: integer sat/vB
//   - broadcast: bool — true → sendrawtransaction (LIVE!); false → simulate only
//
// Returns: { txid, transactionHex, fee_sats, broadcast, vout, simulated }
//   - When broadcast=true, txid is from sendrawtransaction (and matches the
//     local decode).
//   - When broadcast=false (simulate), we still build + sign + decode, so we
//     get a "would-be" txid + verified OP_RETURN script structure, but never
//     send to the network. Useful for DRY_RUN smoke tests.
//
// Errors:
//   - If wallet balance is too low → fundrawtransaction returns RPC error
//     "Insufficient funds" — surfaces as Error with .rpcError set.
//   - If OP_RETURN scriptPubKey hex doesn't start with `6a` after decode →
//     throw (defensive; should never happen).
// ----------------------------------------------------------------------------
async function bitcoindBuildAndOptionallyBroadcast({ opReturnHex, feerateSatVb, broadcast }) {
    const walletName = process.env.BITCOIND_ANCHOR_WALLET || 'kya-anchor';
    const changeAddr = process.env.BITCOIND_ANCHOR_ADDRESS || null;
    if (!/^[0-9a-fA-F]+$/.test(opReturnHex)) throw new Error('opReturnHex must be hex');
    if (opReturnHex.length / 2 > 80) throw new Error('OP_RETURN payload exceeds 80B limit');
    if (!Number.isFinite(feerateSatVb) || feerateSatVb <= 0) {
        throw new Error(`invalid feerate sat/vB: ${feerateSatVb}`);
    }

    // 1) Construct raw tx with the OP_RETURN output only. fundrawtransaction
    //    will add inputs + change.
    const outputs = [{ data: opReturnHex.toLowerCase() }];
    const rawHex = await bitcoindRpc.walletCall(walletName, 'createrawtransaction', [[], outputs]);

    // 2) Fund — bitcoind picks UTXOs and appends a change output. fee_rate is
    //    sat/vB (integer/decimal). change_position omitted so bitcoind picks.
    const fundOpts = {
        fee_rate: feerateSatVb,
        replaceable: true,
    };
    if (changeAddr) fundOpts.changeAddress = changeAddr;
    const funded = await bitcoindRpc.walletCall(walletName, 'fundrawtransaction', [rawHex, fundOpts]);

    // 3) Sign
    const signed = await bitcoindRpc.walletCall(walletName, 'signrawtransactionwithwallet', [funded.hex]);
    if (!signed || signed.complete !== true) {
        const reasons = (signed && signed.errors) ? JSON.stringify(signed.errors).slice(0, 300) : 'unknown';
        throw new Error(`bitcoind signing incomplete: ${reasons}`);
    }

    // 4) Decode & verify OP_RETURN structure before broadcast
    const decoded = await bitcoindRpc.call('decoderawtransaction', [signed.hex]);
    const opReturnVout = (decoded.vout || []).find(v =>
        v && v.scriptPubKey && typeof v.scriptPubKey.hex === 'string'
        && v.scriptPubKey.hex.toLowerCase().startsWith('6a')
    );
    if (!opReturnVout) {
        throw new Error('built tx is missing OP_RETURN output (6a opcode)');
    }
    const expectedTail = opReturnHex.toLowerCase();
    if (!opReturnVout.scriptPubKey.hex.toLowerCase().includes(expectedTail)) {
        throw new Error('OP_RETURN payload mismatch in built tx');
    }

    const feeSats = typeof funded.fee === 'number' ? Math.round(funded.fee * 1e8) : null;

    if (!broadcast) {
        return {
            txid: decoded.txid,
            transactionHex: signed.hex,
            fee_sats: feeSats,
            broadcast: false,
            simulated: true,
            vout: opReturnVout.n,
            raw: { funded_change_position: funded.changepos, decoded_op_return_hex: opReturnVout.scriptPubKey.hex },
            backend: 'bitcoind',
        };
    }

    // 5) Broadcast
    const txid = await bitcoindRpc.walletCall(walletName, 'sendrawtransaction', [signed.hex]);
    return {
        txid,
        transactionHex: signed.hex,
        fee_sats: feeSats,
        broadcast: true,
        simulated: false,
        vout: opReturnVout.n,
        raw: { funded_change_position: funded.changepos, decoded_op_return_hex: opReturnVout.scriptPubKey.hex },
        backend: 'bitcoind',
    };
}

// ----------------------------------------------------------------------------
// Unified dispatcher (worker calls this; backend chosen by env)
// ----------------------------------------------------------------------------
async function buildAndOptionallyBroadcast({ opReturnHex, feerateSatVb, broadcast, simulateOnly }) {
    const backend = getAnchorBackend();
    if (backend === 'bitcoind') {
        // simulateOnly==true forces broadcast=false (smoke test); otherwise honor broadcast flag.
        const wantBroadcast = simulateOnly ? false : !!broadcast;
        return bitcoindBuildAndOptionallyBroadcast({ opReturnHex, feerateSatVb, broadcast: wantBroadcast });
    }
    if (backend === 'btcpay') {
        // simulateOnly cannot be meaningfully implemented on BTCPay 2.3.9 because
        // BTCPay strips OP_RETURN from the built tx before returning. We still
        // try (will fail for OP_RETURN) so callers see the failure.
        return btcpayBuildAndOptionallyBroadcast({ opReturnHex, feerateSatVb, broadcast: !!broadcast });
    }
    throw new Error(`unknown ANCHOR_FUNDING_BACKEND: ${backend}`);
}

// ----------------------------------------------------------------------------
// bitcoind wallet status — for diagnostic UI/admin endpoints
// ----------------------------------------------------------------------------
async function getAnchorWalletStatus() {
    const backend = getAnchorBackend();
    if (backend !== 'bitcoind') return { backend, status: 'n/a (backend != bitcoind)' };
    const walletName = process.env.BITCOIND_ANCHOR_WALLET || 'kya-anchor';
    try {
        const info = await bitcoindRpc.walletCall(walletName, 'getwalletinfo', []);
        const unspents = await bitcoindRpc.walletCall(walletName, 'listunspent', [0, 9999999]);
        return {
            backend, wallet: walletName,
            balance_btc: info.balance,
            balance_sats: Math.round((info.balance || 0) * 1e8),
            unconfirmed_btc: info.unconfirmed_balance,
            utxo_count: unspents.length,
            utxos: unspents.slice(0, 20).map(u => ({ txid: u.txid, vout: u.vout, amount: u.amount, confirmations: u.confirmations, address: u.address })),
        };
    } catch (e) {
        return { backend, wallet: walletName, error: e.message };
    }
}

// ----------------------------------------------------------------------------
// Mempool.space fee fallback
// ----------------------------------------------------------------------------
async function fetchMempoolSpaceFeerate() {
    try {
        const r = await axios.get('https://mempool.space/api/v1/fees/recommended', {
            timeout: 5000,
            validateStatus: () => true,
        });
        if (r.status === 200 && r.data && typeof r.data.economyFee === 'number') {
            return Math.max(1, r.data.economyFee);
        }
    } catch (_) { /* fall */ }
    return null;
}

/**
 * Vráti odporúčaný feerate sat/vB. Priorita: bitcoind estimatesmartfee → mempool.space → env fallback.
 * Anchor TX-ku držíme v "economy" tier (1-3 sat/vB) — nie sme network-critical.
 */
async function estimateAnchorFeerate() {
    try {
        const b = await bitcoindRpc.estimateFee(parseInt(process.env.ANCHOR_FEE_TARGET_BLOCKS || '6', 10));
        if (b && b > 0) return Math.min(b, parseInt(process.env.ANCHOR_MAX_FEERATE_SAT_VB || '20', 10));
    } catch (_) { /* fall */ }
    const m = await fetchMempoolSpaceFeerate();
    if (m) return Math.min(m, parseInt(process.env.ANCHOR_MAX_FEERATE_SAT_VB || '20', 10));
    return parseInt(process.env.ANCHOR_FALLBACK_FEERATE_SAT_VB || '2', 10);
}

// ----------------------------------------------------------------------------
// Confirmation poll
// ----------------------------------------------------------------------------
/**
 * Vráti { confirmations, block_height, block_hash, block_time, found_in_chain }
 *
 * Resolution order (bitcoind without -txindex cannot look up confirmed txs
 * by txid alone, so we layer fallbacks):
 *   1. wallet `gettransaction <txid>` — works because anchor txs are produced
 *      by the kya-anchor wallet and remain in its tx history after confirmation.
 *   2. `getrawtransaction <txid> true` — only succeeds while still in mempool.
 *   3. mempool.space REST `/api/tx/<txid>` — covers edge cases (simulate_txid
 *      forced from admin endpoint that was NOT created by our wallet, or stale
 *      wallets after wallet recreation).
 */
async function getTxStatus(txid) {
    const walletName = process.env.BITCOIND_ANCHOR_WALLET || 'kya-anchor';

    // (1) wallet gettransaction
    try {
        const tx = await bitcoindRpc.walletCall(walletName, 'gettransaction', [txid, true]);
        const conf = tx.confirmations || 0;
        let block_height = tx.blockheight || null;
        // gettransaction omits blockheight in some bitcoind versions — derive it.
        if (!block_height && tx.blockhash) {
            try {
                const blk = await bitcoindRpc.getBlock(tx.blockhash, 1);
                block_height = blk.height;
            } catch (_) { /* best effort */ }
        }
        return {
            confirmations: conf,
            block_height,
            block_hash: tx.blockhash || null,
            block_time: tx.blocktime || null,
            found_in_chain: conf > 0,
            in_mempool: conf === 0,
            source: 'bitcoind-wallet',
        };
    } catch (e) {
        if (!(e.rpcError && (e.rpcError.code === -5 || /Invalid or non-wallet transaction/i.test(e.rpcError.message || '')))) {
            // unexpected wallet error — fall through to other lookups but record it
        }
    }

    // (2) getrawtransaction (mempool only without -txindex)
    try {
        const tx = await bitcoindRpc.getRawTransaction(txid, true);
        const conf = tx.confirmations || 0;
        return {
            confirmations: conf,
            block_height: tx.blockheight || null,
            block_hash: tx.blockhash || null,
            block_time: tx.blocktime || null,
            found_in_chain: conf > 0,
            in_mempool: conf === 0,
            tx_size_vb: tx.vsize || null,
            source: 'bitcoind-rpc',
        };
    } catch (e) {
        if (!(e.rpcError && (e.rpcError.code === -5 || /No such mempool/i.test(e.rpcError.message || '')))) {
            throw e;
        }
        // fall through to mempool.space
    }

    // (3) mempool.space — works for any confirmed tx without needing -txindex
    try {
        const r = await axios.get(`https://mempool.space/api/tx/${txid}/status`, { timeout: 6000, validateStatus: () => true });
        if (r.status === 200 && r.data) {
            if (r.data.confirmed) {
                // To get confirmation count, also query tip height
                let tipHeight = null;
                try {
                    const t = await axios.get('https://mempool.space/api/blocks/tip/height', { timeout: 4000, validateStatus: () => true });
                    if (t.status === 200 && t.data) tipHeight = parseInt(t.data, 10);
                } catch (_) { /* best effort */ }
                const conf = (tipHeight && r.data.block_height) ? (tipHeight - r.data.block_height + 1) : 1;
                return {
                    confirmations: conf,
                    block_height: r.data.block_height || null,
                    block_hash: r.data.block_hash || null,
                    block_time: r.data.block_time || null,
                    found_in_chain: true,
                    in_mempool: false,
                    source: 'mempool.space',
                };
            }
            return { confirmations: 0, found_in_chain: false, in_mempool: true, source: 'mempool.space' };
        }
    } catch (_) { /* fall through */ }

    return { confirmations: 0, found_in_chain: false, in_mempool: false, not_found: true };
}

// ----------------------------------------------------------------------------
// Audit log helper
// ----------------------------------------------------------------------------
async function writeAudit(client, {
    pending_anchor_id, agent_id, kya_id, event_type, cert_serial, cert_hash,
    bitcoin_txid, fee_sats, block_height, detail
}) {
    try {
        await client.query(
            `INSERT INTO anchor_audit (
                pending_anchor_id, agent_id, kya_id, event_type, cert_serial, cert_hash,
                bitcoin_txid, fee_sats, block_height, detail
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                pending_anchor_id || null, agent_id || null, kya_id || null, event_type,
                cert_serial || null, cert_hash || null, bitcoin_txid || null,
                fee_sats || null, block_height || null,
                detail ? JSON.stringify(detail) : null,
            ]
        );
    } catch (_) { /* audit must never break the flow */ }
}

// ----------------------------------------------------------------------------
// Cert reissue with anchor proof (Step 3 of Phase 4)
// ----------------------------------------------------------------------------
/**
 * Po ANCHORED stave vystaví nový cert s `credentialSubject.anchor = {...}` poľom,
 * podpíše ELITE kľúčom (alebo BASIC ak ELITE nie je dostupný), uloží do `certificates`,
 * starý cert označí is_current=FALSE + revoke_reason='reissued_with_anchor'.
 *
 * @returns { reissued: true, serial: 'CERT-XXX-002', certificate: {...} }
 */
async function reissueCertWithAnchor(client, { agent, anchor, logger }) {
    const log = logger || console;
    // Vyber posledný ACTIVE cert
    const cur = await client.query(
        `SELECT serial, cert_body, valid_until FROM certificates
         WHERE kya_id = $1 AND is_current = TRUE
         ORDER BY issued_at DESC LIMIT 1`,
        [agent.kya_id]
    );
    if (cur.rowCount === 0) {
        log.warn && log.warn({ kya_id: agent.kya_id }, 'reissue: no current cert — skipping');
        return { reissued: false, reason: 'NO_CURRENT_CERT' };
    }
    const oldCert = cur.rows[0];
    const oldBody = oldCert.cert_body;

    // Increment serial counter
    const cnt = await client.query(
        `SELECT COUNT(*)::int AS c FROM certificates WHERE kya_id = $1`,
        [agent.kya_id]
    );
    const newSerial = certs.makeSerial(agent.kya_id, cnt.rows[0].c + 1);

    // Skopíruj credentialSubject zo starého, doplň anchor objekt
    const cs = JSON.parse(JSON.stringify(oldBody.credentialSubject || {}));
    cs.anchor = {
        type: 'Bitcoin-OP_RETURN',
        magic: 'KYA1',
        txid: anchor.txid,
        vout: anchor.vout || 0,
        op_return_hex: anchor.op_return_hex,
        cert_hash: anchor.cert_hash,
        block_height: anchor.block_height || null,
        block_hash: anchor.block_hash || null,
        confirmed_at: anchor.confirmed_at || new Date().toISOString(),
        verification_url: `https://mempool.space/tx/${anchor.txid}`,
    };

    // Bouduj nový cert body — zachovaj všetko ostatné zo starého, len patch credentialSubject a issuanceDate.
    const newBody = JSON.parse(JSON.stringify(oldBody));
    delete newBody.proof;
    newBody.credentialSubject = cs;
    newBody.issuanceDate = new Date().toISOString();
    newBody.id = `urn:kya:cert:${newSerial}`;
    // termsOfUse zostáva
    // expirationDate sa zachová (ELITE = null)

    // Podpíš (ELITE preferovane — tier-based selection in certs.signCert)
    const signed = certs.signCert(newBody, {
        purpose: 'cert_reissue', serial: newSerial, kya_id: agent.kya_id,
        admin_user: 'anchor-worker', client_ip: null,
    });

    // Phase 5b: extract first pubkey from either single-sig (verificationMethod)
    // or multi-sig (signatures[0].verificationMethod) proof block.
    const issuerPubkey = (() => {
        const vm = (signed.proof.verificationMethod
            || (signed.proof.signatures && signed.proof.signatures[0] && signed.proof.signatures[0].verificationMethod)
            || '');
        const m = vm.match(/ed25519:([0-9a-fA-F]{64})/);
        return (m && m[1].toLowerCase()) || hubkeys.getPublicInfo().pubkey_hex;
    })();

    // Resolve signing_key_id
    let signingKeyId = null;
    try {
        const meta = await hubkeys.store.lookupKeyByPubkey(client, issuerPubkey);
        signingKeyId = meta ? meta.key_id : null;
    } catch (_) { /* best effort */ }

    // Old cert → not current + revoked
    const oldRev = await client.query(
        `UPDATE certificates SET is_current = FALSE,
                                  revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
                                  revoke_reason = COALESCE(revoke_reason, 'reissued_with_anchor')
         WHERE kya_id = $1 AND is_current = TRUE
         RETURNING serial, revoked_at`,
        [agent.kya_id]
    );

    // Phase 5 — log the reissue-induced revocation into CRL ledger
    try {
        const crl = require('./crl');
        for (const row of oldRev.rows) {
            await crl.recordRevocation(client, {
                cert_serial: row.serial,
                kya_id: agent.kya_id,
                agent_id: agent.id,
                revoked_at: row.revoked_at,
                revoked_by: 'anchor-worker',
                revocation_reason: 'reissued_with_anchor',
                revocation_category: 'REISSUED',
                detail: { new_serial: newSerial, txid: anchor.txid },
            });
        }
    } catch (_) { /* never break reissue on CRL insert failure */ }

    // Phase 5b: derive proof metadata (single-sig vs multi-sig).
    const _proof = signed.proof || {};
    const _isMulti = _proof.type === 'Ed25519MultiSignature2020';
    const _legacySigValue = _isMulti
        ? ((Array.isArray(_proof.signatures) && _proof.signatures[0]
              && (_proof.signatures[0].signatureValue || _proof.signatures[0].signature)) || '')
        : (_proof.signatureValue || '');
    const _proofThreshold = _isMulti
        ? (Number.isFinite(_proof.threshold) ? _proof.threshold : (_proof.signatures || []).length)
        : 1;
    const _proofRoles = _isMulti
        ? (_proof.signatures || []).map(s => s.role).filter(Boolean)
        : (_proof.signingRole ? [_proof.signingRole] : null);

    // Insert new cert
    await client.query(
        `INSERT INTO certificates (
            serial, agent_id, kya_id, cert_body, hub_signature, issuer_pubkey,
            valid_until, issued_by, signing_key_id, is_current,
            proof_type, proof_threshold, proof_signing_roles
        )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'anchor-worker', $8, TRUE, $9, $10, $11)`,
        [
            newSerial, agent.id, agent.kya_id, JSON.stringify(signed),
            _legacySigValue, issuerPubkey, oldCert.valid_until, signingKeyId,
            _proof.type || 'Ed25519Signature2020', _proofThreshold, _proofRoles,
        ]
    );
    await client.query(
        `UPDATE agents SET cert_serial = $1, cert_issued_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [newSerial, agent.id]
    );

    return { reissued: true, serial: newSerial, oldSerial: oldCert.serial, certificate: signed, signingKeyId };
}

// ----------------------------------------------------------------------------
// Cert hash lookup pre `pending_anchors`
// ----------------------------------------------------------------------------
async function fetchCertForAgent(client, agentId) {
    const r = await client.query(
        `SELECT serial, cert_body FROM certificates
         WHERE agent_id = $1 AND is_current = TRUE
         ORDER BY issued_at DESC LIMIT 1`,
        [agentId]
    );
    if (r.rowCount === 0) return null;
    return { serial: r.rows[0].serial, cert_body: r.rows[0].cert_body };
}

// ----------------------------------------------------------------------------
// Verify anchor on-chain — public API helper
// ----------------------------------------------------------------------------
/**
 * Pre verejný endpoint /api/verify/anchor/:txid — overí, či daná TX má OP_RETURN
 * s magic "KYA1" a vráti parsed certHash + odkaz na DB agenta.
 *
 * Try-order:
 *   1) bitcoind wallet `gettransaction` + `decoderawtransaction` — works for our
 *      own anchor txs even after they leave mempool (no -txindex required).
 *   2) bitcoind `getrawtransaction` — works only while still in mempool.
 *   3) mempool.space REST `/api/tx/:txid` — universal fallback for any confirmed
 *      tx including ones produced outside our wallet.
 *
 * Output is normalized to a uniform shape regardless of source. OP_RETURN
 * detection uses parseOpReturnHex (scriptPubKey.hex) which is unambiguous
 * across all sources/formats; parseOpReturnAsm is a secondary fallback.
 */
async function verifyAnchorOnChain(txid) {
    const walletName = process.env.BITCOIND_ANCHOR_WALLET || 'kya-anchor';

    // Normalize all sources into { vout: [{scriptPubKey:{asm,hex}}], blockheight, blockhash, blocktime, confirmations }
    let tx = null;
    let source = null;

    // (1) wallet gettransaction → has hex, decode locally
    try {
        const wtx = await bitcoindRpc.walletCall(walletName, 'gettransaction', [txid, true, true]);
        if (wtx && wtx.hex) {
            const decoded = await bitcoindRpc.call('decoderawtransaction', [wtx.hex]);
            tx = {
                vout: decoded.vout || [],
                blockheight: null,
                blockhash: wtx.blockhash || null,
                blocktime: wtx.blocktime || null,
                confirmations: wtx.confirmations || 0,
            };
            if (tx.blockhash) {
                try {
                    const blk = await bitcoindRpc.getBlock(tx.blockhash, 1);
                    tx.blockheight = blk.height;
                } catch (_) { /* best effort */ }
            }
            source = 'bitcoind-wallet';
        }
    } catch (_) { /* fall through */ }

    // (2) getrawtransaction (mempool only without -txindex)
    if (!tx) {
        try {
            const raw = await bitcoindRpc.getRawTransaction(txid, true);
            tx = {
                vout: raw.vout || [],
                blockheight: raw.blockheight || null,
                blockhash: raw.blockhash || null,
                blocktime: raw.blocktime || null,
                confirmations: raw.confirmations || 0,
            };
            source = 'bitcoind-rpc';
        } catch (_) { /* fall through */ }
    }

    // (3) mempool.space
    if (!tx) {
        try {
            const r = await axios.get(`https://mempool.space/api/tx/${txid}`, { timeout: 5000, validateStatus: () => true });
            if (r.status === 200 && r.data) {
                tx = {
                    vout: (r.data.vout || []).map(v => ({ scriptPubKey: { asm: v.scriptpubkey_asm, hex: v.scriptpubkey } })),
                    blockheight: r.data.status && r.data.status.block_height ? r.data.status.block_height : null,
                    blockhash: r.data.status && r.data.status.block_hash ? r.data.status.block_hash : null,
                    blocktime: r.data.status && r.data.status.block_time ? r.data.status.block_time : null,
                    confirmations: r.data.status && r.data.status.confirmed ? 1 : 0,
                };
                source = 'mempool.space';
            }
        } catch (_) { /* fall */ }
    }

    if (!tx) return { found: false, source: null };

    // Find KYA1 OP_RETURN — try hex first (unambiguous), then asm (legacy).
    let kyaPayload = null;
    let voutIdx = null;
    for (let i = 0; i < (tx.vout || []).length; i++) {
        const v = tx.vout[i];
        const spk = (v && v.scriptPubKey) || {};
        const byHex = parseOpReturnHex(spk.hex || '');
        const byAsm = byHex ? null : parseOpReturnAsm(spk.asm || '');
        const found = (byHex && byHex.format === 'KYA1') ? byHex : ((byAsm && byAsm.format === 'KYA1') ? byAsm : null);
        if (found) { kyaPayload = found; voutIdx = i; break; }
    }

    return {
        found: true,
        source,
        txid,
        block_height: tx.blockheight || null,
        block_hash: tx.blockhash || null,
        block_time: tx.blocktime || null,
        confirmations: tx.confirmations || 0,
        op_return: kyaPayload ? {
            vout: voutIdx,
            magic: kyaPayload.magic,
            cert_hash: kyaPayload.certHash,
            raw_hex: kyaPayload.raw,
        } : null,
        is_kya_anchor: !!kyaPayload,
    };
}

module.exports = {
    MAGIC_HEX,
    magicBytes,
    certHashOf,
    buildOpReturnPayload,
    parseOpReturnAsm,
    parseOpReturnHex,
    btcpayBuildAndOptionallyBroadcast,
    bitcoindBuildAndOptionallyBroadcast,
    buildAndOptionallyBroadcast,
    getAnchorBackend,
    getAnchorWalletStatus,
    estimateAnchorFeerate,
    fetchMempoolSpaceFeerate,
    getTxStatus,
    writeAudit,
    reissueCertWithAnchor,
    fetchCertForAgent,
    verifyAnchorOnChain,
};
