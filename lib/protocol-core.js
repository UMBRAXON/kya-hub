// ============================================================================
// KYA protocol core — shared verification & manifest (thin hub layer)
// ============================================================================
// Integrators: prefer `@umbraxon_kya/kya-verify` on npm for gate checks.
// Node hub code imports this instead of reaching into server.js.
// ============================================================================

const manifestSchema = require('./manifest-schema');
const certs = require('./certs');
const hubkeys = require('./hubkeys');
const delegationPass = require('./delegation-pass');

module.exports = {
    manifestSchema,
    canonicalize: manifestSchema.canonicalize,
    hashManifest: manifestSchema.hashManifest,
    validateManifest: manifestSchema.validateManifest,
    certs,
    hubkeys,
    delegationPass,
    verifyDelegationPass: delegationPass.verifyDelegationPass,
    l402DelegationProfileDoc: delegationPass.l402DelegationProfileDoc,
};
