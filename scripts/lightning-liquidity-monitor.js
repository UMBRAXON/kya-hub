#!/usr/bin/env node
// ============================================================================
// UMBRAXON KYA-Hub — Lightning Inbound Liquidity Monitor
// (Strategic Sprint §30 Item 6 + Cloudflare-R2 / Alby-unlock refactor)
// ----------------------------------------------------------------------------
// Two-tier data acquisition:
//
//   1) PREFERRED: Alby Hub native HTTP API. Returns full per-channel state
//      including `localBalance` (outbound), `remoteBalance` (inbound),
//      `state` (open / opening / closed), `active`. Requires the hub to be
//      unlocked — we POST the unlock password to `/api/start` (v1.21.x)
//      or legacy `/api/unlock` and reuse the session cookie / JWT for
//      `/api/channels`. The session is cached at module scope and refreshed
//      on HTTP 401.
//
//      Password sources (first-match wins):
//        a. `process.env.ALBY_UNLOCK_PASSWORD`            ← PREFERRED
//        b. File at `ALBY_UNLOCK_PASSWORD_FILE` (default
//           `/root/kya-hub/.secrets/alby-unlock.txt`), perms MUST be 0600.
//
//   2) FALLBACK: NWC `getBalance()` → outbound liquidity (sats spendable).
//      Inbound liquidity cannot be derived from NWC. We surface this as
//      `inbound_unknown=true`. A "NWC fallback" Telegram warning fires
//      AT MOST ONCE PER PROCESS LIFETIME (subsequent cycles still log to
//      PM2 / stdout but stay silent on Telegram to avoid spam).
//
// PM2 cron: every 15 min (configured in ecosystem.config.js).
//
// Exit codes:
//   0  OK or WARN (data acquired, no critical alert)
//   2  CRITICAL inbound (alert sent)
//   3  AUTH_REQUIRED (no unlock pw, NWC fallback used)
//   4  RPC_FAIL (couldn't read either source)
//
// CLI:
//   node scripts/lightning-liquidity-monitor.js               # one cycle
//   node scripts/lightning-liquidity-monitor.js --once        # explicit (same)
//   node scripts/lightning-liquidity-monitor.js --no-notify   # smoke test (no Telegram)
// ============================================================================
require('dotenv').config({ path: __dirname + '/../.env', override: true });

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const alby = require('../lib/alby');
const notifications = require('../lib/notifications');

const LOCK_PATH = process.env.LIQUIDITY_MONITOR_LOCK_FILE || '/tmp/kya-liquidity-monitor.lock';
const LOCK_STALE_MS = parseInt(process.env.LIQUIDITY_MONITOR_LOCK_STALE_MS || '120000', 10);

const CFG = {
    ALBY_HUB_URL: process.env.ALBY_HUB_URL || 'http://127.0.0.1:8080',
    UNLOCK_PASSWORD_FILE: process.env.ALBY_UNLOCK_PASSWORD_FILE || '/root/kya-hub/.secrets/alby-unlock.txt',
    ALBY_UNLOCK_RETRY_MS: parseInt(process.env.LIQUIDITY_ALBY_UNLOCK_RETRY_MS || '800', 10),
    ALBY_UNLOCK_RETRY_MAX: parseInt(process.env.LIQUIDITY_ALBY_UNLOCK_RETRY_MAX || '4', 10),
    // Legacy absolute thresholds (kept for backwards compatibility + tests).
    WARN_INBOUND_SATS: parseInt(process.env.LIQUIDITY_WARN_SATS || '500000', 10),
    CRITICAL_INBOUND_SATS: parseInt(process.env.LIQUIDITY_CRITICAL_SATS || '200000', 10),
    // New ratio-based rule (primary trigger):
    //   alert if inbound < INBOUND_RATIO_PCT % of outbound OR inbound < MIN_INBOUND_SATS
    INBOUND_RATIO_PCT: parseInt(process.env.LIQUIDITY_INBOUND_RATIO_PCT || '25', 10),
    MIN_INBOUND_SATS: parseInt(process.env.LIQUIDITY_MIN_INBOUND_SATS || '10000', 10),
    LSP_RECOMMENDED_FEE_SATS: parseInt(process.env.LIQUIDITY_LSP_FEE_SATS || '9000', 10),
    LSP_RECOMMENDED_BUY_SATS: parseInt(process.env.LIQUIDITY_LSP_BUY_SATS || '500000', 10),
    HTTP_TIMEOUT_MS: parseInt(process.env.LIQUIDITY_HTTP_TIMEOUT_MS || '5000', 10),
};

const ARGS = process.argv.slice(2);
const NO_NOTIFY = ARGS.includes('--no-notify') || process.env.NOTIF_ENABLED === 'false';

let lastResult = null;

// Once-per-process flags for noisy warnings (NWC fallback in particular).
const _emittedOnce = new Set();
function _emitOnce(key) {
    if (_emittedOnce.has(key)) return false;
    _emittedOnce.add(key);
    return true;
}

// Cached Alby session — survives multiple runOnce() calls within one process.
let _albySession = null; // { token?: string, cookie?: string, acquiredAt: number }

function nowIso() { return new Date().toISOString(); }

function log(level, obj) {
    // Hardened so that even if `obj` accidentally contains a `password`
    // field, we drop the value before serialising.
    const safe = {};
    for (const k of Object.keys(obj || {})) {
        if (/password|secret|unlock/i.test(k) && typeof obj[k] === 'string') {
            safe[k] = '[REDACTED]';
        } else {
            safe[k] = obj[k];
        }
    }
    console.log(JSON.stringify({ ts: nowIso(), level, component: 'lightning-liquidity-monitor', ...safe }));
}

function _statSafe(p) { try { return fs.statSync(p); } catch (_) { return null; } }

// Resolve the unlock password from env first, then from a 0600 secret file.
// NEVER logs the password value. Returns { password, source } or null.
function readUnlockPassword() {
    if (typeof process.env.ALBY_UNLOCK_PASSWORD === 'string'
        && process.env.ALBY_UNLOCK_PASSWORD.trim().length >= 4) {
        return { password: process.env.ALBY_UNLOCK_PASSWORD.trim(), source: 'env:ALBY_UNLOCK_PASSWORD' };
    }
    const f = CFG.UNLOCK_PASSWORD_FILE;
    const st = _statSafe(f);
    if (!st) return null;
    // Reject if file is world / group readable. 0600 = owner rw only.
    // (st.mode & 0o077) === 0 means group/other have no bits set.
    const perm = st.mode & 0o777;
    if ((perm & 0o077) !== 0) {
        log('error', { event: 'unlock_file_bad_perms', file: f, mode_octal: perm.toString(8),
                       hint: 'chmod 600 ' + f });
        return null;
    }
    try {
        const raw = fs.readFileSync(f, 'utf-8').replace(/[\r\n]+$/g, '').trim();
        if (!raw || raw.length < 4) return null;
        return { password: raw, source: `file:${f}` };
    } catch (e) {
        log('error', { event: 'unlock_file_read_fail', file: f, error: e.message });
        return null;
    }
}

function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Single-instance guard — PM2 cron + manual `?fresh=1` can overlap and trip
// Alby's per-minute unlock rate limit (429), which previously fell through to
// `/api/login` (OAuth) and produced a false "set unlock password" Telegram.
function acquireProcessLock() {
    try {
        if (fs.existsSync(LOCK_PATH)) {
            const st = fs.statSync(LOCK_PATH);
            const age = Date.now() - st.mtimeMs;
            if (age < LOCK_STALE_MS) {
                try {
                    const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
                    if (pid > 0) process.kill(pid, 0);
                    return { acquired: false, reason: 'already-running', other_pid: pid };
                } catch (e) {
                    if (e.code !== 'ESRCH') throw e;
                }
            }
            fs.unlinkSync(LOCK_PATH);
        }
        fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx', mode: 0o600 });
        return { acquired: true };
    } catch (e) {
        if (e.code === 'EEXIST') return { acquired: false, reason: 'lock-contention' };
        throw e;
    }
}

function releaseProcessLock() {
    try {
        if (!fs.existsSync(LOCK_PATH)) return;
        const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
        if (pid === process.pid) fs.unlinkSync(LOCK_PATH);
    } catch (_) {}
}

// Unlock Alby Hub. `/api/start` (v1.21.x) then `/api/unlock` (older). Never
// `/api/login` — that is OAuth/JWT and returns 401 for unlock passwords.
async function _albyLogin(password) {
    const body = { unlockPassword: password, unlock_password: password };
    const endpoints = [
        `${CFG.ALBY_HUB_URL}/api/start`,
        `${CFG.ALBY_HUB_URL}/api/unlock`,
    ];
    let lastErr = null;
    for (const url of endpoints) {
        for (let attempt = 0; attempt < CFG.ALBY_UNLOCK_RETRY_MAX; attempt++) {
            if (attempt > 0) {
                await _sleep(CFG.ALBY_UNLOCK_RETRY_MS * attempt);
            }
            try {
                const r = await axios.post(url, body, {
                    timeout: CFG.HTTP_TIMEOUT_MS,
                    validateStatus: () => true,
                    headers: { 'Content-Type': 'application/json' },
                });
                if (r.status >= 200 && r.status < 300) {
                    const cookie = Array.isArray(r.headers['set-cookie'])
                        ? r.headers['set-cookie'].join('; ')
                        : (r.headers['set-cookie'] || null);
                    const token = r.data?.token || r.data?.jwt || null;
                    return { token, cookie, endpoint: url, acquiredAt: Date.now() };
                }
                lastErr = new Error(`http=${r.status} (${url})`);
                lastErr.httpStatus = r.status;
                if (r.status === 429) continue;
                if (r.status === 404 || r.status === 405) break;
                throw lastErr;
            } catch (e) {
                lastErr = e;
                if (e.httpStatus === 429) continue;
                if (e.httpStatus && e.httpStatus !== 404 && e.httpStatus !== 405) throw e;
                break;
            }
        }
    }
    if (lastErr && lastErr.httpStatus === 429) {
        const e = new Error('alby unlock rate-limited (429)');
        e.httpStatus = 429;
        throw e;
    }
    throw lastErr || new Error('alby unlock failed (no endpoint accepted credentials)');
}

async function _albyGetChannels(session) {
    const url = `${CFG.ALBY_HUB_URL}/api/channels`;
    const headers = {};
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    if (session.cookie) headers.Cookie = session.cookie;
    const r = await axios.get(url, {
        timeout: CFG.HTTP_TIMEOUT_MS,
        validateStatus: () => true,
        headers,
    });
    if (r.status >= 400) {
        const e = new Error(`alby channels http=${r.status}: ${(typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data)).slice(0, 200)}`);
        e.httpStatus = r.status;
        throw e;
    }
    return Array.isArray(r.data) ? r.data : (r.data?.channels || []);
}

// Returns true if the channel object describes a state we'd count toward
// inbound capacity. Alby Hub LDK builds expose:
//   - `status` string: online / offline / opening / closing / pending / inactive
//   - `state`  string: open / opening / pending / closing / closed (older forks)
//   - `active` boolean: true if peer is connected + channel ready+usable
//   - `internalChannel.channel.IsChannelReady` + `.IsUsable` (LDK ground truth)
// We treat a channel as open if ANY of the following are true:
//   1) status/state ∈ { open, online, active }
//   2) active === true AND status/state is not an explicit closing/closed/error state
//   3) internalChannel.channel.IsChannelReady === true AND IsUsable === true
function _isOpenChannel(c) {
    const s = String(c.state || c.status || '').toLowerCase();
    if (s === 'open' || s === 'online' || s === 'active') return true;
    const closedish = (s === 'closed' || s === 'closing' || s === 'force-closing'
                       || s === 'force_closing' || s === 'pending-close' || s === 'inactive');
    if ((c.active === true || c.isActive === true) && !closedish) return true;
    try {
        const ic = c.internalChannel && c.internalChannel.channel;
        if (ic && ic.IsChannelReady === true && ic.IsUsable === true) return true;
    } catch (_) {}
    return false;
}

async function probeAlbyHttp() {
    const pw = readUnlockPassword();
    if (!pw) return { ok: false, reason: 'no-unlock-password', detail: 'set ALBY_UNLOCK_PASSWORD in .env or drop into ' + CFG.UNLOCK_PASSWORD_FILE + ' (chmod 600)' };

    // Use the cached session if we have one — falls back to a fresh login
    // on a getChannels 401 (= session expired). A login 401 is a bad password
    // and is NOT retried.
    let session = _albySession;
    let channels = null;
    let triedRelogin = false;

    while (true) {
        const startedWithCachedSession = !!session;
        try {
            if (!session) {
                session = await _albyLogin(pw.password);
                _albySession = session;
                log('info', { event: 'alby_login_ok', endpoint: session.endpoint, source: pw.source });
            }
            // Alby may return 500 "LNClient not started" briefly after unlock/restart.
            let lastChannelsErr = null;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    channels = await _albyGetChannels(session);
                    lastChannelsErr = null;
                    break;
                } catch (chErr) {
                    lastChannelsErr = chErr;
                    const msg = String(chErr.message || '');
                    const lndWarmup = chErr.httpStatus === 500 && /LNClient not started/i.test(msg);
                    if (lndWarmup && attempt < 4) {
                        await new Promise((r) => setTimeout(r, 3000));
                        continue;
                    }
                    throw chErr;
                }
            }
            if (lastChannelsErr) throw lastChannelsErr;
            break;
        } catch (e) {
            // Only retry on 401 if we ENTERED the loop with a cached session
            // — that's the "session expired between cycles" case. A 401 on a
            // fresh login is just a wrong password.
            if (e.httpStatus === 401 && startedWithCachedSession && !triedRelogin) {
                log('warn', { event: 'alby_session_expired_retry' });
                _albySession = null;
                session = null;
                triedRelogin = true;
                continue;
            }
            return {
                ok: false,
                source: 'alby-http',
                reason: e.httpStatus === 429 ? 'alby-rate-limited' : 'alby-api-failed',
                error: e.message,
                http_status: e.httpStatus,
            };
        }
    }

    let inboundSats = 0, outboundSats = 0, totalCapSats = 0, openCount = 0;
    const detail = [];
    for (const c of channels) {
        // Alby Hub returns msats on most fields; we normalise to sats.
        const localMsat = Number(c.localBalance || c.local_balance || c.localSpendableBalance || 0);
        const remoteMsat = Number(c.remoteBalance || c.remote_balance || 0);
        // Some builds expose `localSpendableBalance` (msat) + `localBalance` (msat).
        // We use whichever is present and >0 as the canonical outbound figure.
        const local = Math.floor(localMsat / 1000);
        const remote = Math.floor(remoteMsat / 1000);
        const cap = local + remote;
        const open = _isOpenChannel(c);
        if (open) {
            outboundSats += local;
            inboundSats += remote;
            totalCapSats += cap;
            openCount++;
        }
        detail.push({
            short_channel_id: c.id || c.shortChannelId || null,
            state: String(c.state || c.status || (c.active ? 'active' : 'unknown')).toLowerCase(),
            active: !!(c.active || c.isActive),
            counted: open,
            local_sats: local,
            remote_sats: remote,
            capacity_sats: cap,
            peer_alias: c.peerAlias || null,
        });
    }

    return {
        ok: true,
        source: 'alby-http',
        password_source: pw.source.startsWith('env:') ? 'env' : 'file',
        channel_count: channels.length,
        active_count: openCount,
        inbound_sats: inboundSats,
        outbound_sats: outboundSats,
        total_capacity_sats: totalCapSats,
        channels: detail,
    };
}

async function probeNwc() {
    try {
        const ok = await alby.connect({ warn: () => {}, info: () => {}, error: () => {} });
        if (!ok) return { ok: false, source: 'nwc', reason: 'nwc-not-configured' };
        const bal = await alby.getBalance();
        await alby.disconnect();
        return {
            ok: true,
            source: 'nwc',
            outbound_sats: bal.balanceSats,
            inbound_sats: null,
            inbound_unknown: true,
        };
    } catch (e) {
        try { await alby.disconnect(); } catch (_) {}
        return { ok: false, source: 'nwc', reason: 'nwc-failed', error: e.message };
    }
}

// Decide alert level based on the new ratio-based rule, while preserving
// the legacy absolute thresholds for tests that pin those values.
function classify(inboundSats, outboundSats) {
    if (inboundSats == null) return 'UNKNOWN';
    if (inboundSats < CFG.MIN_INBOUND_SATS) return 'CRITICAL';
    // Ratio check: inbound below INBOUND_RATIO_PCT % of outbound → warn
    if (outboundSats > 0) {
        const ratio = (inboundSats * 100) / outboundSats;
        if (ratio < CFG.INBOUND_RATIO_PCT) return 'WARN';
    }
    // Legacy absolute thresholds — only trigger if the ratio rule didn't already.
    if (inboundSats < CFG.CRITICAL_INBOUND_SATS) return 'CRITICAL';
    if (inboundSats < CFG.WARN_INBOUND_SATS) return 'WARN';
    return 'OK';
}

async function _safeNotify(payload) {
    if (NO_NOTIFY) return { skipped: true };
    return notifications.notify(payload).catch(() => ({ error: true }));
}

async function runOnce() {
    const lock = acquireProcessLock();
    if (!lock.acquired) {
        log('info', { event: 'liquidity_skip_concurrent', reason: lock.reason, other_pid: lock.other_pid });
        return { exit: 0, result: { ok: true, source: 'skipped-concurrent', skipped: true, reason: lock.reason } };
    }
    try {
        return await _runOnceUnlocked();
    } finally {
        releaseProcessLock();
    }
}

async function _runOnceUnlocked() {
    let result = await probeAlbyHttp();
    const hadUnlockPassword = result.reason !== 'no-unlock-password';

    if (!result.ok) {
        // Fallback to NWC (outbound only)
        const nwc = await probeNwc();
        result = {
            ok: nwc.ok,
            source: 'nwc-fallback',
            inbound_sats: null,
            inbound_unknown: true,
            outbound_sats: nwc.outbound_sats || null,
            warn_no_unlock_password: !hadUnlockPassword,
            alby_http_reason: result.reason,
            alby_http_error: result.error,
            alby_http_status: result.http_status,
            nwc_error: nwc.error,
        };
        if (!nwc.ok) {
            log('error', { event: 'both_sources_failed', alby: result.alby_http_reason, nwc: result.nwc_error });
            await _safeNotify({
                category: 'critical',
                title: 'Lightning liquidity monitor: NO DATA',
                body: `Cannot read channel state.\nalby-http: ${result.alby_http_reason || 'unknown'}\nnwc: ${result.nwc_error || 'unknown'}`,
                dedupe_key: 'liquidity_no_data',
            });
            return { exit: 4, result };
        }
        log('warn', {
            event: 'inbound_unknown_using_nwc_fallback',
            outbound_sats: result.outbound_sats,
            alby_http_reason: result.alby_http_reason,
        });
        // Telegram alert ONCE PER PROCESS LIFETIME — reduces noise on PM2
        // cron when the operator hasn't pasted credentials yet.
        if (result.warn_no_unlock_password) {
            if (_emitOnce('liquidity_no_auth')) {
                await _safeNotify({
                    category: 'warning',
                    title: 'Lightning liquidity: inbound unknown (NWC fallback)',
                    body: `Could not read full channel state from Alby Hub HTTP API. Outbound only: ${result.outbound_sats} sats.\nTo fix: set ALBY_UNLOCK_PASSWORD in .env (preferred) or drop the password into ${CFG.UNLOCK_PASSWORD_FILE} (chmod 600).`,
                    dedupe_key: 'liquidity_no_auth',
                });
            }
        } else if (result.alby_http_reason === 'alby-rate-limited' || result.alby_http_status === 429) {
            if (_emitOnce('liquidity_rate_limited')) {
                await _safeNotify({
                    category: 'warning',
                    title: 'Lightning liquidity: Alby unlock rate-limited',
                    body: `Concurrent unlock calls hit Alby Hub 429; outbound only via NWC: ${result.outbound_sats} sats. Next cron tick should recover — no password change needed.`,
                    dedupe_key: 'liquidity_rate_limited',
                });
            }
        } else if (_emitOnce('liquidity_http_fallback')) {
            await _safeNotify({
                category: 'warning',
                title: 'Lightning liquidity: inbound unknown (NWC fallback)',
                body: `Alby Hub HTTP probe failed (${result.alby_http_reason || 'unknown'}: ${result.alby_http_error || '—'}). Outbound only: ${result.outbound_sats} sats. Unlock password is configured; check alby-hub logs.`,
                dedupe_key: 'liquidity_http_fallback',
            });
        }
        lastResult = { ...result, ts: nowIso(), level: 'AUTH_REQUIRED' };
        return { exit: 3, result };
    }

    // Full data path: alby-http
    const level = classify(result.inbound_sats, result.outbound_sats);
    const ratioPct = result.outbound_sats > 0
        ? Math.round((result.inbound_sats * 1000) / result.outbound_sats) / 10
        : null;

    // INFO log every cycle — full channel summary for ops visibility.
    log('info', {
        event: 'liquidity_check',
        level,
        inbound_sats: result.inbound_sats,
        outbound_sats: result.outbound_sats,
        ratio_pct: ratioPct,
        total_capacity_sats: result.total_capacity_sats,
        channel_count: result.channel_count,
        open_count: result.active_count,
        password_source: result.password_source,
        channels: result.channels,
    });

    const body = (
        `inbound:  ${result.inbound_sats} sats\n` +
        `outbound: ${result.outbound_sats} sats (inbound = ${ratioPct ?? '—'}% of outbound)\n` +
        `total cap: ${result.total_capacity_sats} sats over ${result.active_count}/${result.channel_count} open channels\n` +
        `thresholds: WARN if inbound < ${CFG.INBOUND_RATIO_PCT}% of outbound; CRITICAL if inbound < ${CFG.MIN_INBOUND_SATS} sats\n` +
        `recommended action on CRITICAL: buy +${CFG.LSP_RECOMMENDED_BUY_SATS} SAT channel from MegaLith for ~${CFG.LSP_RECOMMENDED_FEE_SATS} SAT fee`
    );

    if (level === 'CRITICAL') {
        await _safeNotify({
            category: 'critical',
            title: 'Lightning inbound liquidity CRITICAL',
            body,
            dedupe_key: 'liquidity_critical',
        });
        lastResult = { ...result, ts: nowIso(), level };
        return { exit: 2, result };
    }
    if (level === 'WARN') {
        await _safeNotify({
            category: 'warning',
            title: 'Lightning inbound liquidity LOW',
            body,
            dedupe_key: 'liquidity_warn',
        });
    } else if (level === 'OK' && lastResult && (lastResult.level === 'CRITICAL' || lastResult.level === 'WARN')) {
        // recovery
        await _safeNotify({
            category: 'info',
            title: 'Lightning inbound liquidity RECOVERED',
            body: `Inbound now ${result.inbound_sats} sats (${ratioPct}% of outbound).`,
            dedupe_key: 'liquidity_recovered',
        });
    }

    lastResult = { ...result, ts: nowIso(), level };
    return { exit: 0, result };
}

function getLastResult() { return lastResult; }

// Reset cached session — exposed for tests + admin endpoint.
function _resetSession() { _albySession = null; _emittedOnce.clear(); }

if (require.main === module) {
    runOnce().then(r => {
        process.stdout.write(JSON.stringify(r.result) + '\n');
        process.exit(r.exit);
    }).catch(e => {
        console.error('FATAL', e && e.stack ? e.stack : e);
        process.exit(1);
    });
}

module.exports = { runOnce, getLastResult, CFG, _resetSession, acquireProcessLock, releaseProcessLock };
