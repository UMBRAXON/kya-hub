#!/usr/bin/env bash
# Persist lower swap tendency on KYA nodes (run once as root).
set -euo pipefail
CONF=/etc/sysctl.d/99-kya-memory.conf
cat > "$CONF" <<'EOF'
# UMBRAXON KYA node — prefer RAM over swap when memory was under pressure historically
vm.swappiness=1
vm.vfs_cache_pressure=50
EOF
sysctl -p "$CONF"
echo "Installed $CONF"
