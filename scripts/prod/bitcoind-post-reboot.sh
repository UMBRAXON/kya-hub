#!/usr/bin/env bash
# After host reboot: load kya-anchor wallet in BTCPay bitcoind (Docker IP is auto-resolved in lib/bitcoind-rpc.js).
set -euo pipefail
CONTAINER="${BITCOIND_RPC_DOCKER_CONTAINER:-btcpayserver_bitcoind}"
PORT="${BITCOIND_RPC_PORT:-43782}"
WALLET="${BITCOIND_ANCHOR_WALLET:-kya-anchor}"

loaded="$(docker exec "$CONTAINER" bitcoin-cli -datadir=/data -rpcport="$PORT" listwallets 2>/dev/null || echo '[]')"
if echo "$loaded" | grep -q "\"$WALLET\""; then
  echo "bitcoind: wallet $WALLET already loaded"
  exit 0
fi
docker exec "$CONTAINER" bitcoin-cli -datadir=/data -rpcport="$PORT" loadwallet "$WALLET"
echo "bitcoind: loaded wallet $WALLET"
