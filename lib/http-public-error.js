// ============================================================================
// Safe JSON errors for unauthenticated / integrator-facing routes
// ============================================================================

/**
 * Map thrown errors to a stable client code (never raw e.message).
 * @param {unknown} err
 * @param {string} [fallback]
 */
function clientErrorCode(err, fallback = 'INTERNAL') {
    const e = err && typeof err === 'object' ? err : {};
    const code = e.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
        return code;
    }
    return fallback;
}

/** @param {import('express').Response} res */
function send500(res, code = 'INTERNAL') {
    return res.status(500).json({ error: code });
}

/** Strip internal `message` fields from library error objects on 4xx/5xx. */
function sanitizeLibError(r) {
    if (!r || typeof r !== 'object' || !r.error) return r;
    const out = { ...r };
    if (out.message && typeof out.error === 'string') {
        delete out.message;
    }
    return out;
}

module.exports = { clientErrorCode, send500, sanitizeLibError };
