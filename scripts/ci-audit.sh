#!/usr/bin/env bash
# Security gate for CI + Nightly: production audit (high+) on root, mcp, and portal.
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
