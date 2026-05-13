// ============================================================================
// UMBRAXON KYA-Hub — Proof-of-Work Captcha (Phase 2.2)
// ============================================================================
// Hashcash-style PoW kvôli ochrane drahých endpointov (/api/pay, /api/register/initiate)
// pred botmi a abuse.
//
// Flow:
//   1. Klient: GET /api/pow/challenge?purpose=pay
//      → { challenge_id, challenge, difficulty, expires_at }
//   2. Klient lokálne hľadá nonce taký, že:
//          sha256(`${challenge}:${nonce}`)  má v binárnej reprezentácii
//          aspoň `difficulty` leading zero bitov.
//   3. Klient pošle request s headerom/body fieldom:
//          X-Pow: challenge_id=<id>; nonce=<nonce>; iterations=<n>
//      alebo body `pow: { challenge_id, nonce, iterations }`.
//   4. Server overí: nájde challenge v DB, prepočíta hash, overí leading bits,
//      označí solved (one-shot).
//
// Difficulty:
//   - default 18 bits  → ~250k pokusov v priemere  → ~1-2 sec na CPU
//   - admin si môže prepnúť na 20 (1M pokusov, ~5-10s) ak je hub pod útokom
//   - voliteľne POW_REGISTER_DIFFICULTY < POW_DEFAULT_DIFFICULTY pre slabších
//     klientov na /api/register/initiate (purpose=register bez ?difficulty=)
//
// Defaults sú low-friction: poctivý klient zvládne v rozumnom čase, bot
// army platí za každý invoice attempt CPU prácu.
// ============================================================================
const crypto = require('crypto');

const MAX_DIFFICULTY = 28;

/** @param {string|undefined} raw @param {number} fallback */
function _parseDifficulty(raw, fallback) {
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), MAX_DIFFICULTY);
}

const DEFAULT_DIFFICULTY = _parseDifficulty(process.env.POW_DEFAULT_DIFFICULTY, 18);
const REGISTER_DIFFICULTY = (process.env.POW_REGISTER_DIFFICULTY === undefined || process.env.POW_REGISTER_DIFFICULTY === '')
    ? DEFAULT_DIFFICULTY
    : _parseDifficulty(process.env.POW_REGISTER_DIFFICULTY, DEFAULT_DIFFICULTY);

/** Default max iterations for `solve()`; production clients should loop until success instead of relying on one cap. */
const SOLVE_MAX_ITERATIONS = Math.min(
    Math.max(parseInt(process.env.POW_SOLVE_MAX_ITERATIONS || '50000000', 10), 1_000_000),
    500_000_000
);

const CFG = {
    DEFAULT_DIFFICULTY,
    REGISTER_DIFFICULTY,
    MAX_DIFFICULTY,
    TTL_SEC: parseInt(process.env.POW_TTL_SEC || '300', 10),  // 5 min na vyriešenie
    REQUIRED_FOR: (process.env.POW_REQUIRED_FOR || 'pay,register').split(',').map(s => s.trim()).filter(Boolean),
    // Ak ENABLED=false, /api/pow/* funguje ale gate sa neaplikuje. Užitočné pre dev/testy.
    ENABLED: process.env.POW_ENABLED !== 'false',
    SOLVE_MAX_ITERATIONS,
};

const PURPOSES = ['pay', 'register', 'challenge', 'generic'];

function isRequiredFor(purpose) {
    if (!CFG.ENABLED) return false;
    return CFG.REQUIRED_FOR.includes(purpose);
}

/**
 * Skontroluje či hash má aspoň `bits` leading zero bitov.
 * @param {Buffer} hashBuf - 32B sha256 digest
 * @param {number} bits
 */
function hasLeadingZeroBits(hashBuf, bits) {
    let remaining = bits;
    for (let i = 0; i < hashBuf.length && remaining > 0; i++) {
        const byte = hashBuf[i];
        if (remaining >= 8) {
            if (byte !== 0) return false;
            remaining -= 8;
        } else {
            // posledný čiastočný byte
            const mask = 0xff << (8 - remaining) & 0xff;
            if ((byte & mask) !== 0) return false;
            remaining = 0;
        }
    }
    return true;
}

/**
 * Vytvor nový PoW challenge a ulož do DB.
 * @param {pg.Pool} pool
 * @param {object} opts { purpose, difficulty, clientIp }
 */
async function createChallenge(pool, { purpose = 'generic', difficulty, clientIp } = {}) {
    if (!PURPOSES.includes(purpose)) purpose = 'generic';
    const baseDefault = purpose === 'register' ? CFG.REGISTER_DIFFICULTY : CFG.DEFAULT_DIFFICULTY;
    const raw = difficulty !== undefined && difficulty !== null ? difficulty : baseDefault;
    const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    const diff = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 1), CFG.MAX_DIFFICULTY)
        : Math.min(Math.max(baseDefault, 1), CFG.MAX_DIFFICULTY);
    
    const challengeId = 'POW-' + crypto.randomBytes(12).toString('hex');
    const challenge = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CFG.TTL_SEC * 1000);
    
    await pool.query(
        `INSERT INTO pow_challenges (challenge_id, challenge, difficulty, purpose, client_ip, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challengeId, challenge, diff, purpose, clientIp || null, expiresAt]
    );
    
    return {
        challenge_id: challengeId,
        challenge,
        difficulty: diff,
        purpose,
        expires_at: expiresAt.toISOString(),
        ttl_sec: CFG.TTL_SEC,
        algorithm: 'sha256',
        instructions: `Find nonce taký, že sha256("${challenge.slice(0, 8)}...":nonce) má aspoň ${diff} leading zero bits.`,
    };
}

/**
 * Overí a "spotrebuje" PoW riešenie. One-shot: každý challenge_id sa použiť max raz.
 * 
 * @returns {object} { valid, reason, purpose? }
 */
async function verifySolution(pool, { challenge_id, nonce, iterations, expectedPurpose, clientIp }) {
    if (!challenge_id || !nonce) {
        return { valid: false, reason: 'POW_MISSING' };
    }
    if (typeof nonce !== 'string' || nonce.length > 128) {
        return { valid: false, reason: 'POW_BAD_NONCE' };
    }
    
    // Atomicky vyberieme a označíme. UPDATE ... RETURNING zaručí že iný request
    // ten istý challenge nepoužije ešte raz.
    // created_at je v RETURNING aby sme mohli vypočítať solve_ms (server-side
    // wall-clock od vystavenia challenge-u po prijatie riešenia) pre telemetriu.
    const r = await pool.query(
        `UPDATE pow_challenges
         SET solved_at = CURRENT_TIMESTAMP, solution_nonce = $2,
             solution_iterations = $3
         WHERE challenge_id = $1
           AND solved_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP
         RETURNING challenge, difficulty, purpose, created_at`,
        [challenge_id, nonce, iterations || null]
    );
    
    if (r.rowCount === 0) {
        // Nezistili sme či neexistuje, alebo už solved, alebo expired — vrátime všeobecnú chybu
        const dbg = await pool.query(
            `SELECT challenge_id, solved_at, expires_at FROM pow_challenges WHERE challenge_id = $1`,
            [challenge_id]
        );
        if (dbg.rowCount === 0) return { valid: false, reason: 'POW_NOT_FOUND' };
        if (dbg.rows[0].solved_at) return { valid: false, reason: 'POW_ALREADY_SOLVED' };
        return { valid: false, reason: 'POW_EXPIRED' };
    }
    
    const { challenge, difficulty, purpose, created_at } = r.rows[0];
    
    // Validuj purpose ak je požadovaný konkrétny
    if (expectedPurpose && purpose !== expectedPurpose && purpose !== 'generic') {
        return { valid: false, reason: 'POW_WRONG_PURPOSE', expected: expectedPurpose, got: purpose };
    }
    
    // Spočítaj hash
    const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    const ok = hasLeadingZeroBits(digest, difficulty);
    
    if (!ok) {
        return {
            valid: false,
            reason: 'POW_INSUFFICIENT_WORK',
            difficulty,
            hash_prefix: digest.toString('hex').slice(0, 16),
        };
    }
    
    // solve_ms = wall-clock medzi vystavením challenge-u a prijatím riešenia.
    // Negatívne hodnoty (skew medzi DB a app serverom) clampneme na 0.
    let solveMs = null;
    if (created_at) {
        const ts = created_at instanceof Date ? created_at.getTime() : new Date(created_at).getTime();
        if (Number.isFinite(ts)) {
            solveMs = Math.max(0, Date.now() - ts);
        }
    }
    
    let iterReported = null;
    if (iterations !== undefined && iterations !== null) {
        const n = typeof iterations === 'number' ? iterations : parseInt(String(iterations), 10);
        if (Number.isFinite(n) && n >= 0) iterReported = Math.floor(n);
    }
    
    return {
        valid: true,
        purpose,
        difficulty,
        iterations: iterReported,
        solve_ms: solveMs,
        hash_prefix: digest.toString('hex').slice(0, 16),
    };
}

/**
 * Express middleware factory: vyžaduje PoW v requeste pre daný purpose.
 * Načíta PoW z body.pow alebo z X-Pow header-u.
 *
 * Callbacks (oba voliteľné, lib zostáva logger-agnostic):
 *   recordRejection(req, reason)            — volaný pri 402 (POW_MISSING / POW_INVALID / ...)
 *   onSuccess(req, { purpose, difficulty,    — volaný po úspešnej verifikácii pre telemetriu
 *                    iterations, solve_ms,      (p50/p95/p99 panely na dashboarde).
 *                    hash_prefix })             Akékoľvek throw je odchytené, gate ide ďalej.
 */
function buildRequireMiddleware({ poolGetter, purpose, recordRejection, onSuccess }) {
    return async function powGate(req, res, next) {
        if (!isRequiredFor(purpose)) return next();
        
        // Admin bypass cez X-Admin-Key (testy, tooling)
        const adminKey = req.headers['x-admin-key'];
        const expectedAdmin = process.env.ADMIN_API_KEY;
        if (adminKey && expectedAdmin) {
            try {
                const a = Buffer.from(adminKey), b = Buffer.from(expectedAdmin);
                if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                    res.set('X-Pow-Bypass', 'admin');
                    return next();
                }
            } catch (_) {}
        }
        
        let challenge_id, nonce, iterations;
        
        // Body
        if (req.body && req.body.pow && typeof req.body.pow === 'object') {
            challenge_id = req.body.pow.challenge_id;
            nonce = req.body.pow.nonce;
            iterations = req.body.pow.iterations;
        }
        // Header (preferred pre GET/anonymné)
        if (!challenge_id) {
            const h = req.headers['x-pow'];
            if (typeof h === 'string') {
                // formát: challenge_id=...; nonce=...; iterations=...
                const parts = Object.fromEntries(
                    h.split(';').map(p => p.trim().split('=').map(s => s.trim()))
                );
                challenge_id = parts.challenge_id;
                nonce = parts.nonce;
                iterations = parts.iterations ? parseInt(parts.iterations, 10) : undefined;
            }
        }
        
        if (!challenge_id || !nonce) {
            if (recordRejection) {
                recordRejection(req, 'POW_MISSING').catch(() => {});
            }
            const hintDiff = purpose === 'register' ? CFG.REGISTER_DIFFICULTY : CFG.DEFAULT_DIFFICULTY;
            return res.status(402).json({
                error: 'POW_REQUIRED',
                message: `Endpoint vyžaduje proof-of-work. GET /api/pow/challenge?purpose=${purpose} a pošli riešenie v body.pow alebo X-Pow headeri.`,
                purpose,
                difficulty: hintDiff,
            });
        }
        
        const verify = await verifySolution(poolGetter(), {
            challenge_id, nonce, iterations,
            expectedPurpose: purpose, clientIp: req.ip,
        });
        
        if (!verify.valid) {
            if (recordRejection) {
                recordRejection(req, verify.reason).catch(() => {});
            }
            return res.status(402).json({
                error: verify.reason || 'POW_INVALID',
                message: 'PoW solution neprešla validáciou. Vyžiadaj si nový challenge.',
                difficulty: verify.difficulty,
            });
        }
        
        // Označ v req že PoW prešiel (pre downstream auditing)
        req.pow_verified = verify;
        
        if (onSuccess) {
            try {
                const maybe = onSuccess(req, {
                    purpose: verify.purpose,
                    difficulty: verify.difficulty,
                    iterations: verify.iterations,
                    solve_ms: verify.solve_ms,
                    hash_prefix: verify.hash_prefix,
                });
                if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {});
            } catch (_) { /* telemetria nesmie nikdy zhodiť gate */ }
        }
        
        next();
    };
}

/**
 * Pomocná funkcia pre klienta — solver (pre testy a SDK).
 * V real-world bot/frontend toto robí v WebWorkeri.
 * Ak `maxIterations` nestačí pri vysokej difficulty, volaj znova s vyšším limitom
 * alebo vlastným loopom (náhodný nonce až do úspechu) — očakávaný počet pokusov rastie exponenciálne s difficulty.
 */
function solve(challenge, difficulty, maxIterations = CFG.SOLVE_MAX_ITERATIONS) {
    let iterations = 0;
    while (iterations < maxIterations) {
        const nonce = crypto.randomBytes(8).toString('hex');
        const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
        if (hasLeadingZeroBits(digest, difficulty)) {
            return { nonce, iterations, hash: digest.toString('hex') };
        }
        iterations++;
    }
    throw new Error('No solution found in ' + maxIterations + ' iterations');
}

module.exports = {
    CFG,
    PURPOSES,
    isRequiredFor,
    createChallenge,
    verifySolution,
    buildRequireMiddleware,
    solve,
    hasLeadingZeroBits,
};
