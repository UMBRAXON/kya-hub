/**
 * KYA-Hub Bot Developer Portal — minimal client logic (Phase A).
 * Fetches public JSON only; never sends secrets. Command block is generated locally.
 */
const API_BASE = 'https://umbraxon.xyz';

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setPill(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'status-pill ' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'loading');
  el.textContent = label;
}

function isValidAgentName(name) {
  return typeof name === 'string'
    && name.length >= 3 && name.length <= 64
    && /^[A-Za-z0-9._-]+$/.test(name);
}

function escapeShell(s) {
  return "'" + String(s).replace(/'/g, `'\"'\"'`) + "'";
}

function buildCommandBlock({ baseUrl, name, version, tier }) {
  const b = baseUrl.replace(/\/$/, '');
  const nm = name.trim();
  const ver = (version || '1.0.0').trim() || '1.0.0';
  return [
    'pip install pynacl',
    '# v kya-hub repozitári (kde je scripts/umbrexon_bot_client.py):',
    'python3 scripts/umbrexon_bot_client.py self-test',
    'python3 scripts/umbrexon_bot_client.py keygen --out bot.key',
    'python3 scripts/umbrexon_bot_client.py register \\',
    `  --base-url ${b} \\`,
    '  --privkey-file bot.key \\',
    `  --name ${nm} --version ${ver} \\`,
    `  --capability btc_payments --tier ${tier}`,
  ].join('\n');
}

async function loadLive() {
  setPill('pill-health', 'loading', 'Načítavam…');
  setPill('pill-tiers', 'loading', 'Načítavam…');
  setText('live-health-detail', '—');
  setText('live-tiers-detail', '—');

  try {
    const [hRes, tRes] = await Promise.all([
      fetch(`${API_BASE}/api/health`, { credentials: 'omit' }),
      fetch(`${API_BASE}/api/tiers`, { credentials: 'omit' }),
    ]);
    if (!hRes.ok) throw new Error(`health HTTP ${hRes.status}`);
    if (!tRes.ok) throw new Error(`tiers HTTP ${tRes.status}`);
    const health = await hRes.json();
    const tiers = await tRes.json();

    const hub = health.server === 'OK' ? 'OK' : health.server || '?';
    setText('live-health-summary', `Hub: ${hub}`);
    const db = health.db && health.db.status ? health.db.status : '—';
    const pay = health.btcpay && health.btcpay.status ? health.btcpay.status : '—';
    const alby = health.alby || '—';
    setText('live-health-detail', `DB ${db} · BTCPay ${pay} · Alby ${alby}`);
    setPill('pill-health', 'ok', 'Live');

    const basic = tiers.BASIC && tiers.BASIC.total;
    const elite = tiers.ELITE && tiers.ELITE.total;
    setText('live-tiers-summary', `BASIC ${basic != null ? basic + ' sats' : '—'} · ELITE ${elite != null ? elite + ' sats' : '—'}`);
    setText('live-tiers-detail', 'Ceny podľa aktívnej politiky hubu (over cez GET /api/tiers).');
    setPill('pill-tiers', 'ok', 'Live');

    const sel = document.getElementById('assistant-tier');
    if (sel && basic != null && elite != null) {
      for (const o of sel.options) {
        if (o.value === 'BASIC') o.textContent = `BASIC (${basic} sats)`;
        if (o.value === 'ELITE') o.textContent = `ELITE (${elite} sats)`;
      }
    }
  } catch (e) {
    setPill('pill-health', 'err', 'Chyba');
    setPill('pill-tiers', 'err', 'Chyba');
    setText('live-health-summary', 'Nepodarilo sa načítať /api/health');
    setText('live-tiers-summary', 'Nepodarilo sa načítať /api/tiers');
    setText('live-health-detail', String(e.message || e));
    setText('live-tiers-detail', 'Skontroluj sieť alebo CORS; API je na ' + API_BASE);
  }
}

function wireAssistant() {
  const out = $('assistant-output');
  const err = $('assistant-error');
  const btnGen = $('assistant-generate');
  const btnCopy = $('assistant-copy');

  function render() {
    err.textContent = '';
    const name = $('assistant-name').value.trim();
    const baseUrl = $('assistant-base').value.trim() || API_BASE;
    const version = $('assistant-version').value.trim() || '1.0.0';
    const tier = $('assistant-tier').value;

    if (!isValidAgentName(name)) {
      err.textContent = 'Meno bota: 3–64 znakov, len písmená, číslice, . _ -';
      out.textContent = '';
      return;
    }
    out.textContent = buildCommandBlock({ baseUrl, name, version, tier });
  }

  btnGen.addEventListener('click', render);
  btnCopy.addEventListener('click', async () => {
    if (!out.textContent) render();
    if (!out.textContent) return;
    try {
      await navigator.clipboard.writeText(out.textContent);
      btnCopy.textContent = 'Skopírované';
      setTimeout(() => { btnCopy.textContent = 'Kopírovať'; }, 2000);
    } catch {
      err.textContent = 'Clipboard nie je dostupný — označ text v poli ručne.';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadLive();
  wireAssistant();
});
