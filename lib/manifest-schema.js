// ============================================================================
// UMBRAXON KYA-Hub — Agent Manifest JSON Schema (v1.0)
// ============================================================================
// Definuje štruktúru manifestu ktorý bot odovzdá pri registrácii.
// Validovaný cez AJV pri /api/register/initiate.
//
// Filozofia:
//   - Striktné required polia (žiadne magic defaults)
//   - additionalProperties: false → ochrana proti opičímu zaplnovaniu
//   - protocol_version umožní budúce non-breaking zmeny
//   - manufacturer je VOLITEĽNÝ (Phase 1.5)
// ============================================================================

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: false,
    useDefaults: true,
});
addFormats(ajv);

const manifestSchema = {
    $id: 'https://umbraxon.xyz/schemas/agent-manifest-v1.json',
    type: 'object',
    additionalProperties: false,
    required: ['protocol_version', 'agent', 'tier_requested', 'timestamp', 'nonce'],
    properties: {
        protocol_version: {
            type: 'string',
            enum: ['1.0'],
            description: 'KYA protokol verzia. Aktuálne podporujeme 1.0.',
        },
        agent: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'version', 'pubkey', 'capabilities'],
            properties: {
                name: {
                    type: 'string',
                    minLength: 3,
                    maxLength: 64,
                    pattern: '^[A-Za-z0-9._-]+$',
                    description: 'Unikátne meno agenta (3-64 znakov, alfanumerické + . _ -)',
                },
                version: {
                    type: 'string',
                    maxLength: 32,
                    pattern: '^[0-9]+\\.[0-9]+(\\.[0-9]+)?(-[A-Za-z0-9.-]+)?$',
                    description: 'Semver verzia agenta (napr. "1.0.0", "2.3.1-beta").',
                },
                pubkey: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{64}$',
                    description: 'Ed25519 public key bota (32 bajtov hex = 64 znakov).',
                },
                capabilities: {
                    type: 'array',
                    items: { type: 'string', maxLength: 64, pattern: '^[a-z0-9_-]+$' },
                    minItems: 1,
                    maxItems: 32,
                    description: 'Zoznam schopností (napr. ["btc_payments", "spot_trading", "kyc_check"]).',
                },
                model: {
                    type: 'string',
                    maxLength: 128,
                    description: 'AI model (napr. "gpt-4o", "llama-3.1-70b", "claude-opus-4").',
                },
                runtime: {
                    type: 'string',
                    maxLength: 64,
                    description: 'Runtime prostredie (napr. "node-22", "python-3.12", "rust-1.80").',
                },
                description: {
                    type: 'string',
                    maxLength: 512,
                    description: 'Krátky popis funkcie agenta.',
                },
                homepage: {
                    type: 'string',
                    format: 'uri',
                    maxLength: 256,
                    description: 'URL na public profile agenta.',
                },
            },
        },
        manufacturer: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'pubkey', 'attestation'],
            properties: {
                id: {
                    type: 'string',
                    maxLength: 64,
                    pattern: '^[A-Z0-9_]+$',
                    description: 'ID výrobcu (UPPER_SNAKE_CASE, napr. UMBRAXON_LAB).',
                },
                pubkey: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{64}$',
                    description: 'Ed25519 pubkey výrobcu (32 bajtov hex).',
                },
                attestation: {
                    type: 'string',
                    pattern: '^[0-9a-fA-F]{128}$',
                    description: 'Ed25519 podpis (64 bajtov hex) hash-u manifestu od výrobcu.',
                },
            },
        },
        tier_requested: {
            type: 'string',
            enum: ['BASIC', 'ELITE'],
            description: 'Tier ktorý bot žiada (BASIC = 10k SATS, ELITE = 80k SATS).',
        },
        timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp vytvorenia manifestu (max ±5 min od server času).',
        },
        nonce: {
            type: 'string',
            pattern: '^[0-9a-fA-F]{16,64}$',
            description: 'Random 8-32 bajtov hex (anti-replay v rámci manifestu).',
        },
        payment_hints: {
            type: 'array',
            maxItems: 8,
            description:
                'Voliteľné verejné platobné nápovedy (LN address, LNURL-pay, …). Hub ich nekustoduje; ' +
                'iba ich zaloguje do certifikátu ako overiteľný zámer prijať platbu mimo hubu.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'value'],
                properties: {
                    type: {
                        type: 'string',
                        enum: [
                            'lightning_address',
                            'lnurl_pay',
                            'bolt12_offer',
                            'https_pay_endpoint',
                            'lightning_node_id',
                        ],
                    },
                    value: { type: 'string', minLength: 1, maxLength: 512 },
                    label: { type: 'string', maxLength: 64 },
                },
            },
        },
        integrations: {
            type: 'object',
            additionalProperties: false,
            description:
                'Voliteľné integrácie: verejný discovery feed a outbound developer webhooks (SSRF-filtered).',
            properties: {
                discovery_opt_in: {
                    type: 'boolean',
                    description: 'Ak true, agent sa môže zobraziť v GET /api/discovery/v1/agents.json.',
                },
                developer_webhooks: {
                    type: 'array',
                    maxItems: 3,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['url', 'events'],
                        properties: {
                            url: { type: 'string', format: 'uri', maxLength: 512 },
                            events: {
                                type: 'array',
                                minItems: 1,
                                maxItems: 12,
                                items: {
                                    type: 'string',
                                    enum: [
                                        'agent.registered',
                                        'discovery.indexed',
                                        'reputation.changed',
                                        'cert.revoked',
                                        'cert.reissued',
                                    ],
                                },
                            },
                        },
                    },
                },
            },
        },
        owner: {
            type: 'object',
            additionalProperties: false,
            properties: {
                name: { type: 'string', maxLength: 128 },
                contact: { type: 'string', maxLength: 256 },
                pubkey: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
            },
            description: 'Informácie o vlastníkovi bota (voliteľné).',
        },
        metadata: {
            type: 'object',
            description: 'Voľne tvarovateľné metadáta (max 4 KB JSON).',
            // No further restrictions; aplikácia limituje hĺbkou/veľkosťou samostatne
        },
    },
};

const validateManifest = ajv.compile(manifestSchema);

/**
 * Validuje manifest proti schéme.
 * @param {object} manifest
 * @returns {{valid: boolean, errors: Array}}
 */
function validate(manifest) {
    const valid = validateManifest(manifest);
    return {
        valid,
        errors: valid ? [] : (validateManifest.errors || []).map(e => ({
            path: e.instancePath || e.schemaPath,
            message: e.message,
            keyword: e.keyword,
            params: e.params,
        })),
    };
}

/**
 * Canonical JSON serializácia pre podpis a hashovanie.
 * Deterministická: sortované kľúče, žiadny whitespace, escape ASCII.
 */
function canonicalize(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort().reduce((acc, _) => acc, sortedReplacer()));
}

function sortedReplacer() {
    // Recursive sort for nested objects
    return function (key, value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.keys(value).sort().reduce((acc, k) => {
                acc[k] = value[k];
                return acc;
            }, {});
        }
        return value;
    };
}

/**
 * Vráti sha256(canonical(manifest)) ako hex.
 */
function manifestHash(manifest) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(canonicalize(manifest)).digest('hex');
}

module.exports = {
    validate,
    canonicalize,
    manifestHash,
    SCHEMA: manifestSchema,
};
