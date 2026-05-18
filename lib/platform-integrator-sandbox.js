// ============================================================================
// UMBRAXON KYA-Hub — Integrator sandbox (no DB; for docs and CI)
// ============================================================================
// IDs: UMBRA-TEST-0001 … UMBRA-TEST-9999 (documented fixtures + modulo presets)

const SANDBOX_RE = /^UMBRA-TEST-[0-9]{4}$/;

function isSandboxKyaId(kya_id) {
    return SANDBOX_RE.test(kya_id || '');
}

/** @returns {'verified'|'unverified'|'revoked'|'not_found'} */
function sandboxScenario(kya_id) {
    const n = parseInt(String(kya_id).slice(-4), 10);
    if (!Number.isFinite(n)) return 'not_found';
    if (n === 0) return 'not_found';
    const mod = n % 10;
    if (mod === 1 || mod === 2) return 'verified';
    if (mod === 3 || mod === 4) return 'unverified';
    if (mod === 5) return 'revoked';
    return 'verified';
}

function statusBody(kya_id) {
    const sc = sandboxScenario(kya_id);
    if (sc === 'not_found') {
        return { error: 'AGENT_NOT_FOUND', status: 404 };
    }
    if (sc === 'verified') {
        return {
            status: 200,
            body: {
                kya_id,
                verified: true,
                trust_level: 'TRUSTED',
                reasons: undefined,
                tier: 'BASIC',
                agent_status: 'VERIFIED',
                serial: `SANDBOX-${kya_id.slice(-4)}`,
                _sandbox: true,
            },
        };
    }
    if (sc === 'unverified') {
        return {
            status: 200,
            body: {
                kya_id,
                verified: false,
                trust_level: 'LIMITED',
                reasons: ['SANDBOX_FIXTURE_UNVERIFIED'],
                tier: 'BASIC',
                agent_status: 'VERIFIED',
                serial: null,
                _sandbox: true,
            },
        };
    }
    return {
        status: 200,
        body: {
            kya_id,
            verified: false,
            trust_level: 'REVOKED',
            reasons: ['CERT_REVOKED', 'SANDBOX_FIXTURE'],
            tier: 'BASIC',
            agent_status: 'SUSPENDED',
            serial: `SANDBOX-REV-${kya_id.slice(-4)}`,
            _sandbox: true,
        },
    };
}

function agentBody(kya_id) {
    const st = statusBody(kya_id);
    if (st.error) return st;
    const sc = sandboxScenario(kya_id);
    const score = sc === 'verified' ? 720 : sc === 'unverified' ? 420 : 180;
    return {
        status: 200,
        body: {
            api_version: '1.0',
            kya_id,
            agent_name: `sandbox-agent-${kya_id.slice(-4)}`,
            tier: 'BASIC',
            grade: 'B',
            agent_status: st.body.agent_status,
            public_key: null,
            trust: {
                verified: st.body.verified,
                trust_level: st.body.trust_level,
                reasons: st.body.reasons,
            },
            reputation: {
                score,
                zone: score >= 600 ? 'TRUSTED' : score >= 400 ? 'NEUTRAL' : 'PROBATION',
                zone_label: 'Sandbox fixture',
                zone_badge: '🧪',
                operational: score >= 200,
                max_score: 1000,
                next_zone: null,
            },
            liveness: { status: 'ACTIVE', is_dormant: false, _sandbox: true },
            certificate: st.body.serial
                ? {
                      serial: st.body.serial,
                      issued_at: '2026-01-01T00:00:00.000Z',
                      valid_until: '2027-01-01T00:00:00.000Z',
                      revoked_at: sc === 'revoked' ? '2026-03-01T00:00:00.000Z' : null,
                  }
                : null,
            integrations: { discovery_opt_in: false },
            payment_hints: [],
            links: {
                cert: `/api/cert/${kya_id}`,
                cert_status: `/api/cert/${kya_id}/status`,
                reputation: `/api/agent/${kya_id}/reputation`,
            },
            _sandbox: true,
            _sandbox_doc: 'https://www.umbraxon.xyz/integrators',
        },
    };
}

module.exports = {
    SANDBOX_RE,
    isSandboxKyaId,
    sandboxScenario,
    statusBody,
    agentBody,
};
