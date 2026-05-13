# Watchtower monitoring (P2) — low-risk baseline

This adds **monitoring only**. It does not change Alby Hub configuration.

## What it does

`scripts/watchtower-monitor.js` reads `/root/.pm2/logs/alby-hub-out.log` and checks
whether the watchtower signal appears within the last N minutes.

If the signal is missing, it sends a Telegram **CRITICAL** notification via
`lib/notifications.js`.

## Enable

In `.env`:

```dotenv
WATCHTOWER_MONITOR_ENABLED=true
WATCHTOWER_MONITOR_WINDOW_MIN=30
# Optional:
# WATCHTOWER_MONITOR_LOG_PATH=/root/.pm2/logs/alby-hub-out.log
# WATCHTOWER_MONITOR_REGEX=watchtower
```

Then:

```bash
pm2 restart ecosystem.config.js --only kya-watchtower-monitor --update-env
pm2 trigger kya-watchtower-monitor
```

## Related docs

- `docs/WATCHTOWER-SETUP.md` (how to configure a watchtower)

