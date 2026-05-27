#!/usr/bin/env node
/**
 * Minimal Mastodon scheduler: posts due markdown files and records state.
 *
 * - No LLM generation. Content is curated in-repo.
 * - Safe by default: requires explicit token file or env var.
 *
 * Posts directory format:
 * - scripts/mastodon/posts/*.md
 * - First non-empty line may be: "SCHEDULED_AT=2026-05-27T10:00:00Z" (optional; else "now")
 * - Remaining content is used as status text (max 500 chars unless server allows more).
 */
const { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// __dirname = <repo>/scripts/mastodon. Repo root is two levels up.
const ROOT = join(__dirname, "..", "..");
const POSTS_DIR = process.env.MASTODON_POSTS_DIR || join(ROOT, "scripts", "mastodon", "posts");
const STATE_PATH = process.env.MASTODON_STATE_PATH || join(ROOT, "logs", "growth", "mastodon-posted.json");
const TOKEN_FILE = process.env.MASTODON_TOKEN_FILE || join(ROOT, ".secrets", "mastodon.token");
const BASE_URL = (process.env.MASTODON_BASE_URL || "https://mastodon.social").replace(/\/+$/, "");
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

function nowIso() {
  return new Date().toISOString();
}

function parseScheduledAt(firstLine) {
  const m = firstLine.match(/^SCHEDULED_AT=(.+)$/);
  if (!m) return null;
  const d = new Date(m[1]);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function readToken() {
  const env = process.env.MASTODON_ACCESS_TOKEN;
  if (env && env.trim()) return env.trim();
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf-8").trim();
  return "";
}

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { posted: {} };
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { posted: {} };
  }
}

function saveState(state) {
  const dir = join(STATE_PATH, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function pickDuePosts(state) {
  if (!existsSync(POSTS_DIR)) return [];
  const files = readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  const due = [];
  const now = new Date();
  for (const f of files) {
    if (state.posted?.[f]) continue;
    const full = join(POSTS_DIR, f);
    const raw = readFileSync(full, "utf-8");
    const lines = raw.split(/\r?\n/);
    const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
    const firstLine = firstNonEmptyIdx >= 0 ? lines[firstNonEmptyIdx].trim() : "";
    const scheduledAt = parseScheduledAt(firstLine);
    const bodyStart = scheduledAt ? firstNonEmptyIdx + 1 : firstNonEmptyIdx;
    const text = lines.slice(Math.max(0, bodyStart)).join("\n").trim();
    if (!text) continue;
    if (scheduledAt && scheduledAt > now) continue;
    due.push({ file: f, text });
  }
  return due;
}

async function postStatus(token, text) {
  const res = await fetch(`${BASE_URL}/api/v1/statuses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      "User-Agent": "kya-hub-mastodon-scheduler/1.0 (+https://www.umbraxon.xyz)",
    },
    body: new URLSearchParams({ status: text }).toString(),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`mastodon_post_failed status=${res.status} body=${body.slice(0, 500)}`);
  return JSON.parse(body);
}

async function main() {
  const token = readToken();
  if (!token) {
    console.error("Missing Mastodon token. Set MASTODON_ACCESS_TOKEN or create .secrets/mastodon.token");
    process.exit(2);
  }

  const state = loadState();
  const due = pickDuePosts(state);
  if (due.length === 0) {
    console.log(`[mastodon] no due posts @ ${nowIso()}`);
    return;
  }

  // Safety: max 1 post/run unless explicitly overridden
  const max = Number(process.env.MASTODON_MAX_PER_RUN || "1");
  const toSend = due.slice(0, Math.max(1, max));

  let didPost = false;
  for (const p of toSend) {
    const text = p.text.length > 500 ? p.text.slice(0, 497) + "…" : p.text;
    if (DRY_RUN) {
      console.log(`[mastodon][dry-run] would post ${p.file} (${text.length} chars)`);
      console.log(text);
      continue;
    }

    const out = await postStatus(token, text);
    state.posted ||= {};
    state.posted[p.file] = { id: out?.id, url: out?.url, posted_at: nowIso() };
    console.log(`[mastodon] posted ${p.file} → ${out?.url || out?.id || "ok"}`);
    didPost = true;
  }

  if (!DRY_RUN && didPost) saveState(state);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

