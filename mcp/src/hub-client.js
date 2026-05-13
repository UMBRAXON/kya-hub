/**
 * HTTP client for KYA-Hub with timeout and single 429 retry.
 */

function normalizeBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return u || 'https://umbraxon.xyz';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterSeconds(headerVal) {
  if (headerVal == null || headerVal === '') return null;
  const s = String(headerVal).trim();
  const asInt = parseInt(s, 10);
  if (!Number.isNaN(asInt) && String(asInt) === s) return Math.min(Math.max(0, asInt), 120);
  const d = Date.parse(s);
  if (!Number.isNaN(d)) {
    const sec = Math.ceil((d - Date.now()) / 1000);
    return Math.min(Math.max(0, sec), 120);
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.userAgent]
 */
export function createHubClient(opts) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 120000);
  const userAgent =
    opts.userAgent ||
    'kya-hub-mcp/1.0 (+https://github.com/UMBRAXON/kya-hub)';

  async function requestOnce(method, url, bodyObj) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      /** @type {RequestInit} */
      const init = {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
        signal: controller.signal,
      };
      if (bodyObj !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.headers = {
          ...init.headers,
          'Content-Type': 'application/json',
        };
        init.body = JSON.stringify(bodyObj);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { _raw: text.slice(0, 8000) };
      }
      return { res, json, text };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * @param {string} method
   * @param {string} pathWithQuery path starting with /
   * @param {object} [bodyObj] for POST/PUT
   * @param {{ retry429?: boolean }} [options]
   */
  async function hubRequest(method, pathWithQuery, bodyObj, options = {}) {
    const retry429 = options.retry429 !== false;
    const url = `${baseUrl}${pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`}`;

    let { res, json } = await requestOnce(method, url, bodyObj);

    if (retry429 && res.status === 429) {
      const ra = res.headers.get('retry-after');
      const waitSec = parseRetryAfterSeconds(ra);
      if (waitSec != null && waitSec > 0) {
        await sleep(waitSec * 1000);
        ({ res, json } = await requestOnce(method, url, bodyObj));
      }
    }

    const ok = res.ok;
    const status = res.status;
    if (!ok) {
      const errMsg =
        json && typeof json === 'object' && json.error
          ? String(json.error)
          : `HTTP_${status}`;
      const err = new Error(errMsg);
      err.status = status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return { baseUrl, hubRequest };
}
