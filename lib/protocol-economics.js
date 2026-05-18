// ============================================================================
// Public Sybil economics snapshot (honest operator disclosure)
// ============================================================================

/**
 * @param {import('pg').Pool} pool
 */
async function buildEconomicsDoc(pool) {
    let tiers = [];
    try {
        const r = await pool.query(
            `SELECT tier_name AS tier, amount_sats AS base_price_sats, duration_months AS validity_months
             FROM tier_pricing
             WHERE effective_until IS NULL
             ORDER BY amount_sats ASC`,
        );
        tiers = r.rows;
    } catch {
        tiers = [
            { tier: 'BASIC', base_price_sats: 10000, validity_months: 12 },
            { tier: 'ELITE', base_price_sats: 80000, validity_months: null },
        ];
    }

    const basic = tiers.find((t) => t.tier === 'BASIC');
    const basicSats = basic?.base_price_sats || 10000;

    return {
        profile: 'umbraxon-economics-v1',
        disclaimer:
            'Registration fee is a Sybil tax, not a security guarantee. BASIC tier is designed for ' +
            'honest bots; determined attackers can still afford many identities. Combine KYA with ' +
            'your own rate limits, value caps, and optional cert_proof on high-value actions.',
        registration: {
            tiers,
            ban_rereg_multiplier: 'min(3^ban_count, 9)',
            per_ip_daily_intent_cap: parseInt(
                process.env.REGISTRATION_MAX_INTENTS_PER_IP_PER_DAY || '3',
                10,
            ),
            per_ip_per_minute: parseInt(process.env.RATE_V1_REGISTER_PER_MIN || '3', 10),
        },
        sybil_notes: {
            basic_cost_sats: basicSats,
            interpretation:
                `One BASIC identity costs ${basicSats} sats upfront. ` +
                `100 sockpuppets ≈ ${basicSats * 100} sats plus operational overhead — price your gate accordingly.`,
        },
        integrator: {
            read_cache_default_sec: Math.floor(
                parseInt(process.env.INTEGRATOR_READ_CACHE_MS || '60000', 10) / 1000,
            ),
            high_value_gate: 'GET /api/v1/agents/{id}/status?include=cert_proof',
            docs: '/docs/INTEGRATOR-TRUST-GATE.md',
        },
    };
}

module.exports = { buildEconomicsDoc };
