/**
 * @param {string} baseUrl — e.g. https://www.umbraxon.xyz
 * @param {string} kyaId — e.g. UMBRA-000467
 * @param {{ includeCertProof?: boolean, apiKey?: string, fetch?: typeof fetch }} [opts]
 */
export async function verifyAgentStatus(baseUrl, kyaId, opts = {}) {
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

export default { verifyAgentStatus };
