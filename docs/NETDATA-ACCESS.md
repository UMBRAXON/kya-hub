# Netdata Dashboard — Access Guide

The Netdata dashboard is **NOT exposed publicly** (zámerná decízia).
Access is only via **SSH tunnel** from your local machine.

## Quick access (Linux / macOS)

```bash
# 1) Open tunnel from your local machine (terminal 1)
ssh -L 19999:127.0.0.1:19999 root@umbraxon.xyz

# 2) Keep that terminal open, then open browser:
#    http://localhost:19999
```

## Quick access (Windows / PowerShell)

```powershell
# Use the same command in PowerShell (Windows has SSH built-in since 2018):
ssh -L 19999:127.0.0.1:19999 root@umbraxon.xyz
```

Or use **PuTTY**:
1. Connection → SSH → Tunnels
2. Source port: `19999`
3. Destination: `127.0.0.1:19999`
4. Click `Add`, then connect normally
5. Browser → `http://localhost:19999`

## Persistent background tunnel (autossh)

```bash
# On your laptop:
brew install autossh   # or apt install autossh

autossh -M 0 -f -N \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  -L 19999:127.0.0.1:19999 \
  root@umbraxon.xyz
```

## What you'll see

Once connected, you'll have a real-time dashboard with:

| Section | Metrics |
|---------|---------|
| **System** | CPU per core, RAM, swap, load, disk I/O, network |
| **PostgreSQL** | Connections, transactions/sec, cache hit ratio, deadlocks, replication, slow queries |
| **Nginx (kya-hub-proxy)** | Active connections, requests/sec, reading/writing/waiting |
| **Docker** | Per-container CPU / RAM / network / disk (BTCPay, bitcoind, nbxplorer, postgres, nginx, kya-hub-proxy) |
| **Processes** | Per-app stats (pm2 → kyahub, bitcoind, dotnet btcpay, albyhub) |
| **Disk space** | Per-mount fill rate, ETA to full |

## Active custom alerts (Telegram)

| Alert | Threshold | Recipient |
|-------|-----------|-----------|
| `kyahub_disk_usage` | warn > 80%, crit > 90% | sysadmin (Telegram) |
| `kyahub_ram_usage` (true pressure, excludes page cache) | warn > 80%, crit > 92% | sysadmin |
| `kyahub_load_high` (5m load avg, 4 cores) | warn > 6, crit > 12 | sysadmin |
| `kyahub_pg_connection_usage` | warn > 75%, crit > 90% | dba |
| `kyahub_nginx_5xx_rate` | warn > 100, crit > 500 writing conns | webmaster |

Plus **270+ built-in alarms** for everything else (postgres replication, disk I/O,
network stalls, oom risk, systemd unit failures, etc.).

## Telegram bot test

```bash
# On server:
sudo -u netdata /opt/netdata/usr/libexec/netdata/plugins.d/alarm-notify.sh test
```

You should receive 2 Telegram messages: a test CRITICAL and a test CLEAR.

## Stop / start / restart

```bash
systemctl status netdata
systemctl restart netdata
systemctl stop netdata
journalctl -u netdata -f         # live logs
```

## Configuration files

| Path | Purpose |
|------|---------|
| `/opt/netdata/etc/netdata/netdata.conf` | Main (bind 127.0.0.1, retention) |
| `/opt/netdata/etc/netdata/health_alarm_notify.conf` | Telegram credentials |
| `/opt/netdata/etc/netdata/health.d/kya-hub.conf` | Custom alarms |
| `/opt/netdata/etc/netdata/go.d/postgres.conf` | PG collector |
| `/opt/netdata/etc/netdata/go.d/nginx.conf` | Nginx stub_status collector |
| `/opt/netdata/etc/netdata/apps_groups.conf` | Process group tagging |

After editing health configs: `killall -USR2 netdata` (no full restart needed).
After editing collector configs: `systemctl restart netdata`.

## Disable Netdata Cloud (privacy)

Already disabled by:
- Install flag `--disable-telemetry`
- Never running `netdata-claim.sh`

To re-confirm:

```bash
ls /opt/netdata/var/lib/netdata/cloud.d/  # empty/absent = NOT claimed
```

## Memory footprint

Current: **~285 MB RSS** total (Netdata + plugins + go.d collectors).
That's <2% of the 15 GB system RAM.

If you need to reduce further:
- Disable `go.d/postgres` table-level stats (826 charts shrinks dramatically)
- Edit `/opt/netdata/etc/netdata/go.d/postgres.conf`:
  ```yaml
  collect_databases_matching: 'kyahub'  # only kya-hub, skip postgres
  ```
