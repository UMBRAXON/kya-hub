// ============================================================================
// Operator daily report — exclude internal / test agents from production stats
// ============================================================================

const DEFAULT_EXTRA_TEST_NAMES = /^(Agent007)$/i;

/**
 * True if row should be excluded from operator-facing totals (tests, smoke, sandbox).
 * @param {{ kya_id?: string, agent_name?: string }} row
 */
function isTestAgent(row) {
    const kya = String(row.kya_id || '').toUpperCase();
    const name = String(row.agent_name || '');

    const allow = (process.env.OPERATOR_REPORT_ALLOW_KYA_IDS || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    if (allow.length && allow.includes(kya)) return false;
    if (allow.length) return true;

    if (/^UMBRA-TEST-/i.test(kya)) return true;
    if (/^TEST-/i.test(name)) return true;
    if (/^GOV-/i.test(name)) return true;
    if (/^DEMO-/i.test(name)) return true;
    if (/^REPTEST/i.test(name)) return true;
    if (/^ABTEST/i.test(name)) return true;
    if (/UMBRAXONTEST/i.test(name)) return true;
    if (/TEST-WEBHOOK|TEST-BOT|MANUAL_CHECK|real-ln-test|test-denylist|test-export|test-bot/i.test(name)) {
        return true;
    }
    if (DEFAULT_EXTRA_TEST_NAMES.test(name)) return true;

    return false;
}

/** SQL fragment: agents alias `a` counts as production. */
function productionAgentsWhere(alias = 'a') {
    return `(
        ${alias}.kya_id !~* '^UMBRA-TEST-'
        AND ${alias}.agent_name !~* '^(TEST-|GOV-|DEMO-|REPTEST|ABTEST)'
        AND ${alias}.agent_name !~* 'UMBRAXONTEST'
        AND ${alias}.agent_name !~* '(TEST-WEBHOOK|TEST-BOT|MANUAL_CHECK|real-ln-test|test-denylist|test-export|test-bot)'
        AND ${alias}.agent_name !~* '^Agent007$'
    )`;
}

function filterRows(rows) {
    return rows.filter((r) => !isTestAgent(r));
}

function isTestRegistration(row) {
    return isTestAgent({ agent_name: row.agent_name, kya_id: row.kya_id });
}

module.exports = {
    isTestAgent,
    productionAgentsWhere,
    filterRows,
    isTestRegistration,
};
