# Sentry (error tracking) — safe-by-default wiring

Sentry is **optional**. If `SENTRY_DSN` is empty, Sentry is disabled and the app runs normally.

## Enable

In `.env`:

```dotenv
SENTRY_DSN=...
SENTRY_ENVIRONMENT=production
# Optional:
# SENTRY_RELEASE=git-<sha>
# SENTRY_TRACES_SAMPLE_RATE=0
```

## Security defaults

Implemented in `lib/sentry.js`:

- `sendDefaultPii: false`
- `beforeSend` removes:
  - `event.request.data` (request body)
  - `event.request.cookies`
  - redacts `authorization`, `cookie`, `x-admin-key` headers

## Ops note

Sentry is fed from:
- Express global error handler
- `uncaughtException` / `unhandledRejection`

