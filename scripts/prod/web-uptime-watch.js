#!/usr/bin/env node
'use strict';

// Multi-site public web uptime probe → Telegram/Discord via lib/notifications.
// Alerts on transition DOWN and RECOVERY per URL (persistent state file).
//
// Env:
//   WEB_UPTIME_URLS=https://www.nakus.sk/,https://www.klubo.sk/,https://www.umbraxon.xyz/
//   WEB_UPTIME_URL=…                 (legacy single URL; used if URLS unset)
//   WEB_UPTIME_FAIL_THRESHOLD=2      (consecutive failures before DOWN alert)
//   WEB_UPTIME_TIMEOUT_MS=12000
//   WEB_UPTIME_STATE_PATH=/root/kya-hub/logs/growth/web-uptime.json

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const notifications = require('../../lib/notifications');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..');
const ENSURE_EDGE = path.join(ROOT, 'scripts', 'prod', 'ensure-public-edge.sh');
const DEFAULT_URLS = [
  'https://www.nakus.sk/',
  'https://www.klubo.sk/',
  'https://www.umbraxon.xyz/',
];
const FAIL_THRESHOLD = Math.max(1, parseInt(process.env.WEB_UPTIME_FAIL_THRESHOLD || '2', 10));
const TIMEOUT_MS = Math.max(3000, parseInt(process.env.WEB_UPTIME_TIMEOUT_MS || '12000', 10));
const STATE_PATH =
  process.env.WEB_UPTIME_STATE_PATH || path.join(ROOT, 'logs', 'growth', 'web-uptime.json');
const AUTO_HEAL = String(process.env.WEB_UPTIME_AUTO_HEAL || '1') !== '0';

function tryHealPublicEdge(reason) {
  if (!AUTO_HEAL) return false;
  if (!fs.existsSync(ENSURE_EDGE)) return false;
  try {
    execFileSync(ENSURE_EDGE, [], {
      timeout: 45000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`[web-uptime] ensure-public-edge OK (${reason})`);
    return true;
  } catch (e) {
    console.warn(
      `[web-uptime] ensure-public-edge failed (${reason}):`,
      e && e.message ? e.message : e
    );
    return false;
  }
}

function parseUrls() {
  const raw = String(process.env.WEB_UPTIME_URLS || '').trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const legacy = String(process.env.WEB_UPTIME_URL || '').trim();
  if (legacy) return [legacy];
  return DEFAULT_URLS;
}

function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function defaultSiteState() {
  return {
    status: 'up',
    consecutive_failures: 0,
    last_status_code: null,
  };
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return { sites: {}, updated_at: null };
    }
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    // Migrate legacy single-site shape → multi-site
    if (!raw.sites && (raw.status || raw.consecutive_failures != null)) {
      const legacyUrl = String(process.env.WEB_UPTIME_URL || 'https://www.umbraxon.xyz/').trim();
      return {
        sites: {
          [legacyUrl]: {
            status: raw.status === 'down' ? 'down' : 'up',
            consecutive_failures: Number(raw.consecutive_failures || 0),
            last_status_code: raw.last_status_code ?? null,
            last_ok_ms: raw.last_ok_ms,
            last_error: raw.last_error,
            last_fail_ms: raw.last_fail_ms,
            down_since: raw.down_since,
            recovered_at: raw.recovered_at,
          },
        },
        updated_at: raw.updated_at || null,
      };
    }
    return { sites: raw.sites || {}, updated_at: raw.updated_at || null };
  } catch {
    return { sites: {}, updated_at: null };
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
      headers: { 'User-Agent': 'UMBRAXON-KYA-uptime-watch/2.0 (+multi-site)' },
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

async function checkOne(url, st) {
  const site = { ...defaultSiteState(), ...(st.sites[url] || {}) };
  const result = await probe(url);
  const prevStatus = site.status === 'down' ? 'down' : 'up';
  const label = siteLabel(url);
  const dedupeBase = `web_uptime:${label}`;

  if (result.ok) {
    site.consecutive_failures = 0;
    site.last_status_code = result.status;
    site.last_ok_ms = result.ms;
    site.last_error = null;

    if (prevStatus === 'down') {
      await notifications.notify({
        category: 'info',
        title: `${label} is back online`,
        body: `url: ${escapeHtml(url)}\nhttp: ${result.status}\nlatency: ${result.ms}ms`,
        dedupe_key: `${dedupeBase}:recovered`,
      });
      site.status = 'up';
      site.recovered_at = new Date().toISOString();
      site.down_since = null;
    } else {
      site.status = 'up';
    }

    st.sites[url] = site;
    return { url, ok: true, result };
  }

  site.consecutive_failures = Number(site.consecutive_failures || 0) + 1;
  site.last_status_code = result.status;
  site.last_error = result.error;
  site.last_fail_ms = result.ms;

  const shouldAlert = prevStatus === 'up' && site.consecutive_failures >= FAIL_THRESHOLD;

  if (shouldAlert) {
    const detail =
      result.status != null
        ? `http: ${result.status}`
        : `error: ${escapeHtml(result.error).slice(0, 200)}`;
    await notifications.notify({
      category: 'critical',
      title: `${label} is DOWN`,
      body: `url: ${escapeHtml(url)}\n${detail}\nfailures: ${site.consecutive_failures}/${FAIL_THRESHOLD}\nlatency: ${result.ms}ms`,
      dedupe_key: `${dedupeBase}:down`,
    });
    site.status = 'down';
    site.down_since = site.down_since || new Date().toISOString();
  } else if (prevStatus === 'down') {
    site.status = 'down';
  }

  st.sites[url] = site;
  return { url, ok: false, result };
}

async function main() {
  const urls = parseUrls();
  const st = loadState();
  if (!st.sites) st.sites = {};

  // Pre-heal when any site already marked down (post docker/containerd cutover)
  const anyDown = urls.some((u) => (st.sites[u] || {}).status === 'down');
  if (anyDown) tryHealPublicEdge('state-down');

  let failCount = 0;
  for (const url of urls) {
    const r = await checkOne(url, st);
    if (!r.ok) failCount += 1;
  }

  // If majority of sites fail once, heal edge and re-probe once (avoids overnight 521)
  if (failCount >= Math.ceil(urls.length / 2)) {
    if (tryHealPublicEdge(`probe-fails=${failCount}`)) {
      for (const url of urls) {
        await checkOne(url, st);
      }
    }
  }

  // Drop stale URLs no longer in config (keep file tidy)
  for (const key of Object.keys(st.sites)) {
    if (!urls.includes(key)) delete st.sites[key];
  }

  saveState(st);
}

main().catch((e) => {
  notifications
    .notify({
      category: 'warning',
      title: 'Web uptime watcher failed',
      body: `error: ${escapeHtml(e && e.message ? e.message : String(e)).slice(0, 300)}`,
      dedupe_key: 'web_uptime_watch_error',
    })
    .catch(() => {});
  process.exit(1);
});
