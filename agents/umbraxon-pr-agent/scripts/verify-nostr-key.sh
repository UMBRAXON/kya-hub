#!/usr/bin/env bash
# Overí, že nsec v súbore/env sedí s očakávaným npub (nič nevypisuje).
set -euo pipefail
cd "$(dirname "$0")/.."
EXPECTED="npub1kqutk06vk9uryjsxem9v60wq9egyw7c9g5plqrtjat2epmkdz0dq5z9nyc"
PYBIN="python3"
[[ -x ".venv/bin/python" ]] && PYBIN=".venv/bin/python"
export EXPECTED_NPUB="$EXPECTED"
"$PYBIN" <<'PY'
from config import load_settings
from pynostr.key import PrivateKey
import os
s = load_settings()
key = (s.nostr_private_key or "").strip()
if not key:
    raise SystemExit("NOSTR kľúč chýba — vlož nsec do secrets/nostr-nsec.txt (jeden riadok)")
pk = PrivateKey.from_nsec(key) if key.startswith("nsec") else PrivateKey(bytes.fromhex(key.replace("0x","")))
npub = pk.public_key.bech32()
exp = os.environ["EXPECTED_NPUB"]
if npub != exp:
    raise SystemExit(f"nesedí npub:\n  got {npub}\n  exp {exp}")
print("OK — Nostr kľúč sedí s", exp[:24] + "…")
PY
