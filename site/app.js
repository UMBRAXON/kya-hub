/**
 * UMBRAXON www — unified shell: live hub + verified agents + Lightning pay + CLI assistant.
 * Same-origin /api only. No secrets in browser (keys stay local for CLI flow).
 */
const LANG_KEY = 'kyahub_portal_lang';

function apiUrl(p) {
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${window.location.origin}${path}`;
}

const I18N = {
  sk: {
    docTitle: 'UMBRAXON | KYA Hub',
    skip: 'Preskočiť na obsah',
    navLive: 'Stav',
    navAgents: 'Agenti',
    navPay: 'Platba',
    navCli: 'CLI',
    navDocs: 'Dokumentácia',
    heroKicker: 'Know Your Agent · Lightning · Ed25519',
    heroTitle: 'Identita a reputácia pre autonómnych agentov',
    heroLead:
      'Jeden hub: živý stav služieb, verejný zoznam overených agentov, Lightning platba a nástroje pre vývojárov — priamo na doméne www.',
    heroCtaLive: 'Stav hubu',
    heroCtaPay: 'Zaplatiť registráciu',
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
    footerHtml:
      'Statická šablóna + <span class="text-amber-400/90">site/app.js</span> · živé dáta z <span class="text-amber-400/90">/api/*</span> · kanonická stránka: <span class="text-amber-400/90">https://www.umbraxon.xyz/</span> · <span class="text-amber-400/90">bots.umbraxon.xyz</span> → 301.',
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
    openApi: 'OpenAPI',
    signingH3: 'Podpisy (tri digesty)',
  },
  en: {
    docTitle: 'UMBRAXON | KYA Hub',
    skip: 'Skip to content',
    navLive: 'Status',
    navAgents: 'Agents',
    navPay: 'Pay',
    navCli: 'CLI',
    navDocs: 'Docs',
    heroKicker: 'Know Your Agent · Lightning · Ed25519',
    heroTitle: 'Identity and reputation for autonomous agents',
    heroLead:
      'One surface: live service status, a public verified-agent feed, Lightning checkout, and developer tooling — on the main www host.',
    heroCtaLive: 'Hub status',
    heroCtaPay: 'Pay registration',
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
    footerHtml:
      'Static shell + <span class="text-amber-400/90">site/app.js</span> · live <span class="text-amber-400/90">/api/*</span> · canonical: <span class="text-amber-400/90">https://www.umbraxon.xyz/</span> · <span class="text-amber-400/90">bots.umbraxon.xyz</span> → 301.',
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
    openApi: 'OpenAPI',
    signingH3: 'Signing (three digests)',
  },
};

let currentLang = 'sk';
let tiersCache = null;

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

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

function applyLang() {
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'sk';
  document.title = tr('docTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k && tr(k)) el.textContent = tr(k);
  });
  const heroLead = document.getElementById('heroLead');
  if (heroLead) heroLead.innerHTML = tr('heroLead');
  const cliIntro = document.getElementById('cliIntro');
  if (cliIntro) cliIntro.innerHTML = tr('cliIntro');
  const hintName = document.getElementById('hintName');
  if (hintName) hintName.innerHTML = tr('hintName');
  const footer = document.getElementById('siteFooter');
  if (footer) footer.innerHTML = tr('footerHtml');
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
}

function setLang(lang) {
  if (lang !== 'en' && lang !== 'sk') return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (_) {}
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
  tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">…</td></tr>`;
  try {
    const r = await fetch(apiUrl('/api/whitelist?limit=12'), { credentials: 'omit' });
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    const rows = data.agents || [];
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">${tr('wlEmpty')}</td></tr>`;
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
    tb.innerHTML = `<tr><td colspan="4" class="px-3 py-6 text-center text-slate-500">${tr('wlEmpty')}</td></tr>`;
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
  const out = $('assistant-output');
  const err = $('assistant-error');
  const btnGen = $('assistant-generate');
  const btnCopy = $('assistant-copy');

  function render() {
    err.textContent = '';
    const name = $('assistant-name').value.trim();
    const baseUrl = $('assistant-base').value.trim() || window.location.origin;
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

function wirePay() {
  const btn = document.getElementById('btn-pay');
  if (!btn) return;
  btn.addEventListener('click', initiateKYA);
}

async function initiateKYA() {
  const agentName = document.getElementById('pay-agent').value.trim();
  const tierSel = document.getElementById('pay-tier');
  const opt = tierSel && tierSel.selectedOptions && tierSel.selectedOptions[0];
  const amount = opt && opt.dataset.amount ? parseInt(opt.dataset.amount, 10) : NaN;

  if (!agentName) {
    alert(currentLang === 'en' ? 'Enter agent name.' : 'Zadaj meno agenta.');
    return;
  }
  if (!isValidAgentName(agentName)) {
    alert(tr('errName'));
    return;
  }
  if (!Number.isFinite(amount)) {
    alert(currentLang === 'en' ? 'Tiers not loaded yet — wait a moment.' : 'Tier ceny ešte nie sú načítané — počkaj chvíľu.');
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
  if (!qrBox || !qrContainer || !window.QRCode) return;

  qrContainer.classList.remove('hidden');
  qrBox.innerHTML = '';

  if (data.paymentRequest) {
    // eslint-disable-next-line no-new
    new QRCode(qrBox, { text: data.paymentRequest, width: 200, height: 200 });
    const methodLabel = (data.paymentMethod || '').includes('LNURL')
      ? 'LNURL-Pay'
      : (data.paymentMethod || '').includes('LIGHTNING')
        ? 'Lightning'
        : 'Bitcoin';
    statusMsg.textContent =
      (currentLang === 'en' ? 'Pay with ' : 'Platba ') +
      methodLabel +
      (currentLang === 'en' ? ` (${amount} sats)` : ` (${amount} sats)`);
  } else if (data.checkoutLink) {
    // eslint-disable-next-line no-new
    new QRCode(qrBox, { text: data.checkoutLink, width: 200, height: 200 });
    statusMsg.textContent = currentLang === 'en' ? 'Open BTCPay checkout.' : 'Otvor BTCPay checkout.';
  }
  if (invoiceLink && data.checkoutLink) {
    invoiceLink.innerHTML = `<a href="${escapeHtml(data.checkoutLink)}" target="_blank" rel="noopener" class="text-cyan-400 hover:text-cyan-300">Checkout →</a>`;
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
        statusEl.textContent = currentLang === 'en' ? 'Payment confirmed.' : 'Platba potvrdená.';
        statusEl.classList.add('text-emerald-400');
        setTimeout(() => location.reload(), 2200);
      } else if (data.status === 'PROCESSING') {
        statusEl.textContent =
          currentLang === 'en' ? 'Processing confirmation…' : 'Platba sa spracováva…';
      } else if (data.status === 'EXPIRED') {
        clearInterval(check);
        statusEl.textContent = currentLang === 'en' ? 'Invoice expired.' : 'Faktúra expirovala.';
        statusEl.classList.add('text-red-400');
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

document.addEventListener('DOMContentLoaded', () => {
  currentLang = getStoredLang();
  applyLang();
  wireLang();
  wireAssistant();
  wirePay();
  loadLive();
  loadWhitelist();
});
