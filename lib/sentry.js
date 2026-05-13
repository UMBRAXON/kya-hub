// Minimal, safe-by-default Sentry wiring.
//
// Design goals:
// - Opt-in only (no DSN → no-op).
// - Do not send request bodies / secrets / tokens.
// - Keep changes localized so we can remove/replace easily later.

let Sentry = null;

function _scrubEvent(event) {
  try {
    if (event.request) {
      // Remove potentially sensitive parts.
      delete event.request.data;
      delete event.request.cookies;
      if (event.request.headers) {
        const h = { ...event.request.headers };
        for (const k of Object.keys(h)) {
          const lk = k.toLowerCase();
          if (lk.includes('authorization') || lk.includes('cookie') || lk.includes('x-admin-key')) {
            h[k] = '[REDACTED]';
          }
        }
        event.request.headers = h;
      }
    }
  } catch (_) {}
  return event;
}

function init(logger) {
  const dsn = process.env.SENTRY_DSN || '';
  if (!dsn) {
    return { enabled: false };
  }

  // Lazy require so installs are optional in dev environments.
  // (But in production we expect deps to be present.)
  // eslint-disable-next-line global-require
  Sentry = require('@sentry/node');

  const environment = process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production';
  const release = process.env.SENTRY_RELEASE || '';
  const tracesSampleRate = parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0');

  Sentry.init({
    dsn,
    environment,
    release: release || undefined,
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0,
    sendDefaultPii: false,
    beforeSend(event) {
      return _scrubEvent(event);
    },
  });

  logger?.info?.({ sentry: { environment, tracesSampleRate } }, 'Sentry enabled');
  return { enabled: true, Sentry };
}

function isEnabled() {
  return !!Sentry;
}

function requestHandler() {
  if (!Sentry) return null;
  return Sentry.Handlers.requestHandler();
}

function tracingHandler() {
  if (!Sentry) return null;
  return Sentry.Handlers.tracingHandler();
}

function errorHandler() {
  if (!Sentry) return null;
  return Sentry.Handlers.errorHandler();
}

function captureException(err, ctx) {
  if (!Sentry) return;
  try {
    if (ctx) Sentry.setContext('context', ctx);
    Sentry.captureException(err);
  } catch (_) {}
}

module.exports = {
  init,
  isEnabled,
  requestHandler,
  tracingHandler,
  errorHandler,
  captureException,
};

