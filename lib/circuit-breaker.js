// ============================================================================
// UMBRAXON KYA-Hub — Circuit Breaker (Phase 2.4 follow-up)
// ============================================================================
// Lightweight circuit breaker pre upstream služby (BTCPay, Alby).
// Stavy: CLOSED (normálne) → OPEN (failures > threshold, skip volania) → HALF_OPEN (skús znova po cooldowne)
//
// Použitie:
//   const cb = breaker.get('btcpay');
//   if (!cb.canCall()) return res.status(503).json({...});
//   try { ... cb.onSuccess(); }
//   catch (e) { cb.onFailure(); throw e; }
// ============================================================================

const CFG = {
    FAILURE_THRESHOLD: parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10),
    SUCCESS_THRESHOLD: parseInt(process.env.CB_SUCCESS_THRESHOLD || '2', 10),
    OPEN_DURATION_MS: parseInt(process.env.CB_OPEN_DURATION_MS || '60000', 10), // 60s
    HALF_OPEN_PROBE_LIMIT: 1,
};

class Breaker {
    constructor(name) {
        this.name = name;
        this.state = 'CLOSED';
        this.consecFailures = 0;
        this.consecSuccesses = 0;
        this.openedAt = 0;
        this.halfOpenProbes = 0;
        this.metrics = { calls: 0, blocked: 0, failures: 0, recoveries: 0 };
    }

    canCall() {
        this.metrics.calls++;
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN') {
            if (Date.now() - this.openedAt >= CFG.OPEN_DURATION_MS) {
                this.state = 'HALF_OPEN';
                this.halfOpenProbes = 0;
                return true;
            }
            this.metrics.blocked++;
            return false;
        }
        // HALF_OPEN — povoľ obmedzený počet skusobných requestov
        if (this.halfOpenProbes < CFG.HALF_OPEN_PROBE_LIMIT) {
            this.halfOpenProbes++;
            return true;
        }
        this.metrics.blocked++;
        return false;
    }

    onSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.consecSuccesses++;
            if (this.consecSuccesses >= CFG.SUCCESS_THRESHOLD) {
                this._close();
            }
        } else if (this.state === 'CLOSED') {
            this.consecFailures = 0;
        }
    }

    onFailure() {
        this.metrics.failures++;
        if (this.state === 'HALF_OPEN') {
            this._open();
            return;
        }
        this.consecFailures++;
        if (this.consecFailures >= CFG.FAILURE_THRESHOLD) {
            this._open();
        }
    }

    _open() {
        if (this.state !== 'OPEN') {
            this.state = 'OPEN';
            this.openedAt = Date.now();
            this.consecSuccesses = 0;
            this.halfOpenProbes = 0;
        }
    }

    _close() {
        this.state = 'CLOSED';
        this.consecFailures = 0;
        this.consecSuccesses = 0;
        this.halfOpenProbes = 0;
        this.openedAt = 0;
        this.metrics.recoveries++;
    }

    snapshot() {
        return {
            name: this.name,
            state: this.state,
            consec_failures: this.consecFailures,
            consec_successes: this.consecSuccesses,
            opened_at: this.openedAt ? new Date(this.openedAt).toISOString() : null,
            opens_until_ms: this.state === 'OPEN'
                ? Math.max(0, CFG.OPEN_DURATION_MS - (Date.now() - this.openedAt))
                : 0,
            metrics: { ...this.metrics },
        };
    }
}

const registry = new Map();

function get(name) {
    if (!registry.has(name)) registry.set(name, new Breaker(name));
    return registry.get(name);
}

function snapshotAll() {
    return Array.from(registry.values()).map(b => b.snapshot());
}

module.exports = { CFG, get, snapshotAll, Breaker };
