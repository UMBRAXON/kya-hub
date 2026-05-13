/**
 * Chronological kya_id allocation (UMBRA- + 6 zero-padded decimal digits).
 * Uses PostgreSQL sequence hub_kya_seq; retries on rare collision with legacy random IDs.
 */
const MAX_DECIMAL_SUFFIX = 999_999;

/**
 * @param {import('pg').PoolClient} client — must be inside an open transaction
 * @returns {Promise<string>} e.g. UMBRA-000016
 */
async function allocateSequentialKyaId(client, { maxAttempts = 64 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const { rows } = await client.query("SELECT nextval('hub_kya_seq')::bigint AS n");
        const n = Number(rows[0].n);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error('allocateSequentialKyaId: invalid sequence value');
        }
        if (n > MAX_DECIMAL_SUFFIX) {
            const err = new Error('KYA_ID_SEQUENCE_EXHAUSTED');
            err.code = 'KYA_ID_SEQUENCE_EXHAUSTED';
            throw err;
        }
        const axisId = 'UMBRA-' + String(n).padStart(6, '0');
        const chk = await client.query(
            'SELECT 1 AS x FROM agents WHERE kya_id = $1 LIMIT 1',
            [axisId]
        );
        if (chk.rowCount === 0) {
            return axisId;
        }
    }
    const err = new Error('allocateSequentialKyaId: collision budget exhausted');
    err.code = 'KYA_ID_ALLOCATION_FAILED';
    throw err;
}

module.exports = {
    allocateSequentialKyaId,
    MAX_DECIMAL_SUFFIX,
};
