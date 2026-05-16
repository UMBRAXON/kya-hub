// ============================================================================
// UMBRAXON KYA-Hub — Manifest extensions: payment_hints + integrations
// ============================================================================
// Doplnková validácia po AJV (formát URI, SSRF základ, LN stringy).
// Hub nikdy nedrží prostriedky; hints sú verejný routing metadata v certe.
// ============================================================================

const { URL } = require('url');

const PRIVATE_HOST_PATTERNS = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\.0\.0\.0$/,
];
const PRIVATE_IPV6 = /^\[(::1|fc|fd|fe80)/i;

function _hostLooksPrivate(host) {
    if (!host) return true;
    const h = String(host).split(':')[0];
    if (PRIVATE_IPV6.test(host)) return true;
    for (const p of PRIVATE_HOST_PATTERNS) {
        if (p.test(h)) return true;
    }
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
    return false;
}

function validateHttpsWebhookUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return { ok: false, error: 'INVALID_URL' };
    }
    if (u.protocol !== 'https:') return { ok: false, error: 'WEBHOOK_HTTPS_ONLY' };
    if (_hostLooksPrivate(u.hostname)) return { ok: false, error: 'WEBHOOK_PRIVATE_HOST' };
    if (u.port && u.port !== '443') return { ok: false, error: 'WEBHOOK_PORT_NOT_ALLOWED' };
    return { ok: true };
}

function validatePaymentHints(hints) {
    const errors = [];
    if (hints === undefined || hints === null) return { ok: true, errors: [] };
    if (!Array.isArray(hints)) return { ok: false, errors: [{ path: '/payment_hints', message: 'must be array' }] };

    for (let i = 0; i < hints.length; i++) {
        const h = hints[i];
        const p = `/payment_hints/${i}`;
        if (!h || typeof h !== 'object') {
            errors.push({ path: p, message: 'invalid hint object' });
            continue;
        }
        const { type, value, label } = h;
        if (!value || typeof value !== 'string') {
            errors.push({ path: `${p}/value`, message: 'value required' });
            continue;
        }
        const v = value.trim();
        if (v.length > 512) errors.push({ path: `${p}/value`, message: 'max 512 chars' });

        if (type === 'lightning_address') {
            if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v)) {
                errors.push({ path: `${p}/value`, message: 'invalid lightning_address' });
            }
        } else if (type === 'lnurl_pay') {
            let u;
            try {
                u = new URL(v);
            } catch {
                errors.push({ path: `${p}/value`, message: 'lnurl_pay must be https URL' });
                continue;
            }
            if (u.protocol !== 'https:') errors.push({ path: `${p}/value`, message: 'lnurl_pay must be https' });
        } else if (type === 'bolt12_offer') {
            if (v.length < 12 || v.length > 12000 || !/^lno1[a-z0-9]+$/i.test(v)) {
                errors.push({ path: `${p}/value`, message: 'bolt12_offer looks invalid' });
            }
        } else if (type === 'lightning_node_id') {
            const nodeRe = /^(?:[0-9a-f]{66}|[0-9a-f]{66}@[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]{1,5})?)$/i;
            if (!nodeRe.test(v)) {
                errors.push({ path: `${p}/value`, message: 'invalid lightning_node_id (66-char hex or node@host)' });
            }
        } else if (type === 'https_pay_endpoint') {
            let u;
            try {
                u = new URL(v);
            } catch {
                errors.push({ path: `${p}/value`, message: 'https_pay_endpoint must be URL' });
                continue;
            }
            if (u.protocol !== 'https:') errors.push({ path: `${p}/value`, message: 'must be https' });
        }
        if (label != null && (typeof label !== 'string' || label.length > 64)) {
            errors.push({ path: `${p}/label`, message: 'label max 64 chars' });
        }
    }
    return { ok: errors.length === 0, errors };
}

function validateIntegrationsBlock(integrations) {
    const errors = [];
    if (integrations === undefined || integrations === null) return { ok: true, errors: [] };
    if (typeof integrations !== 'object' || Array.isArray(integrations)) {
        return { ok: false, errors: [{ path: '/integrations', message: 'must be object' }] };
    }
    const hooks = integrations.developer_webhooks;
    if (hooks) {
        if (!Array.isArray(hooks)) errors.push({ path: '/integrations/developer_webhooks', message: 'must be array' });
        else {
            hooks.forEach((row, i) => {
                const p = `/integrations/developer_webhooks/${i}`;
                if (!row || typeof row !== 'object') {
                    errors.push({ path: p, message: 'invalid row' });
                    return;
                }
                const vu = validateHttpsWebhookUrl(row.url);
                if (!vu.ok) errors.push({ path: `${p}/url`, message: vu.error });
            });
        }
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Volaj po úspešnom manifestSchema.validate().
 * @param {object} manifest
 */
function auditManifestExtensions(manifest) {
    const a = validatePaymentHints(manifest.payment_hints);
    const b = validateIntegrationsBlock(manifest.integrations);
    return {
        ok: a.ok && b.ok,
        errors: [...a.errors, ...b.errors],
    };
}

function discoveryOptInFromManifest(manifest) {
    return !!(manifest && manifest.integrations && manifest.integrations.discovery_opt_in === true);
}

/** Sanitized copy for embedding in issued certificate (public). */
function paymentHintsForCert(manifest) {
    if (!manifest || !Array.isArray(manifest.payment_hints)) return [];
    return manifest.payment_hints.map((h) => ({
        type: h.type,
        value: String(h.value || '').trim(),
        ...(h.label ? { label: String(h.label).slice(0, 64) } : {}),
    }));
}

function integrationsPublicForCert(manifest) {
    const integ = (manifest && manifest.integrations) || {};
    const n = Array.isArray(integ.developer_webhooks) ? integ.developer_webhooks.length : 0;
    return {
        discovery_opt_in: discoveryOptInFromManifest(manifest),
        developer_webhooks_count: Math.min(3, n),
    };
}

module.exports = {
    validatePaymentHints,
    validateIntegrationsBlock,
    validateHttpsWebhookUrl,
    auditManifestExtensions,
    discoveryOptInFromManifest,
    paymentHintsForCert,
    integrationsPublicForCert,
};
