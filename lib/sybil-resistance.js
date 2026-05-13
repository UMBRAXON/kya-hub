// ============================================================================
// UMBRAXON KYA-Hub — Sybil Resistance (Phase 2.4)
// ============================================================================
// Mitigation proti Web-of-Trust Sybil útokom.
//
// THREAT MODEL:
//   Útočník kúpi 5 BASIC licencií za ~50 EUR. Vznikne 5 čerstvých botov v NEUTRAL.
//   Tí si navzájom posielajú POSITIVE_PEER_REVIEW (+10 each) → po pár dňoch
//   sú všetci v TRUSTED (700+). Cena Sybilu: ~50 EUR za 5 falošných TRUSTED.
//
// 3 LAYERS OBRANY:
//
// A) AGE WEIGHTING
//    Reporter mladší ako N dní má znížený vplyv:
//      ≤ 30 dní     → 0.25× (25 %)
//      31–90 dní    → 0.50× (50 %)
//      91–180 dní   → 0.85× (85 %)
//      > 180 dní    → 1.00× (full weight)
//    Tým útočník musí čakať mesiace, aby jeho boti mali plný vplyv.
//
// B) TIER WEIGHTING
//    BASIC reporter → 0.7× váha
//    ELITE reporter → 1.5× váha (overený anchor, vyššia investícia)
//    + Manufacturer-verified bonus 1.2× (overená MFR identita)
//
// C) CIRCLE DETECTION
//    Ak reporter A reportoval target B v posledných 30d AND naopak (B → A),
//    obaja sú pravdepodobne v Sybil krúžku → weight = 0.1× (90 % discount)
//    a admin alert sa loguje.
//
// Finálny delta = base_delta × age_weight × tier_weight × circle_penalty
// Min absolute delta = 1 (aby sa nestratilo úplne, ale je signal).
// ============================================================================

const CFG = {
    ENABLED: process.env.SYBIL_RESISTANCE !== 'false',
    
    AGE_BUCKETS_DAYS: [
        { maxDays: 30,  weight: 0.25 },
        { maxDays: 90,  weight: 0.50 },
        { maxDays: 180, weight: 0.85 },
        { maxDays: Infinity, weight: 1.00 },
    ],
    
    TIER_WEIGHTS: {
        BASIC: parseFloat(process.env.SYBIL_TIER_WEIGHT_BASIC || '0.70'),
        ELITE: parseFloat(process.env.SYBIL_TIER_WEIGHT_ELITE || '1.50'),
    },
    MFR_VERIFIED_MULTIPLIER: parseFloat(process.env.SYBIL_MFR_BONUS || '1.20'),
    
    CIRCLE_LOOKBACK_DAYS: parseInt(process.env.SYBIL_CIRCLE_LOOKBACK_DAYS || '30', 10),
    CIRCLE_PENALTY: parseFloat(process.env.SYBIL_CIRCLE_PENALTY || '0.10'),
    CIRCLE_MIN_PAIRS: parseInt(process.env.SYBIL_CIRCLE_MIN_PAIRS || '1', 10),
    
    MIN_ABS_DELTA: parseInt(process.env.SYBIL_MIN_ABS_DELTA || '1', 10),
};

/**
 * Vráti váhu reportera podľa veku (dní od registrácie).
 */
function ageWeight(ageDays) {
    for (const b of CFG.AGE_BUCKETS_DAYS) {
        if (ageDays <= b.maxDays) return b.weight;
    }
    return 1.0;
}

/**
 * Vráti váhu reportera podľa tieru a manufacturer verifikácie.
 */
function tierWeight(tier, manufacturer_verified) {
    const t = (tier && CFG.TIER_WEIGHTS[tier]) || 1.0;
    const m = manufacturer_verified ? CFG.MFR_VERIFIED_MULTIPLIER : 1.0;
    return t * m;
}

/**
 * Detekuje "review krúžok": reciprocity v reports za posledných CIRCLE_LOOKBACK_DAYS.
 *
 * Vráti počet reciprocal pairs (reporter ↔ target). Ak ≥ CIRCLE_MIN_PAIRS, aplikuje sa penalty.
 */
async function detectReviewCircle(client, { reporter_kya_id, target_kya_id }) {
    if (!reporter_kya_id || !target_kya_id) return { reciprocal: false, count: 0 };
    
    // Hľadáme ČI sa už target predtým "spätne ohlásil" voči súčasnému reporterovi.
    // Akýkoľvek auto-applied peer report (pozitívny aj negatívny) sa počíta — Sybil
    // útoky používajú pozitívne reviews (web of trust), kým "krížový vendetta" útok
    // používa negatívne reviews. Oba sú podozrivé.
    const r = await client.query(
        `SELECT COUNT(*) AS c FROM reports
         WHERE created_at > NOW() - INTERVAL '${CFG.CIRCLE_LOOKBACK_DAYS} days'
           AND auto_applied_delta IS NOT NULL
           AND reporter_kya_id = $1 AND target_kya_id = $2`,
        [target_kya_id, reporter_kya_id]
    );
    const count = parseInt(r.rows[0].c, 10);
    return { reciprocal: count >= CFG.CIRCLE_MIN_PAIRS, count };
}

/**
 * Vypočíta váženú deltu pre peer report.
 *
 * @param {pg.PoolClient} client
 * @param {object} input
 *   - base_delta: pôvodná hodnota (napr. +10 alebo -20)
 *   - reporter_kya_id, reporter_agent_id (môžeme načítať reportera z DB)
 *   - target_kya_id
 *
 * @returns {object} { weighted_delta, breakdown, sybilFlag }
 */
async function computeWeightedDelta(client, { base_delta, reporter_kya_id, target_kya_id }) {
    if (!CFG.ENABLED) {
        return { weighted_delta: base_delta, breakdown: { disabled: true } };
    }
    if (!Number.isFinite(base_delta) || base_delta === 0) {
        return { weighted_delta: 0, breakdown: { zero: true } };
    }
    
    // Anonymous report (no reporter_kya_id) → no Sybil weighting možné
    if (!reporter_kya_id) {
        return { weighted_delta: base_delta, breakdown: { anonymous: true } };
    }
    
    // Load reporter age + tier + manufacturer status
    const r = await client.query(
        `SELECT id, verified_at, tier, manufacturer_verified, reputation_score
         FROM agents WHERE kya_id = $1`,
        [reporter_kya_id]
    );
    if (r.rowCount === 0) {
        return { weighted_delta: base_delta, breakdown: { reporter_not_found: true } };
    }
    const rep = r.rows[0];
    const verifiedAt = rep.verified_at ? new Date(rep.verified_at) : null;
    const ageDays = verifiedAt
        ? Math.max(0, Math.floor((Date.now() - verifiedAt.getTime()) / (24 * 3600 * 1000)))
        : 0;
    
    const wAge = ageWeight(ageDays);
    const wTier = tierWeight(rep.tier, rep.manufacturer_verified);
    
    // Circle detection: ak existuje recipročný auto-applied peer report (target už predtým
    // reportoval súčasného reportera), označíme to ako podozrivé na "review krúžok" alebo
    // "vendetta dvojicu" → penalty 0.10. Aplikuje sa rovnako pre pozitívne aj negatívne.
    let wCircle = 1.0;
    let circleInfo = null;
    let sybilFlag = false;
    if (target_kya_id) {
        const c = await detectReviewCircle(client, { reporter_kya_id, target_kya_id });
        if (c.reciprocal) {
            wCircle = CFG.CIRCLE_PENALTY;
            sybilFlag = true;
            circleInfo = { reciprocal: true, count: c.count, lookback_days: CFG.CIRCLE_LOOKBACK_DAYS };
        } else {
            circleInfo = { reciprocal: false, count: c.count };
        }
    }
    
    const totalWeight = wAge * wTier * wCircle;
    let weighted = base_delta * totalWeight;
    
    // Clamp absolute hodnotu (zachovaj signum) na min 1 ak by tam vznikla 0 (round-toward-zero)
    let weighted_delta = Math.trunc(weighted);
    if (weighted_delta === 0 && base_delta !== 0) {
        weighted_delta = base_delta > 0 ? CFG.MIN_ABS_DELTA : -CFG.MIN_ABS_DELTA;
    }
    
    return {
        weighted_delta,
        breakdown: {
            base_delta,
            reporter_age_days: ageDays,
            age_weight: wAge,
            reporter_tier: rep.tier || 'UNKNOWN',
            manufacturer_verified: !!rep.manufacturer_verified,
            tier_weight: wTier,
            circle_weight: wCircle,
            circle: circleInfo,
            total_weight: Number(totalWeight.toFixed(3)),
            raw_weighted: Number(weighted.toFixed(3)),
        },
        sybilFlag,
    };
}

module.exports = {
    CFG,
    ageWeight,
    tierWeight,
    detectReviewCircle,
    computeWeightedDelta,
};
