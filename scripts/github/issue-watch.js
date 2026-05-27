#!/usr/bin/env node
'use strict';

// GitHub issue watcher (Telegram/Discord alert via lib/notifications).
// Polls issue comments via `gh api` and notifies on new comments since last seen.
//
// Env:
//   GITHUB_ISSUE_WATCH_REPO=UMBRAXON/kya-hub
//   GITHUB_ISSUE_WATCH_NUMBER=10
//   GITHUB_ISSUE_WATCH_STATE_PATH=/root/kya-hub/logs/growth/issue-watch.json
//   GITHUB_ISSUE_WATCH_MAX_NOTIFY=5
//
// Notes:
// - Uses GitHub CLI auth already on the box (gh).
// - Stores last seen comment id; no secrets in state.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const notifications = require('../../lib/notifications');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const REPO = process.env.GITHUB_ISSUE_WATCH_REPO || 'UMBRAXON/kya-hub';
const NUMBER = String(process.env.GITHUB_ISSUE_WATCH_NUMBER || '10');
const ROOT = path.join(__dirname, '..', '..');
const STATE_PATH = process.env.GITHUB_ISSUE_WATCH_STATE_PATH || path.join(ROOT, 'logs', 'growth', 'issue-watch.json');
const MAX_NOTIFY = parseInt(process.env.GITHUB_ISSUE_WATCH_MAX_NOTIFY || '5', 10);

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return { last_comment_id: 0 };
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { last_comment_id: 0 };
  }
}

function saveState(st) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n', 'utf-8');
}

function ghApiJson(route) {
  const r = spawnSync('gh', ['api', route, '--paginate'], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`gh api failed: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  const txt = (r.stdout || '').trim();
  if (!txt) return [];
  return JSON.parse(txt);
}

function stripBody(body) {
  const s = String(body || '').replace(/\r/g, '');
  const oneLine = s.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  return oneLine.length > 240 ? oneLine.slice(0, 237) + '…' : oneLine;
}

async function main() {
  const st = loadState();
  const lastSeen = Number(st.last_comment_id || 0);

  const route = `repos/${REPO}/issues/${NUMBER}/comments?per_page=100`;
  const comments = ghApiJson(route);
  if (!Array.isArray(comments) || comments.length === 0) return;

  const fresh = comments
    .filter((c) => Number(c.id || 0) > lastSeen)
    .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));

  if (fresh.length === 0) return;

  const toNotify = fresh.slice(0, Math.max(1, MAX_NOTIFY));
  for (const c of toNotify) {
    const user = c.user?.login || '(unknown)';
    const url = c.html_url || '';
    const snippet = stripBody(c.body || '');
    await notifications.notify({
      category: 'info',
      title: `GitHub issue #${NUMBER}: new comment`,
      body: `repo: ${escapeHtml(REPO)}\nby: ${escapeHtml(user)}\nurl: ${escapeHtml(url)}\n\n${escapeHtml(snippet)}`,
      dedupe_key: `gh_issue_${NUMBER}_comment_${c.id}`,
    }).catch(() => {});
  }

  const newest = fresh[fresh.length - 1];
  saveState({ last_comment_id: Number(newest.id || lastSeen), updated_at: new Date().toISOString() });
}

main().catch((e) => {
  notifications.notify({
    category: 'warning',
    title: 'GitHub issue watcher failed',
    body: `repo: ${escapeHtml(REPO)}\nissue: ${escapeHtml(NUMBER)}\nerror: ${escapeHtml(e && e.message ? e.message : String(e)).slice(0, 400)}`,
    dedupe_key: `gh_issue_watch_fail_${NUMBER}`,
  }).catch(() => {});
  process.exit(1);
});

