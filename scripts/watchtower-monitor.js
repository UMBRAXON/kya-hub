#!/usr/bin/env node
'use strict';

// Watchtower monitor (low-risk P2 hardening).
// Reads the Alby Hub PM2 out log and alerts if the "connected to watchtower"
// signal is missing in a sliding time window.
//
// Opt-in:
//   WATCHTOWER_MONITOR_ENABLED=true
//
// Tuning:
//   WATCHTOWER_MONITOR_WINDOW_MIN=30
//   WATCHTOWER_MONITOR_LOG_PATH=/root/.pm2/logs/alby-hub-out.log
//   WATCHTOWER_MONITOR_REGEX=watchtower
//
// Notes:
// - This does NOT configure watchtowers. It only detects missing connectivity
//   once the operator has configured one (docs/WATCHTOWER-SETUP.md).

require('dotenv').config({ path: __dirname + '/../.env' });
const fs = require('fs');
const notifications = require('../lib/notifications');

if (process.env.WATCHTOWER_MONITOR_ENABLED !== 'true') {
  process.exit(0);
}

const WINDOW_MIN = parseInt(process.env.WATCHTOWER_MONITOR_WINDOW_MIN || '30', 10);
const LOG_PATH = process.env.WATCHTOWER_MONITOR_LOG_PATH || '/root/.pm2/logs/alby-hub-out.log';
const REGEX = process.env.WATCHTOWER_MONITOR_REGEX || 'watchtower';

function tailBytes(filePath, bytes) {
  const st = fs.statSync(filePath);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function withinWindow(line, windowMin) {
  // PM2 time:true prefixes logs with ISO timestamp at line start.
  // Example: "2026-05-13T07:08:21.002Z ..."
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/);
  if (!m) return true; // fallback: treat as in-window if unparseable
  const ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) return true;
  return (Date.now() - ts) <= windowMin * 60 * 1000;
}

try {
  if (!fs.existsSync(LOG_PATH)) {
    notifications.notify({
      category: 'warning',
      title: 'Watchtower monitor: log missing',
      body: `path: ${LOG_PATH}\nimpact: cannot verify watchtower connectivity`,
      dedupe_key: 'watchtower_log_missing',
    }).catch(() => {});
    process.exit(0);
  }

  const text = tailBytes(LOG_PATH, 2 * 1024 * 1024); // last ~2MB
  const rx = new RegExp(REGEX, 'i');
  const lines = text.split('\n').filter(Boolean);
  const inWindow = lines.filter((l) => withinWindow(l, WINDOW_MIN));
  const hasSignal = inWindow.some((l) => rx.test(l));

  if (!hasSignal) {
    notifications.notify({
      category: 'critical',
      title: 'Watchtower disconnected (no signal in window)',
      body: `window_min: ${WINDOW_MIN}\nregex: ${REGEX}\nlog: ${LOG_PATH}\naction: verify Alby Hub watchtower config; see docs/WATCHTOWER-SETUP.md`,
      dedupe_key: 'watchtower_disconnected',
    }).catch(() => {});
  }
} catch (e) {
  notifications.notify({
    category: 'warning',
    title: 'Watchtower monitor failed',
    body: `error: ${(e && e.message) ? e.message : String(e)}`.slice(0, 400),
    dedupe_key: 'watchtower_monitor_fail',
  }).catch(() => {});
}

