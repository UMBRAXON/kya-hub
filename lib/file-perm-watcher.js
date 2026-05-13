// ============================================================================
// UMBRAXON KYA-Hub — File Permission Watcher (Phase 2.3)
// ============================================================================
// Periodicky kontroluje že .env, key materials a iné citlivé súbory majú
// bezpečné permissions (chmod 600). Pri detekcii nebezpečných perms:
//   - WARN log
//   - V STRICT mode (env FILE_PERM_STRICT=true) → process.exit(1)
//
// Tento watcher chráni pred:
//   - Náhodným chmod -R 755 na celý dir
//   - Backup tools ktoré obnovia perms na defaults
//   - Lokálnym `chmod a+r` development trickom ktorý sa nevrátil
// ============================================================================
const fs = require('fs');
const path = require('path');

const DEFAULT_FILES = ['.env'];
const DEFAULT_INTERVAL_MS = 60 * 1000; // 1 min
let _timer = null;
let _violations = 0;

function checkOne(filepath) {
    try {
        const st = fs.statSync(filepath);
        const mode = st.mode & 0o777;
        const groupReadable = (mode & 0o040) !== 0;
        const worldReadable = (mode & 0o004) !== 0;
        const groupWritable = (mode & 0o020) !== 0;
        const worldWritable = (mode & 0o002) !== 0;
        return {
            path: filepath,
            mode: mode.toString(8),
            ok: !groupReadable && !worldReadable && !groupWritable && !worldWritable,
            groupReadable,
            worldReadable,
            groupWritable,
            worldWritable,
        };
    } catch (e) {
        return { path: filepath, ok: false, error: e.message };
    }
}

function checkAll(files = DEFAULT_FILES, basePath = process.cwd()) {
    return files.map(f => checkOne(path.isAbsolute(f) ? f : path.join(basePath, f)));
}

/**
 * Spusti periodický watcher. Beží v background interval.
 * @param {object} opts
 *   - files: string[]              — relatívne cesty (default ['.env'])
 *   - basePath: string             — kde sa relatívne cesty resolvujú (default cwd)
 *   - intervalMs: number           — frekvencia kontroly (default 60s)
 *   - strict: boolean              — pri zlej perm vypni server (default false)
 *   - autoFix: boolean             — pokús sa chmod 600 automaticky (default false)
 *   - logger: pino logger          — log target
 *   - onViolation: fn(violations)  — callback pri zistení (napr. alert)
 */
function start(opts = {}) {
    if (_timer) return; // už beží
    
    const files = opts.files || DEFAULT_FILES;
    const basePath = opts.basePath || process.cwd();
    const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    const strict = !!opts.strict || process.env.FILE_PERM_STRICT === 'true';
    const autoFix = !!opts.autoFix || process.env.FILE_PERM_AUTOFIX === 'true';
    const log = opts.logger || console;
    
    const tick = () => {
        const results = checkAll(files, basePath);
        const violations = results.filter(r => !r.ok);
        if (violations.length === 0) return;
        _violations += violations.length;
        
        for (const v of violations) {
            if (v.error) {
                log.error ? log.error({ file: v.path, error: v.error }, 'file-perm-watcher: stat error')
                          : console.error(`[file-perm-watcher] stat error ${v.path}: ${v.error}`);
                continue;
            }
            const msg = `INSECURE PERMS: ${v.path} mode=${v.mode} (groupReadable=${v.groupReadable} worldReadable=${v.worldReadable})`;
            
            if (autoFix) {
                try {
                    fs.chmodSync(v.path, 0o600);
                    log.warn ? log.warn({ file: v.path, oldMode: v.mode }, 'file-perm-watcher: autofix chmod 600')
                             : console.warn(`[file-perm-watcher] AUTOFIX ${v.path} → 600 (was ${v.mode})`);
                } catch (e) {
                    log.error ? log.error({ file: v.path, error: e.message }, 'file-perm-watcher: autofix FAIL')
                              : console.error(`[file-perm-watcher] autofix FAIL ${v.path}: ${e.message}`);
                }
            } else {
                log.error ? log.error({ file: v.path, mode: v.mode, groupReadable: v.groupReadable, worldReadable: v.worldReadable }, msg)
                          : console.error(`[file-perm-watcher] ${msg}`);
            }
        }
        
        if (typeof opts.onViolation === 'function') {
            try { opts.onViolation(violations); } catch (_) {}
        }
        
        if (strict) {
            (log.fatal ? log.fatal.bind(log) : log.error.bind(log))({
                violations,
            }, 'file-perm-watcher STRICT mode: exiting due to insecure perms');
            process.exit(1);
        }
    };
    
    // Spusti hneď + perioda
    tick();
    _timer = setInterval(tick, intervalMs);
    if (_timer.unref) _timer.unref();
    
    (log.info || console.log).call(log, {
        files: files.length, intervalMs, strict, autoFix,
    }, 'file-perm-watcher started');
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

function getStats() {
    return { violations: _violations, running: !!_timer };
}

module.exports = {
    start,
    stop,
    checkOne,
    checkAll,
    getStats,
};
