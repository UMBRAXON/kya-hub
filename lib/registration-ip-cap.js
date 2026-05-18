// ============================================================================
// Per-IP daily cap on new registration intents (Sybil cost amplifier)
// ============================================================================

const DEFAULT_MAX = parseInt(process.env.REGISTRATION_MAX_INTENTS_PER_IP_PER_DAY || '3', 10);

/**
 * @param {{ poolGetter: () => import('pg').Pool, maxPerDay?: number, adminBypass?: (req: any) => boolean }} opts
 */
function buildMiddleware(opts) {
    const maxPerDay = Number.isFinite(opts.maxPerDay) ? opts.maxPerDay : DEFAULT_MAX;
    return async function registrationIpDailyCap(req, res, next) {
        if (opts.adminBypass && opts.adminBypass(req)) return next();
        if (maxPerDay <= 0) return next();
        const pool = opts.poolGetter();
        const ip = req.ip || req.socket?.remoteAddress;
        if (!ip) return next();
        try {
            const r = await pool.query(
                `SELECT COUNT(*)::int AS n
                 FROM registration_intents
                 WHERE client_ip = $1::inet
                   AND created_at > NOW() - INTERVAL '24 hours'
                   AND status NOT IN ('CANCELLED', 'EXPIRED')`,
                [ip],
            );
            if ((r.rows[0]?.n || 0) >= maxPerDay) {
                return res.status(429).json({
                    error: 'REGISTRATION_IP_DAILY_CAP',
                    message: `Max ${maxPerDay} registration intents per IP per 24h on this hub.`,
                    retry_after_hours: 24,
                });
            }
            return next();
        } catch {
            return next();
        }
    };
}

module.exports = { buildMiddleware, DEFAULT_MAX };
