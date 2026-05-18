// ============================================================================
// UMBRAXON KYA-Hub — in-process TTL cache (integrator read paths)
// ============================================================================

const _store = new Map();

/**
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @param {number} ttlMs
 * @returns {Promise<T>}
 * @template T
 */
async function getOrLoad(key, loader, ttlMs) {
    const now = Date.now();
    const hit = _store.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = await loader();
    _store.set(key, { value, expires: now + ttlMs });
    if (_store.size > 5000) {
        for (const [k, v] of _store) {
            if (v.expires <= now) _store.delete(k);
        }
    }
    return value;
}

function invalidate(key) {
    _store.delete(key);
}

function clear() {
    _store.clear();
}

module.exports = { getOrLoad, invalidate, clear };
