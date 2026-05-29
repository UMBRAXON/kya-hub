#!/usr/bin/env node
'use strict';

// Public web uptime probe → Telegram/Discord via lib/notifications.
// Alerts on transition DOWN and RECOVERY (persistent state file).
//
// Env:
//   WEB_UPTIME_URL=https://www.umbraxon.xyz/
//   WEB_UPTIME_FAIL_THRESHOLD=2   (consecutive failures before DOWN alert)
//   WEB_UPTIME_TIMEOUT_MS=12000
//   WEB_UPTIME_STATE_PATH=/root/kya-hub/logs/growth/web-uptime.json

const fs = require('fs');
const path = require('path');
const notifications = require('../../lib/notifications');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..');
const URL = String(process.env.WEB_UPTIME_URL || 'https://www.umbraxon.xyz/').trim();
const FAIL_THRESHOLD = Math.max(1, parseInt(process.env.WEB_UPTIME_FAIL_THRESHOLD || '2', 10));
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.WEB_UPTIME_TIMEOUT_MS || '12000', 10));
const STATE_PATH = process.env.WEB_UPTIME_STATE_PATH || path.join(ROOT, 'logs', 'growth', 'web-uptime.json');

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return { status: 'up', consecutive_failures: 0, last_status_code: null };
    }
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { status: 'up', consecutive_failures: 0, last_status_code: null };
  }
}

function saveState(st) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  st.updated_at = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n', 'utf-8');
}

async function probe(targetUrl) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': 'UMBRAXON-KYA-uptime-watch/1.0' },
    });
    clearTimeout(timer);
    const ok = res.status >= 200 && res.status < 400;
    return {
      ok,
      status: res.status,
      ms: Date.now() - started,
      error: null,
    };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      error: e && e.message ? e.message : String(e),
    };
  }
}

async function main() {
  const st = loadState();
  const result = await probe(URL);
  const prevStatus = st.status === 'down' ? 'down' : 'up';

  if (result.ok) {
    st.consecutive_failures = 0;
    st.last_status_code = result.status;
    st.last_ok_ms = result.ms;

    if (prevStatus === 'down') {
      await notifications.notify({
        category: 'info',
        title: 'Web is back online',
        body: `url: ${escapeHtml(URL)}\nhttp: ${result.status}\nlatency: ${result.ms}ms`,
        dedupe_key: 'web_uptime_recovered',
      });
      st.status = 'up';
      st.recovered_at = new Date().toISOString();
    } else {
      st.status = 'up';
    }

    saveState(st);
    return;
  }

  st.consecutive_failures = Number(st.consecutive_failures || 0) + 1;
  st.last_status_code = result.status;
  st.last_error = result.error;
  st.last_fail_ms = result.ms;

  const shouldAlert = prevStatus === 'up' && st.consecutive_failures >= FAIL_THRESHOLD;
  const stillDown = prevStatus === 'down';

  if (shouldAlert) {
    const detail = result.status != null
      ? `http: ${result.status}`
      : `error: ${escapeHtml(result.error).slice(0, 200)}`;
    await notifications.notify({
      category: 'critical',
      title: 'Web is DOWN',
      body: `url: ${escapeHtml(URL)}\n${detail}\nfailures: ${st.consecutive_failures}/${FAIL_THRESHOLD}\nlatency: ${result.ms}ms`,
      dedupe_key: 'web_uptime_down',
    });
    st.status = 'down';
    st.down_since = st.down_since || new Date().toISOString();
  } else if (stillDown) {
    st.status = 'down';
  }

  saveState(st);
}

main().catch((e) => {
  notifications.notify({
    category: 'warning',
    title: 'Web uptime watcher failed',
    body: `url: ${escapeHtml(URL)}\nerror: ${escapeHtml(e && e.message ? e.message : String(e)).slice(0, 300)}`,
    dedupe_key: 'web_uptime_watch_error',
  }).catch(() => {});
  process.exit(1);
});
