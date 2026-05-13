// ============================================================================
// UMBRAXON KYA-Hub — Reputation System (Phase 1.5)
// ============================================================================
// Centralizovaná definícia reputation modelu pre agentov.
//
// Score range: 0 – 1000
//
// Startovacie skóre:
//   BASIC: 500  (NEUTRAL zóna)  — stredná dôvera; identita lacná (10k SATS)
//   ELITE: 900  (ELITE_TIER)    — vysoká dôvera; vyššia investícia + anchor
//
// Manufacturer bonus: +0 až +100 (.env per-mfr)
//   Hardcap pri registrácii = 1000.
//
// Zóny určujú aké operácie smie agent vykonávať:
//   - SUSPENDED: cert prakticky revoked, agent neaktívny
//   - PROBATION: prísne rate limity, žiadne high-trust operácie
//   - NEUTRAL:   štandardné operácie
//   - TRUSTED:   môže atestovať iných agentov (Phase 3 Web-of-Trust)
//   - ELITE_TIER: maximálne benefity, whitelist-ready
// ============================================================================

const ZONES = [
    { min: 0,    max: 199,  name: 'SUSPENDED',  label: 'Suspended (revoked behavior)', allowsOperations: false, badge: '🔴' },
    { min: 200,  max: 399,  name: 'PROBATION',  label: 'On probation',                  allowsOperations: true,  badge: '🟠' },
    { min: 400,  max: 599,  name: 'NEUTRAL',    label: 'Neutral / standard trust',      allowsOperations: true,  badge: '🟡' },
    { min: 600,  max: 799,  name: 'TRUSTED',    label: 'Trusted agent',                 allowsOperations: true,  badge: '🟢' },
    { min: 800,  max: 1000, name: 'ELITE_TIER', label: 'Elite tier',                    allowsOperations: true,  badge: '⭐' },
];

const MIN_SCORE = 0;
const MAX_SCORE = 1000;

// Startovacie skóre per tier
const STARTING_SCORE = {
    BASIC: 500,
    ELITE: 900,
};

// Manufacturer bonus cap (jednotlivý výrobca nemôže pridať viac)
const MAX_MANUFACTURER_BONUS = 100;

/**
 * Vypočíta finálne starting score = tier base + manufacturer bonus, capped na MAX_SCORE.
 */
function computeStartingScore({ tierName, manufacturerBonus = 0 }) {
    const base = STARTING_SCORE[tierName] ?? 100;
    const bonus = Math.min(Math.max(manufacturerBonus || 0, 0), MAX_MANUFACTURER_BONUS);
    return Math.min(base + bonus, MAX_SCORE);
}

/**
 * Vráti zónu pre dané skóre.
 */
function getZone(score) {
    const s = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score || 0)));
    return ZONES.find(z => s >= z.min && s <= z.max) || ZONES[2]; // fallback NEUTRAL
}

/**
 * Boolean: smie agent vykonávať operácie?
 */
function isOperational(score) {
    return getZone(score).allowsOperations;
}

/**
 * Vráti popis zóny + metadata pre vystavenie v certifikáte / dashboarde.
 */
function describe(score) {
    const s = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score || 0)));
    const zone = getZone(s);
    return {
        score: s,
        zone: zone.name,
        zone_label: zone.label,
        zone_badge: zone.badge,
        operational: zone.allowsOperations,
        max_score: MAX_SCORE,
        next_zone: nextZone(s),
    };
}

function nextZone(score) {
    const current = getZone(score);
    const idx = ZONES.indexOf(current);
    if (idx === ZONES.length - 1) return null;
    const next = ZONES[idx + 1];
    return {
        name: next.name,
        threshold: next.min,
        points_needed: next.min - score,
    };
}

/**
 * Slashing katalóg — všetky možné event types a ich delta.
 * Phase 2: tieto sú aplikované cez reputation-engine.js
 */
const SLASHING = {
    // Pozitívne (regenerácia + atestácie)
    SUCCESSFUL_OPERATION:  +1,
    POSITIVE_PEER_REVIEW:  +10,
    LOYALTY_BONUS:         +5,   // udeľované pri pravidelnom heartbeate (Phase 2 worker)
    ADMIN_RESTORE:         +50,  // admin manual restore
    
    // Negatívne — self-reported alebo peer-reported (auto-apply)
    FAILED_VERIFICATION:   -50,  // self-reported fail (bot priznáva)
    NEGATIVE_PEER_REVIEW:  -20,  // peer report od trusted agenta (auto)
    
    // Inactivity / system
    DECAY_WARN:            -1,   // -1/deň po 14 dňoch nealivity
    DECAY_HEAVY:           -5,   // -5/deň po 30 dňoch nealivity
    
    // Serious — vyžaduje admin review
    SPAM_REPORT:           -100,
    FRAUD_PROVEN:          -500,
    PROTOCOL_VIOLATION:    -200,
    ADMIN_MANUAL_SLASH:    -100, // default delta pre admin manual slash (override-able)
};

/**
 * Self-action mapping — čo bot smie self-reportovať a aký delta.
 * Negatívne actions sa aplikujú vždy (priznanie = penalizácia).
 * Pozitívne actions sú rate-limited (pozri SELF_RATE_LIMITS).
 */
const SELF_ACTION_RULES = {
    VERIFICATION_SUCCESS:    { delta: +1,   directionAllowed: 'positive', requiresProofForElite: true },
    VERIFICATION_FAIL:       { delta: -50,  directionAllowed: 'negative', requiresProofForElite: false },
    USER_INTERACTION:        { delta: 0,    directionAllowed: 'neutral',  requiresProofForElite: false },
    TX_BROADCAST_SUCCESS:    { delta: +1,   directionAllowed: 'positive', requiresProofForElite: true },
    TX_BROADCAST_FAIL:       { delta: -10,  directionAllowed: 'negative', requiresProofForElite: false },
    SELF_HEALTH_CHECK:       { delta: 0,    directionAllowed: 'neutral',  requiresProofForElite: false },
    PROTOCOL_ERROR_RECOVERY: { delta: 0,    directionAllowed: 'neutral',  requiresProofForElite: false },
};

/**
 * Rate limits per agent na pozitívne self-reports.
 * Negatívne self-reports nemajú limit (priznanie chyby).
 */
const SELF_RATE_LIMITS = {
    perHourMaxPositive:    1,
    perDayMaxPositive:    10,
    perMonthMaxPositive:  50,
};

/**
 * Rate limits pre peer reports.
 */
const PEER_REPORT_LIMITS = {
    perDayPerTarget: 5,        // jeden reporter môže max 5× za deň reportovať toho istého agenta
    perDayTotal:    20,        // jeden reporter môže max 20 reportov za deň celkom
    minReporterZone: 'NEUTRAL', // reporter musí byť v NEUTRAL+ aby jeho report mal váhu
};

/**
 * Inactivity decay schedule.
 * Aplikuje sa raz denne cez background worker.
 */
const INACTIVITY_DECAY = {
    warnAfterDays:   14,    // -1/deň
    heavyAfterDays:  30,    // -5/deň
    dormantAfterDays: 60,   // flag is_dormant = true (no further decay, ale operation block)
};

/**
 * Vráti zone name podľa skóre (helper pre porovnanie min zón).
 */
function zoneOf(score) {
    return getZone(score).name;
}

/**
 * Skontroluje či zone1 ≥ zone2 v hierarchii.
 */
const ZONE_ORDER = ['SUSPENDED', 'PROBATION', 'NEUTRAL', 'TRUSTED', 'ELITE_TIER'];
function zoneAtLeast(score, minZoneName) {
    const currentIdx = ZONE_ORDER.indexOf(zoneOf(score));
    const minIdx = ZONE_ORDER.indexOf(minZoneName);
    return currentIdx >= 0 && minIdx >= 0 && currentIdx >= minIdx;
}

/**
 * Vráti new score po slashing event (clamped 0-1000).
 */
function applySlashing(currentScore, eventName) {
    const delta = SLASHING[eventName];
    if (delta === undefined) throw new Error('Unknown slashing event: ' + eventName);
    const next = currentScore + delta;
    return Math.max(MIN_SCORE, Math.min(MAX_SCORE, next));
}

module.exports = {
    ZONES,
    ZONE_ORDER,
    STARTING_SCORE,
    MAX_SCORE,
    MIN_SCORE,
    MAX_MANUFACTURER_BONUS,
    SLASHING,
    SELF_ACTION_RULES,
    SELF_RATE_LIMITS,
    PEER_REPORT_LIMITS,
    INACTIVITY_DECAY,
    computeStartingScore,
    getZone,
    isOperational,
    describe,
    applySlashing,
    zoneOf,
    zoneAtLeast,
};
