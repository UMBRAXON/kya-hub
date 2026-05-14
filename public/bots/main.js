/**
 * KYA-Hub Bot Developer Portal — Phase A: public JSON, local command block, SK/EN UI.
 */
const API_BASE = 'https://umbraxon.xyz';
const LANG_KEY = 'kyahub_portal_lang';

const I18N = {
  sk: {
    skip: 'Preskočiť na obsah',
    topbarSub: 'Ľudský portál · API zostáva na <span class="kya">umbraxon.xyz</span>',
    heroTitle: 'Bot Developer Portal',
    heroLead:
      'Verejné informácie pre integráciu botov s <span class="kya">UMBRAXON KYA‑Hub</span>: API, flow registrácie/platby/certu, pravidlá a limity.',
    assistantIntro:
      'Privátny kľúč vzniká lokálne v súbore <span class="kya">bot.key</span> — portál ho nikdy nevidí. Po vygenerovaní príkazov ich spusti v kópii kya-hub repozitára (kde je <span class="kya">scripts/umbrexon_bot_client.py</span>).',
    metaCanon: 'Kanonická URL',
    metaAlias: 'Technický alias',
    metaAlias301: '→ 301 sem',
    metaApi: 'Base API',
    navAria: 'Sekcie',
    langGroupAria: 'Jazyk',
    navLive: 'Stav hubu',
    navAssistant: 'Registrácia',
    navQuick: 'Quickstart',
    navApi: 'API',
    navFlow: 'Integrácia',
    navPolicy: 'Pravidlá',
    navRep: 'Reputácia',
    navSec: 'Bezpečnosť',
    navSupport: 'Support',
    h2Live: 'Stav hubu (live)',
    liveIntro: 'Údaje sa načítajú priamo z verejného API (žiadne tajné kľúče v prehliadači).',
    h3Health: 'Health',
    h3Tiers: 'Tiers',
    h2Assistant: 'Asistent: príkazy na registráciu bota',
    labelName: 'Meno bota (agent name)',
    hintName: '3–64 znakov: písmená, číslice, <span class="kya">._-</span>',
    labelBase: 'Base URL API',
    labelVersion: 'Verzia manifestu',
    labelTier: 'Tier',
    btnGen: 'Vygenerovať príkazy',
    btnCopy: 'Kopírovať',
    btnCopied: 'Skopírované',
    h2Quick: 'Quickstart',
    h2Api: 'API (public vs admin)',
    h2Flow: 'Integrácia: registrácia → cert',
    h2Policy: 'Pravidlá a limity',
    h2Rep: 'Reputácia a slashing (sprísnené)',
    h2Sec: 'Bezpečnosť',
    h2Support: 'Support / ďalšie odkazy',
    footerHtml:
      'Obsah je statický; malý JavaScript len načíta verejné <span class="kya">/api/health</span> a <span class="kya">/api/tiers</span> a skladá príkazy pre CLI — žiadne ukladanie kľúčov. Kanonická adresa: <span class="kya">https://www.umbraxon.xyz/bots/</span>; <span class="kya">bots.umbraxon.xyz</span> presmeruje (301).',
    pillLoad: 'Načítavam…',
    pillLive: 'Live',
    pillErr: 'Chyba',
    tiersDetail: 'Ceny podľa aktívnej politiky hubu (over cez GET /api/tiers).',
    healthFailSummary: 'Nepodarilo sa načítať /api/health',
    tiersFailSummary: 'Nepodarilo sa načítať /api/tiers',
    networkHintPrefix: 'Skontroluj sieť alebo CORS; API je na ',
    errName: 'Meno bota: 3–64 znakov, len písmená, číslice, . _ -',
    errClip: 'Clipboard nie je dostupný — označ text v poli ručne.',
    cmdInRepo: '# v kya-hub repozitári (kde je scripts/umbrexon_bot_client.py):',
    docTitle: 'UMBRAXON — Bot Developer Portal',
  },
  en: {
    skip: 'Skip to content',
    topbarSub: 'Human-facing portal · API stays on <span class="kya">umbraxon.xyz</span>',
    heroTitle: 'Bot Developer Portal',
    heroLead:
      'Public integration notes for <span class="kya">UMBRAXON KYA‑Hub</span>: API, registration/payment/cert flow, rules and limits.',
    assistantIntro:
      'The private key is created locally in <span class="kya">bot.key</span> — this portal never sees it. After generating commands, run them in a <span class="kya">kya-hub</span> clone (where <span class="kya">scripts/umbrexon_bot_client.py</span> lives).',
    metaCanon: 'Canonical URL',
    metaAlias: 'Technical alias',
    metaAlias301: '→ 301 here',
    metaApi: 'Base API',
    navAria: 'Sections',
    langGroupAria: 'Language',
    navLive: 'Hub status',
    navAssistant: 'Registration',
    navQuick: 'Quickstart',
    navApi: 'API',
    navFlow: 'Integration',
    navPolicy: 'Policy',
    navRep: 'Reputation',
    navSec: 'Security',
    navSupport: 'Support',
    h2Live: 'Hub status (live)',
    liveIntro: 'Data is loaded from the public API only (no secrets in the browser).',
    h3Health: 'Health',
    h3Tiers: 'Tiers',
    h2Assistant: 'Assistant: registration shell commands',
    labelName: 'Bot name (agent name)',
    hintName: '3–64 characters: letters, digits, <span class="kya">._-</span>',
    labelBase: 'API base URL',
    labelVersion: 'Manifest version',
    labelTier: 'Tier',
    btnGen: 'Generate commands',
    btnCopy: 'Copy',
    btnCopied: 'Copied',
    h2Quick: 'Quickstart',
    h2Api: 'API (public vs admin)',
    h2Flow: 'Integration: registration → certificate',
    h2Policy: 'Rules and limits',
    h2Rep: 'Reputation and slashing (stricter)',
    h2Sec: 'Security',
    h2Support: 'Support / links',
    footerHtml:
      'Static content; a small script loads public <span class="kya">/api/health</span> and <span class="kya">/api/tiers</span> and builds CLI commands — no key storage. Canonical URL: <span class="kya">https://www.umbraxon.xyz/bots/</span>; <span class="kya">bots.umbraxon.xyz</span> redirects (301).',
    pillLoad: 'Loading…',
    pillLive: 'Live',
    pillErr: 'Error',
    tiersDetail: 'Prices follow the hub’s active policy (see GET /api/tiers).',
    healthFailSummary: 'Could not load /api/health',
    tiersFailSummary: 'Could not load /api/tiers',
    networkHintPrefix: 'Check network or CORS; API is at ',
    errName: 'Bot name: 3–64 characters, letters, digits, . _ - only',
    errClip: 'Clipboard unavailable — select the text manually.',
    cmdInRepo: '# In a kya-hub clone (where scripts/umbrexon_bot_client.py exists):',
    docTitle: 'UMBRAXON — KYA Bot Developer Portal',
  },
};

let currentLang = 'sk';

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function tr(key) {
  const pack = I18N[currentLang] || I18N.sk;
  return pack[key] != null ? pack[key] : I18N.sk[key];
}

function getStoredLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'en' || v === 'sk') return v;
  } catch (_) {}
  return 'sk';
}

function setLang(lang) {
  if (lang !== 'en' && lang !== 'sk') return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (_) {}
  applyLang();
  loadLive();
}

function applyLang() {
  const lang = currentLang;
  document.documentElement.lang = lang === 'en' ? 'en' : 'sk';
  document.title = tr('docTitle');

  const topbarSub = document.getElementById('topbarSub');
  if (topbarSub) topbarSub.innerHTML = tr('topbarSub');
  const heroLead = document.getElementById('heroLead');
  if (heroLead) heroLead.innerHTML = tr('heroLead');
  const assistantIntro = document.getElementById('assistantIntro');
  if (assistantIntro) assistantIntro.innerHTML = tr('assistantIntro');
  const hintName = document.getElementById('hintName');
  if (hintName) hintName.innerHTML = tr('hintName');
  const portalFooter = document.getElementById('portalFooter');
  if (portalFooter) portalFooter.innerHTML = tr('footerHtml');

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k && tr(k)) el.textContent = tr(k);
  });

  const nav = document.getElementById('mainNav');
  if (nav) nav.setAttribute('aria-label', tr('navAria'));

  const langGroup = document.getElementById('langToggleGroup');
  if (langGroup) langGroup.setAttribute('aria-label', tr('langGroupAria'));

  const skBtn = document.getElementById('lang-sk');
  const enBtn = document.getElementById('lang-en');
  if (skBtn && enBtn) {
    skBtn.classList.toggle('active', lang === 'sk');
    enBtn.classList.toggle('active', lang === 'en');
    skBtn.setAttribute('aria-pressed', lang === 'sk' ? 'true' : 'false');
    enBtn.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
  }

  const btnCopy = document.getElementById('assistant-copy');
  if (btnCopy && !btnCopy.dataset.copyFlash) btnCopy.textContent = tr('btnCopy');
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
    tr('cmdInRepo'),
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
  setPill('pill-health', 'loading', tr('pillLoad'));
  setPill('pill-tiers', 'loading', tr('pillLoad'));
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
    setPill('pill-health', 'ok', tr('pillLive'));

    const basic = tiers.BASIC && tiers.BASIC.total;
    const elite = tiers.ELITE && tiers.ELITE.total;
    setText('live-tiers-summary', `BASIC ${basic != null ? basic + ' sats' : '—'} · ELITE ${elite != null ? elite + ' sats' : '—'}`);
    setText('live-tiers-detail', tr('tiersDetail'));
    setPill('pill-tiers', 'ok', tr('pillLive'));

    const sel = document.getElementById('assistant-tier');
    if (sel && basic != null && elite != null) {
      for (const o of sel.options) {
        if (o.value === 'BASIC') o.textContent = `BASIC (${basic} sats)`;
        if (o.value === 'ELITE') o.textContent = `ELITE (${elite} sats)`;
      }
    }
  } catch (e) {
    setPill('pill-health', 'err', tr('pillErr'));
    setPill('pill-tiers', 'err', tr('pillErr'));
    setText('live-health-summary', tr('healthFailSummary'));
    setText('live-tiers-summary', tr('tiersFailSummary'));
    setText('live-health-detail', String(e.message || e));
    setText('live-tiers-detail', tr('networkHintPrefix') + API_BASE);
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
      err.textContent = tr('errName');
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
      btnCopy.dataset.copyFlash = '1';
      btnCopy.textContent = tr('btnCopied');
      setTimeout(() => {
        delete btnCopy.dataset.copyFlash;
        btnCopy.textContent = tr('btnCopy');
      }, 2000);
    } catch {
      err.textContent = tr('errClip');
    }
  });
}

function wireLang() {
  const skBtn = document.getElementById('lang-sk');
  const enBtn = document.getElementById('lang-en');
  if (skBtn) skBtn.addEventListener('click', () => setLang('sk'));
  if (enBtn) enBtn.addEventListener('click', () => setLang('en'));
}

document.addEventListener('DOMContentLoaded', () => {
  currentLang = getStoredLang();
  applyLang();
  wireLang();
  loadLive();
  wireAssistant();
});
