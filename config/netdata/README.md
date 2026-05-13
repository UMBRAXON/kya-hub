# Netdata config snippets (repo-stored)

These files are **templates** to keep infra changes reviewable in Git.
On the server, copy them into Netdata’s live config tree, e.g.:

```bash
sudo install -d -m 0755 /opt/netdata/etc/netdata/health.d
sudo install -m 0644 /root/kya-hub/config/netdata/health.d/kya-hub-runbook.conf /opt/netdata/etc/netdata/health.d/kya-hub-runbook.conf
sudo killall -USR2 netdata
```

See `docs/NETDATA-ACCESS.md` for the authoritative paths and ops notes.

