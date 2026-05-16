#!/usr/bin/env bash
# PR agent Python — uses project venv when present.
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  exec "$ROOT/.venv/bin/python" "$@"
fi
exec python3 "$@"
