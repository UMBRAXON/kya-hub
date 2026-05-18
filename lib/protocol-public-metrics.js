// ============================================================================
// Public metrics for investors / integrators (no secrets, cacheable)
// ============================================================================

const protocolEconomics = require('./protocol-economics');
const integratorMetrics = require('./integrator-metrics');
const { productionAgentsWhere } = require('./operator-report-filters');

/**
 * @param {import('pg').Pool} pool
 * @param {{ hubVersion?: string, hubPhase?: string }} [hub]
 */
async function buildPublicMetrics(pool, hub = {}) {
    const [economics, verifySummary, agents, npm] = await Promise.all([
        protocolEconomics.buildEconomicsDoc(pool),
        integratorMetrics.getPublicSummary(pool, { days: 7 }),
        pool.query(
            `SELECT COUNT(*)::int AS n
             FROM agents a
             WHERE a.payment_settled_at IS NOT NULL
               AND ${productionAgentsWhere('a')}`,
        ),
        Promise.resolve({
            package: '@umbraxon_kya/kya-verify',
            url: 'https://www.npmjs.com/package/@umbraxon_kya/kya-verify',
        }),
    ]);

    return {
        profile: 'umbraxon-public-metrics-v1',
        updated_at: new Date().toISOString(),
        hub: {
            version: hub.hubVersion || null,
            phase: hub.hubPhase || null,
            site: 'https://www.umbraxon.xyz',
        },
        traction: {
            production_agents_paid: agents.rows[0]?.n ?? 0,
            integrator_verify_7d: verifySummary.totals || {},
            disclaimer:
                'Early-stage network. Counts exclude UMBRA-TEST-* and obvious test agent names.',
        },
        economics,
        integrator_verify_daily: verifySummary.daily || [],
        developer: {
            npm,
            docs: {
                integrators: 'https://www.umbraxon.xyz/integrators',
                llms_txt: 'https://www.umbraxon.xyz/llms.txt',
                what_we_are_not: '/docs/WHAT-WE-ARE-NOT.md',
                on_chain_status: '/docs/ON-CHAIN-STATUS.md',
            },
        },
    };
}

module.exports = { buildPublicMetrics };
