#!/usr/bin/env bash
# Security gate: production audit (high+) on root, mcp, and portal.
# - CI (push/PR): tvrdý fail
# - Nightly: soft (continue-on-error) — CVE zvonku nesmú spamovať fail mail
# Keep package.json "overrides" floors in sync when a new high/critical lands.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[ci-audit] root (omit=dev, audit-level=high)"
npm audit --omit=dev --audit-level=high

echo "[ci-audit] mcp/ (omit=dev, audit-level=high)"
(
  cd "$ROOT/mcp"
  npm audit --omit=dev --audit-level=high
)

echo "[ci-audit] portal/ (omit=dev, audit-level=high)"
(
  cd "$ROOT/portal"
  npm audit --omit=dev --audit-level=high
)

echo "[ci-audit] OK"
