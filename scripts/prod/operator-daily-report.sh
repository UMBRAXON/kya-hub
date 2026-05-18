#!/usr/bin/env bash
# Operator daily digest → Telegram
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export DOTENV_CONFIG_QUIET=true
exec node scripts/operator-daily-report.js --telegram
