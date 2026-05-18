#!/usr/bin/env bash
# Interactive Nostr nsec → .env (hidden input). Prefer pasting into secrets/nostr-nsec.txt in the editor.
# See nostr-nsec.example.txt and ./scripts/verify-nostr-key.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=".env"
EXPECTED_NPUB="npub1kqutk06vk9uryjsxem9v60wq9egyw7c9g5plqrtjat2epmkdz0dq5z9nyc"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy from .env.example first." >&2
  exit 1
fi

echo "=== Nostr key setup (Umbraxon PR agent) ==="
echo "Expected public key: $EXPECTED_NPUB"
echo ""
echo "Paste your nsec1... below (characters will NOT be shown), then press Enter."
read -rsp "nsec: " NSEC
echo ""

if [[ -z "${NSEC// }" ]]; then
  echo "Empty input — aborted." >&2
  exit 1
fi

PYBIN="python3"
[[ -x ".venv/bin/python" ]] && PYBIN=".venv/bin/python"
"$PYBIN" - "$NSEC" "$EXPECTED_NPUB" "$ENV_FILE" <<'PY'
import os, re, sys
nsec, expected_npub, env_path = sys.argv[1:4]
try:
    from pynostr.key import PrivateKey
except ImportError:
    print("Install deps: pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)
pk = PrivateKey.from_nsec(nsec.strip())
npub = pk.public_key.bech32()
if npub != expected_npub:
    print(f"ERROR: nsec does not match expected npub.", file=sys.stderr)
    print(f"  got:      {npub}", file=sys.stderr)
    print(f"  expected: {expected_npub}", file=sys.stderr)
    sys.exit(1)
print(f"OK: npub matches {npub[:20]}…")

relays = "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band"
lines = open(env_path, encoding="utf-8").read().splitlines()
out = []
seen_key = seen_relays = seen_pub = False
for line in lines:
    if line.startswith("NOSTR_PRIVATE_KEY="):
        out.append(f"NOSTR_PRIVATE_KEY={nsec.strip()}")
        seen_key = True
    elif line.startswith("NOSTR_RELAYS="):
        out.append(f"NOSTR_RELAYS={relays}")
        seen_relays = True
    elif line.startswith("PR_PUBLISH_PLATFORMS="):
        out.append("PR_PUBLISH_PLATFORMS=moltbook,nostr")
        seen_pub = True
    else:
        out.append(line)
if not seen_key:
    out.append(f"NOSTR_PRIVATE_KEY={nsec.strip()}")
if not seen_relays:
    out.append(f"NOSTR_RELAYS={relays}")
if not seen_pub:
    out.append("PR_PUBLISH_PLATFORMS=moltbook,nostr")
text = "\n".join(out) + "\n"
open(env_path, "w", encoding="utf-8").write(text)
os.chmod(env_path, 0o600)
print(f"Updated {env_path} (mode 600). PR_PUBLISH_PLATFORMS=moltbook,nostr")
PY

echo ""
echo "Next: dry-run post"
echo "  PR_DRY_RUN=true python3 main.py promote --publish --platforms nostr"
echo "Then live:"
echo "  PR_DRY_RUN=false python3 main.py promote --publish --platforms nostr"
