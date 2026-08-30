/**
 * Fail-closed MCP tool wrapper: verify KYA → log intent → allowlist → execute.
 * @see docs/MCP-SECURITY-CHECKLIST.md
 */

async function defaultVerify(baseUrl, kyaId, opts = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const id = encodeURIComponent(String(kyaId || '').trim());
  const url = new URL(`/api/v1/agents/${id}/status`, `${base}/`);
  if (opts.includeCertProof) url.searchParams.set('include', 'cert_proof');

  const headers = { Accept: 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const fetchFn = opts.fetch || globalThis.fetch;
  if (!fetchFn) throw new Error('fetch is not available (Node 18+ or pass opts.fetch)');

  const res = await fetchFn(url.toString(), { headers });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return {
    ok: res.ok,
    status: res.status,
    verified: data?.verified === true,
    data,
  };
}

function defaultLogIntent(record) {
  if (typeof process !== 'undefined' && process.stderr) {
    process.stderr.write(`${JSON.stringify({ event: 'kya_mcp_intent', ...record })}\n`);
  }
}

function assertAllowedTool(toolName, allowedTools) {
  if (!allowedTools || allowedTools.length === 0) return;
  if (!allowedTools.includes(toolName)) {
    const err = new Error(`TOOL_NOT_ALLOWED: ${toolName}`);
    err.code = 'TOOL_NOT_ALLOWED';
    err.toolName = toolName;
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.kyaId
 * @param {string} opts.toolName — canonical tool id (must match allowlist if set)
 * @param {string} [opts.intent] — human/machine summary of planned side effect
 * @param {string[]} [opts.allowedTools] — fail closed if toolName not listed
 * @param {boolean} [opts.requireVerified=true]
 * @param {boolean} [opts.includeCertProof=false]
 * @param {string} [opts.apiKey]
 * @param {typeof fetch} [opts.fetch]
 * @param {(baseUrl: string, kyaId: string, o: object) => Promise<object>} [opts.verify]
 * @param {(record: object) => void} [opts.logIntent]
 * @param {() => Promise<unknown>} opts.execute — runs only after verify + log + allowlist
 */
export async function guardToolCall(opts) {
  const {
    baseUrl,
    kyaId,
    toolName,
    intent = '',
    allowedTools,
    requireVerified = true,
    includeCertProof = false,
    apiKey,
    fetch: fetchFn,
    verify = defaultVerify,
    logIntent = defaultLogIntent,
    execute,
  } = opts;

  if (!baseUrl || !kyaId || !toolName) {
    throw new Error('guardToolCall requires baseUrl, kyaId, toolName');
  }
  if (typeof execute !== 'function') {
    throw new Error('guardToolCall requires execute()');
  }

  const verification = await verify(baseUrl, kyaId, {
    includeCertProof,
    apiKey,
    fetch: fetchFn,
  });

  const intentRecord = {
    ts: new Date().toISOString(),
    kya_id: kyaId,
    tool_name: toolName,
    intent: String(intent).slice(0, 512),
    verified: verification.verified === true,
    trust_level: verification.data?.trust_level ?? null,
    http_status: verification.status,
  };

  logIntent(intentRecord);

  if (requireVerified && !verification.verified) {
    const err = new Error('KYA_VERIFY_FAILED');
    err.code = 'KYA_VERIFY_FAILED';
    err.verification = verification;
    err.intentRecord = intentRecord;
    throw err;
  }

  assertAllowedTool(toolName, allowedTools);

  return execute({ verification, intentRecord });
}

export { defaultVerify, defaultLogIntent, assertAllowedTool };

export default { guardToolCall, defaultVerify, defaultLogIntent, assertAllowedTool };
