/**
 * UMBRAXON www — live hub, whitelist, Lightning pay, CLI assistant.
 * Loaded as classic script (defer) so globals (Alpine, QRCode) stay predictable.
 */
const LANG_KEY = 'kyahub_portal_lang';

function apiUrl(p) {
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${window.location.origin}${path}`;
}

/** Long doc bodies — switched with language */
const DOC_BODIES = {
  quick: {
    sk: `<p>Prečítaj <a class="text-cyan-400 hover:text-cyan-300" href="/openapi/openapi.yaml">OpenAPI</a>. Flow: registrácia → invoice → polling → cert → verify.</p>
      <p>Referenčný klient: <code class="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-amber-200/90">scripts/umbrexon_bot_client.py</code> — najprv <code class="font-mono text-amber-200/90">self-test</code> musí dať <code class="font-mono text-emerald-400">RESULT: PASS</code>.</p>
      <pre class="overflow-x-auto rounded-xl bg-slate-950/90 p-4 font-mono text-xs text-slate-300">curl -fsS /api/health</pre>`,
    en: `<p>Read the <a class="text-cyan-400 hover:text-cyan-300" href="/openapi/openapi.yaml">OpenAPI</a> spec. Flow: register → invoice → poll → certificate → verify.</p>
      <p>Reference client: <code class="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-amber-200/90">scripts/umbrexon_bot_client.py</code> — run <code class="font-mono text-amber-200/90">self-test</code> first; expect <code class="font-mono text-emerald-400">RESULT: PASS</code>.</p>
      <pre class="overflow-x-auto rounded-xl bg-slate-950/90 p-4 font-mono text-xs text-slate-300">curl -fsS /api/health</pre>`,
  },
  api: {
    sk: `<ul class="list-inside list-disc space-y-1 font-mono text-xs text-cyan-200/80">
      <li>GET /api/health</li><li>GET /api/tiers</li><li>GET /api/whitelist</li>
      <li>POST /api/register/initiate</li><li>POST /api/pay</li>
      <li>GET /api/check-status/{invoiceId}</li><li>GET /api/cert/&lt;KYA_ID&gt;</li></ul>`,
    en: `<ul class="list-inside list-disc space-y-1 font-mono text-xs text-cyan-200/80">
      <li>GET /api/health</li><li>GET /api/tiers</li><li>GET /api/whitelist</li>
      <li>POST /api/register/initiate</li><li>POST /api/pay</li>
      <li>GET /api/check-status/{invoiceId}</li><li>GET /api/cert/&lt;KYA_ID&gt;</li></ul>`,
  },
  limits: {
    sk: `<p>429 → spomaľ a rešpektuj <code class="font-mono text-slate-300">Retry-After</code>. 409 REPLAY → neopakuj rovnaký payload. 401/403 → podpisy / suspend / policy.</p>
      <p>Rate limiting je zónovo riadený. Zakázané: replay, falšovanie podpisov, obchádzanie abuse vrstvy.</p>`,
    en: `<p>429 → slow down and honour <code class="font-mono text-slate-300">Retry-After</code>. 409 REPLAY → do not replay the same payload. 401/403 → signatures / suspend / policy.</p>
      <p>Rate limiting is zone-based. Forbidden: replay, forged signatures, abuse-layer bypass.</p>`,
  },
  rep: {
    sk: `<p>Skóre v rozsahu <code class="font-mono">[0, 1000]</code>. SPAM_REPORT <strong class="text-red-400">−200</strong>, FRAUD_PROVEN <strong class="text-red-400">−500</strong>. Model: <a class="text-cyan-400 hover:text-cyan-300" href="/api/protocol/reputation-model">/api/protocol/reputation-model</a></p>`,
    en: `<p>Score clamped to <code class="font-mono">[0, 1000]</code>. SPAM_REPORT <strong class="text-red-400">−200</strong>, FRAUD_PROVEN <strong class="text-red-400">−500</strong>. Model: <a class="text-cyan-400 hover:text-cyan-300" href="/api/protocol/reputation-model">/api/protocol/reputation-model</a></p>`,
  },
  sign: {
    sk: `<p>Hub validuje <strong class="text-white">tri rôzne digesty</strong> — nie jeden univerzálny HMAC. Referenčný Python klient ich správne skladá.</p>
      <ul class="list-inside list-disc space-y-2 text-slate-400">
        <li><span class="font-mono text-amber-200/80">manifest_signature</span>: Ed25519 nad SHA-256 kanonického JSON manifestu (zoradené kľúče rekurzívne).</li>
        <li><span class="font-mono text-amber-200/80">challenge_response</span>: Ed25519 nad <strong class="text-white">raw</strong> bajtmi nonce z <span class="font-mono">/api/auth/challenge</span>.</li>
        <li><span class="font-mono text-amber-200/80">agent action signature</span>: Ed25519 nad SHA-256 JSON s <strong class="text-white">presným insertion-order</strong> kľúčov (nie sort).</li>
      </ul>`,
    en: `<p>The hub validates <strong class="text-white">three distinct digests</strong> — not one generic HMAC. The reference Python client implements all three.</p>
      <ul class="list-inside list-disc space-y-2 text-slate-400">
        <li><span class="font-mono text-amber-200/80">manifest_signature</span>: Ed25519 over SHA-256 of canonical JSON manifest (keys sorted recursively).</li>
        <li><span class="font-mono text-amber-200/80">challenge_response</span>: Ed25519 over <strong class="text-white">raw</strong> nonce bytes from <span class="font-mono">/api/auth/challenge</span>.</li>
        <li><span class="font-mono text-amber-200/80">agent action signature</span>: Ed25519 over SHA-256 of JSON with <strong class="text-white">fixed insertion-order</strong> keys (not sorted).</li>
      </ul>`,
  },
};

const I18N = {
  sk: {
    docTitle: 'UMBRAXON | KYA Hub',
    skip: 'Preskočiť na obsah',
    navLive: 'Stav',
    navAgents: 'Agenti',
    navPay: 'Platba',
    navCli: 'CLI',
    navDocs: 'Dokumentácia',
    menuOpen: 'Menu',
    brandWord: 'Umbraxon',
    brandSub: 'KYA Hub',
    heroKicker: 'Know Your Agent · Lightning · Ed25519',
    heroTitle: 'Identita a reputácia pre autonómnych agentov',
    heroLead:
      'Jeden hub: živý stav služieb, verejný zoznam overených agentov, Lightning platba a nástroje pre vývojárov — priamo na doméne www.',
    heroCtaLive: 'Stav hubu',
    heroCtaPay: 'Zaplatiť registráciu',
    dtOpenApi: 'OpenAPI',
    dtApi: 'API',
    ddApiLine: 'rovnaký pôvod · /api/*',
    dtAlias: 'Alias',
    ddAliasLine: 'bots.umbraxon.xyz → 301 → www',
    liveH2: 'Stav hubu (live)',
    liveIntro: 'Načítané z verejného API na tejto doméne.',
    h3Health: 'Health',
    h3Tiers: 'Tiers',
    wlH2: 'Overení agenti',
    wlIntro: 'Výrez z verejného whitelistu (GET /api/whitelist).',
    wlEmpty: 'Zatiaľ žiadni overení agenti alebo nedostupné API.',
    wlThAgent: 'Agent',
    wlThKya: 'KYA-ID',
    wlThRep: 'Rep.',
    wlThTier: 'Tier',
    payH2: 'Lightning · registrácia',
    payIntro: 'Zadaj meno agenta a tier. Po vytvorení faktúry naskenuj QR alebo otvor checkout.',
    payLabelName: 'Meno agenta',
    payLabelTier: 'Tier',
    payBtn: 'Vytvoriť faktúru',
    payWait: 'Čakám na platbu…',
    payPlaceholder: 'MOJBOT-001',
    cliH2: 'CLI asistent',
    cliIntro:
      'Privátny kľúč vzniká len lokálne v <code class="text-amber-400/90">bot.key</code>. Príkazy spúšťaj v klóne kya-hub (kde je <code class="text-amber-400/90">scripts/umbrexon_bot_client.py</code>).',
    labelName: 'Meno bota',
    hintName: '3–64 znakov: písmená, číslice, . _ -',
    labelBase: 'Base URL API',
    labelVersion: 'Verzia manifestu',
    labelTier: 'Tier',
    btnGen: 'Vygenerovať príkazy',
    btnCopy: 'Kopírovať',
    btnCopied: 'Skopírované',
    docsH2: 'Dokumentácia a pravidlá',
    docSumQuick: 'Quickstart',
    docSumApi: 'Public API',
    docSumLimits: 'Integrácia a limity',
    docSumRep: 'Reputácia',
    signingH3: 'Podpisy (tri digesty)',
    footerHtml:
      'Šablóna + <span class="text-amber-400/90">site/app.js</span> · živé <span class="text-amber-400/90">/api/*</span> · <span class="text-amber-400/90">https://www.umbraxon.xyz/</span> · <span class="text-amber-400/90">bots.umbraxon.xyz</span> → 301.',
    pillLoad: '…',
    pillLive: 'Live',
    pillErr: 'Chyba',
    tiersDetail: 'Ceny podľa aktívnej politiky hubu.',
    healthFail: 'Health nedostupné',
    tiersFail: 'Tiers nedostupné',
    netHint: 'Skontroluj sieť alebo CORS.',
    errName: 'Meno: 3–64 znakov, len [A-Za-z0-9._-]',
    errClip: 'Clipboard nedostupný.',
    cmdInRepo: '# v kya-hub repozitári (scripts/umbrexon_bot_client.py):',
    checkoutLink: 'Otvoriť checkout →',
    payMethodPrefix: 'Platba ',
    alertNoName: 'Zadaj meno agenta.',
    alertTiersWait: 'Tier ceny ešte nie sú načítané — počkaj chvíľu.',
    payConfirmed: 'Platba potvrdená.',
    payProcessing: 'Platba sa spracováva…',
    payExpired: 'Faktúra expirovala.',
    payCheckout: 'Otvor BTCPay checkout.',
  },
  en: {
    docTitle: 'UMBRAXON | KYA Hub',
    skip: 'Skip to content',
    navLive: 'Status',
    navAgents: 'Agents',
    navPay: 'Pay',
    navCli: 'CLI',
    navDocs: 'Docs',
    menuOpen: 'Menu',
    brandWord: 'Umbraxon',
    brandSub: 'KYA Hub',
    heroKicker: 'Know Your Agent · Lightning · Ed25519',
    heroTitle: 'Identity and reputation for autonomous agents',
    heroLead:
      'One surface: live service status, a public verified-agent feed, Lightning checkout, and developer tooling — on the main www host.',
    heroCtaLive: 'Hub status',
    heroCtaPay: 'Pay registration',
    dtOpenApi: 'OpenAPI',
    dtApi: 'API',
    ddApiLine: 'same origin · /api/*',
    dtAlias: 'Alias',
    ddAliasLine: 'bots.umbraxon.xyz → 301 → www',
    liveH2: 'Hub status (live)',
    liveIntro: 'Loaded from the public API on this host.',
    h3Health: 'Health',
    h3Tiers: 'Tiers',
    wlH2: 'Verified agents',
    wlIntro: 'Slice of the public whitelist (GET /api/whitelist).',
    wlEmpty: 'No verified agents yet, or API unavailable.',
    wlThAgent: 'Agent',
    wlThKya: 'KYA-ID',
    wlThRep: 'Rep.',
    wlThTier: 'Tier',
    payH2: 'Lightning · registration',
    payIntro: 'Enter agent name and tier. After the invoice is created, scan the QR or open checkout.',
    payLabelName: 'Agent name',
    payLabelTier: 'Tier',
    payBtn: 'Create invoice',
    payWait: 'Waiting for payment…',
    payPlaceholder: 'MYBOT-001',
    cliH2: 'CLI assistant',
    cliIntro:
      'Private keys stay in <code class="text-amber-400/90">bot.key</code> on your machine. Run commands in a kya-hub clone (<code class="text-amber-400/90">scripts/umbrexon_bot_client.py</code>).',
    labelName: 'Bot name',
    hintName: '3–64 chars: letters, digits, . _ -',
    labelBase: 'API base URL',
    labelVersion: 'Manifest version',
    labelTier: 'Tier',
    btnGen: 'Generate commands',
    btnCopy: 'Copy',
    btnCopied: 'Copied',
    docsH2: 'Documentation',
    docSumQuick: 'Quickstart',
    docSumApi: 'Public API',
    docSumLimits: 'Integration and limits',
    docSumRep: 'Reputation',
    signingH3: 'Signing (three digests)',
    footerHtml:
      'Template + <span class="text-amber-400/90">site/app.js</span> · live <span class="text-amber-400/90">/api/*</span> · <span class="text-amber-400/90">https://www.umbraxon.xyz/</span> · <span class="text-amber-400/90">bots.umbraxon.xyz</span> → 301.',
    pillLoad: '…',
    pillLive: 'Live',
    pillErr: 'Error',
    tiersDetail: 'Prices per active hub policy.',
    healthFail: 'Health unavailable',
    tiersFail: 'Tiers unavailable',
    netHint: 'Check network or CORS.',
    errName: 'Name: 3–64 chars, [A-Za-z0-9._-] only',
    errClip: 'Clipboard unavailable.',
    cmdInRepo: '# In a kya-hub clone (scripts/umbrexon_bot_client.py):',
    checkoutLink: 'Open checkout →',
    payMethodPrefix: 'Pay with ',
    alertNoName: 'Enter agent name.',
    alertTiersWait: 'Tier prices not loaded yet — wait a moment.',
    payConfirmed: 'Payment confirmed.',
    payProcessing: 'Processing confirmation…',
    payExpired: 'Invoice expired.',
    payCheckout: 'Open BTCPay checkout.',
  },
};

let currentLang = 'sk';
let tiersCache = null;

function tr(k) {
  const pack = I18N[currentLang] || I18N.sk;
  return pack[k] != null ? pack[k] : I18N.sk[k];
}

function getStoredLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'en' || v === 'sk') return v;
  } catch (_) {}
  return 'sk';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setPill(id, state, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className =
    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ' +
    (state === 'ok'
      ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40'
      : state === 'err'
        ? 'bg-red-500/15 text-red-300 ring-1 ring-red-500/35'
        : 'bg-slate-500/20 text-slate-300 ring-1 ring-white/10');
  el.textContent = label;
}

function applyDocBodies() {
  const lang = currentLang === 'en' ? 'en' : 'sk';
  const map = [
    ['doc-body-quick', DOC_BODIES.quick],
    ['doc-body-api', DOC_BODIES.api],
    ['doc-body-limits', DOC_BODIES.limits],
    ['doc-body-rep', DOC_BODIES.rep],
    ['doc-body-sign', DOC_BODIES.sign],
  ];
  for (const [id, body] of map) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = body[lang] || body.sk;
  }
}

function closeMobileNav() {
  const root = document.getElementById('main');
  if (root && typeof window.Alpine !== 'undefined' && window.Alpine.$data) {
    try {
      window.Alpine.$data(root).open = false;
    } catch (_) {}
  }
}

function applyLang() {
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'sk';
  document.title = tr('docTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k && tr(k) !== undefined && tr(k) !== '') el.textContent = tr(k);
  });
  const heroLead = document.getElementById('heroLead');
  if (heroLead) heroLead.innerHTML = tr('heroLead');
  const cliIntro = document.getElementById('cliIntro');
  if (cliIntro) cliIntro.innerHTML = tr('cliIntro');
  const hintName = document.getElementById('hintName');
  if (hintName) hintName.innerHTML = tr('hintName');
  const footer = document.getElementById('siteFooter');
  if (footer) footer.innerHTML = tr('footerHtml');
  const payPh = document.getElementById('pay-agent');
  if (payPh) payPh.setAttribute('placeholder', tr('payPlaceholder'));

  const ddApi = document.getElementById('dd-api-line');
  if (ddApi) ddApi.textContent = tr('ddApiLine');
  const ddAlias = document.getElementById('dd-alias-line');
  if (ddAlias) ddAlias.textContent = tr('ddAliasLine');

  applyDocBodies();

  const skBtn = document.getElementById('lang-sk');
  const enBtn = document.getElementById('lang-en');
  const skM = document.getElementById('lang-sk-mobile');
  const enM = document.getElementById('lang-en-mobile');
  [skBtn, enBtn, skM, enM].forEach((b) => {
    if (!b) return;
    const isSk = b.id === 'lang-sk' || b.id === 'lang-sk-mobile';
    const active = (isSk && currentLang === 'sk') || (!isSk && currentLang === 'en');
    b.classList.toggle('bg-amber-400/20', active);
    b.classList.toggle('text-amber-100', active);
    b.classList.toggle('text-slate-300', !active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const btnCopy = document.getElementById('assistant-copy');
  if (btnCopy && !btnCopy.dataset.copyFlash) btnCopy.textContent = tr('btnCopy');

  const sm = document.getElementById('status-msg');
  if (sm && !sm.dataset.payActive) sm.textContent = tr('payWait');
}

function setLang(lang) {
  if (lang !== 'en' && lang !== 'sk') return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (_) {}
  closeMobileNav();
  applyLang();
  loadLive();
  loadWhitelist();
}

function isValidAgentName(name) {
  return (
    typeof name === 'string' &&
    name.length >= 3 &&
    name.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
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
      fetch(apiUrl('/api/health'), { credentials: 'omit' }),
      fetch(apiUrl('/api/tiers'), { credentials: 'omit' }),
    ]);
    if (!hRes.ok) throw new Error(`health ${hRes.status}`);
    if (!tRes.ok) throw new Error(`tiers ${tRes.status}`);
    const health = await hRes.json();
    const tiers = await tRes.json();
    tiersCache = tiers;

    const hubOk = health.server === 'OK';
    window.__hubHealthOk = hubOk;

    const hub = health.server === 'OK' ? 'OK' : health.server || '?';
    setText('live-health-summary', `Hub: ${hub}`);
    const db = health.db && health.db.status ? health.db.status : '—';
    const pay = health.btcpay && health.btcpay.status ? health.btcpay.status : '—';
    const alby = health.alby || '—';
    setText('live-health-detail', `DB ${db} · BTCPay ${pay} · Alby ${alby}`);
    setPill('pill-health', 'ok', tr('pillLive'));

    const basic = tiers.BASIC && tiers.BASIC.total;
    const elite = tiers.ELITE && tiers.ELITE.total;
    setText(
      'live-tiers-summary',
      `BASIC ${basic != null ? basic + ' sats' : '—'} · ELITE ${elite != null ? elite + ' sats' : '—'}`
    );
    setText('live-tiers-detail', tr('tiersDetail'));
    setPill('pill-tiers', 'ok', tr('pillLive'));

    const sel = document.getElementById('assistant-tier');
    const paySel = document.getElementById('pay-tier');
    if (basic != null && elite != null) {
      if (sel) {
        for (const o of sel.options) {
          if (o.value === 'BASIC') o.textContent = `BASIC (${basic} sats)`;
          if (o.value === 'ELITE') o.textContent = `ELITE (${elite} sats)`;
        }
      }
      if (paySel) {
        for (const o of paySel.options) {
          if (o.value === 'BASIC') {
            o.textContent = `BASIC (${basic} sats)`;
            o.dataset.amount = String(basic);
          }
          if (o.value === 'ELITE') {
            o.textContent = `ELITE (${elite} sats)`;
            o.dataset.amount = String(elite);
          }
        }
      }
    }
  } catch (e) {
    tiersCache = null;
    window.__hubHealthOk = false;
    setPill('pill-health', 'err', tr('pillErr'));
    setPill('pill-tiers', 'err', tr('pillErr'));
    setText('live-health-summary', tr('healthFail'));
    setText('live-tiers-summary', tr('tiersFail'));
    setText('live-health-detail', String(e.message || e));
    setText('live-tiers-detail', tr('netHint'));
  }
}

async function loadWhitelist() {
  const tb = document.getElementById('wl-body');
  if (!tb) return;
  tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">${tr('pillLoad')}</td></tr>`;
  try {
    const r = await fetch(apiUrl('/api/whitelist?limit=12'), { credentials: 'omit' });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    const rows = data.agents || [];
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">${escapeHtml(tr('wlEmpty'))}</td></tr>`;
      return;
    }
    tb.innerHTML = rows
      .map(
        (a) => `<tr class="border-t border-white/5 hover:bg-white/[0.03]">
      <td class="px-3 py-2.5 font-medium text-slate-100">${escapeHtml(a.agent_name || '')}</td>
      <td class="px-3 py-2.5 font-mono text-xs text-cyan-300/90">${escapeHtml(String(a.kya_id || ''))}</td>
      <td class="px-3 py-2.5 text-slate-400">${escapeHtml(String(a.reputation_score ?? ''))}</td>
      <td class="px-3 py-2.5"><span class="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">${escapeHtml(a.tier || '')}</span></td>
    </tr>`
      )
      .join('');
  } catch (_) {
    tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">${escapeHtml(tr('wlEmpty'))}</td></tr>`;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wireAssistant() {
  const out = document.getElementById('assistant-output');
  const err = document.getElementById('assistant-error');
  const btnGen = document.getElementById('assistant-generate');
  const btnCopy = document.getElementById('assistant-copy');
  if (!out || !err || !btnGen || !btnCopy) return;

  function render() {
    err.textContent = '';
    const nameEl = document.getElementById('assistant-name');
    const baseEl = document.getElementById('assistant-base');
    const verEl = document.getElementById('assistant-version');
    const tierEl = document.getElementById('assistant-tier');
    if (!nameEl || !baseEl || !verEl || !tierEl) return;
    const name = nameEl.value.trim();
    const baseUrl = baseEl.value.trim() || window.location.origin;
    const version = verEl.value.trim() || '1.0.0';
    const tier = tierEl.value;
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

function wirePay() {
  const btn = document.getElementById('btn-pay');
  if (!btn) return;
  btn.addEventListener('click', initiateKYA);
}

async function initiateKYA() {
  const agentName = document.getElementById('pay-agent')?.value.trim() || '';
  const tierSel = document.getElementById('pay-tier');
  const opt = tierSel && tierSel.selectedOptions && tierSel.selectedOptions[0];
  const amount = opt && opt.dataset.amount ? parseInt(opt.dataset.amount, 10) : NaN;

  if (!agentName) {
    alert(tr('alertNoName'));
    return;
  }
  if (!isValidAgentName(agentName)) {
    alert(tr('errName'));
    return;
  }
  if (!Number.isFinite(amount)) {
    alert(tr('alertTiersWait'));
    return;
  }

  const res = await fetch(apiUrl('/api/pay'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName, amount, pubkey: '', manifest: {} }),
  });
  const data = await res.json();
  if (data.error) {
    alert(`[${data.error}] ${data.message || ''}`);
    return;
  }

  const qrBox = document.getElementById('qrcode');
  const qrContainer = document.getElementById('qr-container');
  const statusMsg = document.getElementById('status-msg');
  const invoiceLink = document.getElementById('invoice-link');
  if (!qrBox || !qrContainer || typeof window.QRCode === 'undefined') {
    alert('QRCode library not loaded');
    return;
  }

  qrContainer.classList.remove('hidden');
  qrBox.innerHTML = '';
  if (statusMsg) {
    statusMsg.dataset.payActive = '1';
  }

  if (data.paymentRequest) {
    // eslint-disable-next-line no-new
    new window.QRCode(qrBox, { text: data.paymentRequest, width: 200, height: 200 });
    const methodLabel = (data.paymentMethod || '').includes('LNURL')
      ? 'LNURL-Pay'
      : (data.paymentMethod || '').includes('LIGHTNING')
        ? 'Lightning'
        : 'Bitcoin';
    if (statusMsg) {
      statusMsg.textContent = `${tr('payMethodPrefix')}${methodLabel} (${amount} sats)`;
    }
  } else if (data.checkoutLink) {
    // eslint-disable-next-line no-new
    new window.QRCode(qrBox, { text: data.checkoutLink, width: 200, height: 200 });
    if (statusMsg) statusMsg.textContent = tr('payCheckout');
  }
  if (invoiceLink && data.checkoutLink) {
    invoiceLink.innerHTML = `<a href="${escapeHtml(data.checkoutLink)}" target="_blank" rel="noopener" class="text-cyan-400 hover:text-cyan-300">${escapeHtml(tr('checkoutLink'))}</a>`;
  }

  if (data.invoiceId) monitorPayment(data.invoiceId);
}

function monitorPayment(invoiceId) {
  const statusEl = document.getElementById('status-msg');
  const check = setInterval(async () => {
    try {
      const res = await fetch(apiUrl(`/api/check-status/${invoiceId}`));
      const data = await res.json();
      if (data.status === 'PAID') {
        clearInterval(check);
        if (statusEl) {
          statusEl.textContent = tr('payConfirmed');
          statusEl.classList.add('text-emerald-400');
          delete statusEl.dataset.payActive;
        }
        setTimeout(() => location.reload(), 2200);
      } else if (data.status === 'PROCESSING') {
        if (statusEl) statusEl.textContent = tr('payProcessing');
      } else if (data.status === 'EXPIRED') {
        clearInterval(check);
        if (statusEl) {
          statusEl.textContent = tr('payExpired');
          statusEl.classList.add('text-red-400');
          delete statusEl.dataset.payActive;
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, 3000);
}

function wireLang() {
  document.getElementById('lang-sk')?.addEventListener('click', () => setLang('sk'));
  document.getElementById('lang-en')?.addEventListener('click', () => setLang('en'));
  document.getElementById('lang-sk-mobile')?.addEventListener('click', () => setLang('sk'));
  document.getElementById('lang-en-mobile')?.addEventListener('click', () => setLang('en'));
}

/** Subtle animated gradient shift (no extra dependencies) */
function initHueShift() {
  let t = 0;
  const root = document.documentElement;
  function tick() {
    t += 0.0035;
    const a = 38 + Math.sin(t) * 8;
    const b = 185 + Math.cos(t * 0.9) * 12;
    root.style.setProperty('--orb-amber', String(a));
    root.style.setProperty('--orb-cyan', String(b));
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** Soft canvas shimmer behind hero — reacts to hub health colour */
function initHeroCanvas() {
  const c = document.getElementById('hero-canvas');
  if (!c || !c.getContext) return;
  const ctx = c.getContext('2d');
  const W = () => (c.width = c.clientWidth * (window.devicePixelRatio || 1));
  const H = () => (c.height = c.clientHeight * (window.devicePixelRatio || 1));
  function resize() {
    W();
    H();
  }
  resize();
  window.addEventListener('resize', resize);
  let frame = 0;
  function draw() {
    frame += 1;
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const ok = window.__hubHealthOk;
    const col =
      ok === true ? 'rgba(52, 211, 153,' : ok === false ? 'rgba(248, 113, 113,' : 'rgba(148, 163, 184,';
    for (let i = 0; i < 48; i++) {
      const x = ((i * 73 + frame * 2) % (w + 40)) - 20;
      const y = (Math.sin((i + frame) * 0.08) * 0.5 + 0.5) * h;
      const r = 1.2 + (i % 3) * 0.45;
      ctx.beginPath();
      ctx.fillStyle = col + (0.03 + (i % 5) * 0.012) + ')';
      ctx.arc(x, y, r * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/** Lottie ambient (vendor JSON under /site/) — falls back to canvas-only if load fails */
function getLottieApi() {
  return window.lottie || window.bodymovin;
}

async function initBrandLottie() {
  const el = document.getElementById('lottie-hero');
  const canvas = document.getElementById('hero-canvas');
  const Lottie = getLottieApi();
  if (!el || typeof Lottie === 'undefined' || typeof Lottie.loadAnimation !== 'function') return;
  try {
    const r = await fetch('/site/brand-ambient.json', { credentials: 'omit' });
    if (!r.ok) throw new Error(String(r.status));
    const animationData = await r.json();
    if (window.__brandLottieDestroy) {
      try {
        window.__brandLottieDestroy();
      } catch (_) {}
    }
    const anim = Lottie.loadAnimation({
      container: el,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData,
    });
    anim.setSpeed(0.5);
    window.__brandLottieDestroy = () => {
      anim.destroy();
      delete window.__brandLottieDestroy;
    };
    el.classList.remove('opacity-0');
    el.classList.add('opacity-50');
    if (canvas) canvas.classList.add('opacity-50');
  } catch (e) {
    console.warn('[lottie] brand ambient skipped:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const base = document.getElementById('assistant-base');
  if (base) base.value = window.location.origin;

  currentLang = getStoredLang();
  initHueShift();
  initHeroCanvas();
  applyLang();
  wireLang();
  wireAssistant();
  wirePay();
  loadLive();
  loadWhitelist();
  void initBrandLottie();
});
