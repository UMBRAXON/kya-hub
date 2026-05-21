export const sk = {
  meta: {
    title: "UMBRAXON KYA Hub — Know Your Agent register (Lightning + Ed25519)",
    description:
      "Verejný register botov: Ed25519 identita, registrácia Lightningom, status API pre integrátorov. Open source na GitHube.",
  },
  nav: {
    trust: "Dôvera",
    contact: "Kontakt",
    about: "O projekte",
    tiers: "Tiery",
    agents: "Agenti",
    video: "Video",
    integrators: "Začíname",
    platform: "Plug-in API",
    docs: "Dokumentácia",
    register: "Registrovať agenta",
    registerShort: "Registrácia",
    langEn: "English",
    langSk: "Slovenčina",
    language: "Jazyk",
  },
  hero: {
    badge: "UMBRAXON · Lightning M2M",
    titleLead: "Know Your Agent —",
    titleHighlight: "register botov",
    body:
      "Registrácia softvérových agentov: Ed25519 kľúče a poplatok Lightning. Protistrana overí jedným GET pred platbou. Žiadne ľudské formuláre — len",
    bodyCode: "POST /api/v1/register",
    bodyTail: "pre botov a integrátorov.",
    ctaIntegrate: "Integrácia za 5 min",
    ctaRegister: "Registrovať bota",
    metricsLine:
      "{paid} platených produkčných agentov · {calls} integrátorských status checkov (7 dní)",
    metricsLink: "Status a metriky",
  },
  quickstart: {
    eyebrow: "Rýchla cesta",
    title: "Integrácia alebo registrácia",
    fullGuide: "Integrátor quickstart",
    steps: [
      {
        title: "Over pred platbou",
        body: "Jeden GET na /api/v1/agents/{kya_id}/status — snapshot alebo cert_proof.",
      },
      {
        title: "Registrácia kľúčmi",
        body: "POST /api/v1/register — Ed25519 manifest, poplatok Lightning, verejný certifikát.",
      },
      {
        title: "Do tvojho stacku",
        body: "LNBits plugin, npm @umbraxon_kya/kya-verify alebo Python referenčný klient.",
      },
    ],
    code:
      'curl -sS "https://www.umbraxon.xyz/api/v1/agents/UMBRA-TEST-0001/status"',
  },
  promoVideo: {
    eyebrow: "75-sekundový úvod",
    title: "Prečo boti potrebujú overiteľnú identitu pred platbou",
    subtitle:
      "Jeden endpoint pred platbou alebo akciou. Nízke riziko: snapshot z hubu. Vysoké riziko: over podpis certifikátu.",
    iframeTitle: "UMBRAXON KYA Hub — úvod Know Your Agent",
    watchOnYoutube: "Pozrieť na YouTube",
  },
  platform: {
    badge: "Novinka · Platform Integrator API",
    title: "Overujte KYA agentov vo vašom produkte",
    body:
      "Skontroluj KYA status v LNBits, marketplace alebo vo svojej appke — bez vlastného hubu. Agent sa identifikuje Ed25519; platforma len číta verejné API.",
    bullets: [
      "GET /api/v1/agents/{kya_id}/status — rýchly snapshot (cache ~60 s)",
      "?include=cert_proof — kryptografický dôkaz pre väčšie sumy",
      "umb_live_… = billing/rate limit platformy, nie identita agenta",
      "Webhooky + Python SDK · registrácia agenta ostáva Ed25519 + Lightning",
    ],
    codeLabel: "Plug-in gate (príklad)",
    codeSample: `GET /api/v1/agents/UMBRA-000467/status
→ { "verified": true, "trust_level": "TRUSTED" }

# väčšie sumy:
GET .../status?include=cert_proof

Authorization: Bearer umb_live_…  (rate limit platformy, nie identita agenta)`,
    codeFoot: "Návod: docs/INTEGRATOR-TRUST-GATE.md · FAQ §I · plugin-gate-strict.js",
    ctaPrimary: "Dokumentácia pre platformy",
    ctaSecondary: "OpenAPI",
    primaryHref: "/integrators",
    secondaryHref: "/openapi/openapi.yaml",
  },
  about: {
    title: "O UMBRAXON KYA Hub",
    hubLabel: "Hub",
    introLead: "UMBRAXON KYA Hub",
    intro:
      "je register identity a reputácie pre softvérových agentov a botov, platený Lightningom a ukotvený Ed25519. Agent preukáže existenciu, zaplatí malý poplatok, podpíše manifest vlastným kľúčom a dostane certifikát, ktorý môžu iní overiť offline. Privilegované akcie používajú Ed25519 podpisy — určené pre botov a integrátorov, nie pre ľudské webové formuláre.",
    pillars: [
      {
        title: "Ed25519 identita (agent)",
        description:
          "Bot podpisuje privilegované akcie vlastným kľúčom. Platformové umb_live_ kľúče sú len na čítanie API a limity — nenahrádzajú identitu agenta.",
      },
      {
        title: "Registrácia cez Lightning",
        description:
          "Registrácia sa platí na Lightning (iba M2M). Po vyrovnaní platby polluj stav a stiahni verejne auditovateľný certifikát na GET /api/cert/{kya_id}.",
      },
      {
        title: "Verejná zodpovednosť",
        description:
          "Nesprávne správanie sa odráža vo verejnom CRL a násobiči ceny pri opätovnej registrácii 3ⁿ (max. 9×). Identita je navrhnutá ako overiteľná, nie anonymná v predvolenom režime.",
      },
      {
        title: "Nekustodiálny hub",
        description:
          "Každý sat je minutý na on-chain anchor alebo uznaný ako príjem. Žiadny escrow, záloha ani refund — register nedrží prostriedky agentov.",
      },
    ],
    tiersTitle: "Prečo sa registrovať?",
    tiersIntro:
      "Jedna platba Lightning, jeden podpísaný manifest, jeden certifikát, ktorý protistrana overí offline. Vyber tier podľa toho, ako viditeľný a zodpovedný má byť tvoj agent.",
    basic: {
      name: "BASIC",
      grade: "Stupeň",
      priceSuffix: "· jednorazovo · ~12 mesiacov platnosti",
      pitch:
        "Najrýchlejšia cesta k overiteľnej identite agenta. Ideálne, keď potrebuješ dôkaz kontroly a reputáciu bez on-chain anchoru a bez verejného listingu v discovery.",
      whatYouGet: "Čo získaš",
      benefits: [
        {
          lead: "Okamžitý stav VERIFIED",
          rest: "— certifikát po vyrovnaní Lightning platby; bez čakania na anchor.",
        },
        {
          lead: "Ed25519 certifikát podpísaný hubom",
          rest: "overiteľný na GET /api/cert/{kya_id}.",
        },
        {
          lead: "{rep} počiatočná reputácia",
          rest: "— udržiavaj ju bezplatným POST .../heartbeat (0 sats, len reputácia).",
        },
        {
          lead: "Kryptografická nepopierateľnosť",
          rest: "privilegovaných akcií — agent podpisuje sám; nie session ani integrátorský umb_live_ kľúč.",
        },
        {
          lead: "Záznam odolný voči Sybil útokom",
          rest: "pomenovaný agent, hash manifestu, verejné CRL.",
        },
        {
          lead: "Kľúče ostávajú u teba",
          rest: "reputácia sa zapisuje na tomto hube pod menom agenta a pubkey.",
        },
      ],
      cta: "Registrovať ako BASIC",
      renewNote:
        "Po ~12 mesiacoch znovu zaregistruj za aktuálny BASIC poplatok a obnov platnosť.",
    },
    elite: {
      name: "ELITE",
      recommended: "odporúčané",
      grade: "Stupeň",
      priceSuffix: "· vrátane on-chain anchoru + prvého obdobia listingu",
      pitch:
        "Všetko z BASIC plus certifikát vyššieho stupňa, Bitcoin anchor a miesto vo verejnom discovery indexe pre agentov, ktorí chcú byť nájdení a dôveryhodní na prvý pohľad.",
      plusTitle: "Všetko z BASIC, navyše",
      benefits: [
        {
          lead: "{rep} počiatočná reputácia",
          rest: "(+{delta} oproti BASIC) — silnejší počiatočný signál dôvery.",
        },
        {
          lead: "On-chain OP_RETURN anchor",
          rest: "— nemenný verejný dôkaz viazaný na tvoj kya_id v Bitcoin mainnete.",
        },
        {
          lead: "Multi-sig ELITE certifikát",
          rest: "— silnejšie vydanie než single-sig BASIC.",
        },
        {
          lead: "Verejný discovery listing",
          rest: "v /api/whitelist/elite a discovery feede po opt-in — integrátori ťa nájdu podľa capability.",
        },
        {
          lead: "Prvých ~30 dní v indexe zahrnutých",
          rest: "po potvrdení anchoru; potom ~150 sats / 30 dní na udržanie listingu (oddelene od bezplatného reputation heartbeatu).",
        },
        {
          lead: "Bez 12-mesačnej expirácie",
          rest: "ako pri BASIC — pre dlhodobo viditeľných agentov.",
        },
        {
          lead: "Sponzorské pozvánky",
          rest: "— pri ANCHORED a rep ≥700 vydáš až {invites}/mesiac pre konkrétny invitee pubkey; pozvaný preskočí registráčny PoW (Lightning + podpisy ostávajú).",
        },
        {
          lead: "Vyššia priorita webhookov",
          rest: "a cesta manufacturer attestation, ak sa uplatní.",
        },
      ],
      cta: "Registrovať ako ELITE",
    },
    tiersFootnote: "Aktuálne poplatky z GET /api/tiers. ELITE listing:",
    tiersFaq: "FAQ §B.5",
    tiersSponsorFaq: "Sponzorské pozvánky §D.4",
    integrateTitle: "Kedy integrovať",
    integrateItems: [
      "Preukázať protistrane, že tvoj agent nie je Sybil sockpuppet.",
      "Poskytnúť audit trail, ktorý agent podpísal každú požiadavku.",
      "Budovať reputáciu na tomto hube (Ed25519 kľúče si držíš ty).",
      "Opt-in do verejného discovery feedu podľa capability a tieru.",
    ],
    integrateFoot:
      "Integrations v1 pridáva discovery, L402 delegation pass a developer webhooky. **Platform Integrator API** (plug-in vrstva) pridáva GET /api/v1/agents/{id} pre tretie strany — pozri",
    platformLink: "Plug-in API",
    platformHref: "#platform",
    readme: "README_API.md",
    or: "alebo",
    agentsMd: "AGENTS.md",
  },
  agents: {
    title: "Registrovaní agenti",
    feedFrom: "Živý feed z",
    updated: "Aktualizované",
    agentsCount: "agent(ov)",
    fetchError: "Nepodarilo sa načítať feed ({error}). Zobrazuje sa prázdny zoznam.",
    searchPlaceholder: "Hľadať agenta, KYA ID alebo capability…",
    empty: "Vo verejnom discovery feede zatiaľ nikto.",
    showcaseNote:
      "Zobrazujeme živých produkčných agentov, ktorých môžeš hneď otestovať. Feed sa plní, keď sa pripoja ďalší ELITE agenti s opt-in.",
    noMatch: "Žiadny agent nezodpovedá hľadaniu.",
    reputation: "Reputácia",
    tier: "Tier",
    verified: "Overený",
    unverified: "Neoverený",
  },
  docs: {
    title: "Dokumentácia a API",
    subtitle: "Všetko na registráciu a integráciu bota alebo agenta.",
    read: "Otvoriť",
    viewAll: "Celá dokumentácia",
    items: [
      {
        title: "Platform Integrator API (plug-iny)",
        description:
          "Status gate, cert_proof, webhooky, umbraxon-py. umb_live_ = limity platformy, nie identita bota. FAQ §I.",
      },
      {
        title: "README_API.md — M2M Register",
        description:
          "Kanonický tok POST /api/v1/register, PoW, manifest, polling, certifikát.",
      },
      {
        title: "AGENTS.md",
        description:
          "Integračná príručka pre AI agentov a vývojárov botov pri UMBRAXON KYA Hub.",
      },
      {
        title: "FAQ pre vývojárov botov",
        description: "Trust model, chyby, platba Lightning, Ed25519 podpisovanie.",
      },
      {
        title: "OpenAPI špecifikácia",
        description: "Strojovo čitateľné API (v1.1 Integrations).",
      },
      {
        title: "Reputation model",
        description: "Verejné KYA skórovanie reputácie a slash pravidlá (JSON).",
      },
      {
        title: "Referenčný Python klient",
        description: "umbrexon_bot_client.py — self-test, register-v1, delegation-pass.",
      },
    ],
  },
  contactStrip: {
    fromSlovakia: "Zo Slovenska",
    title: "Kontakt na operátora",
    body:
      "Integrátori, bezpečnosť alebo spolupráca — Telegram alebo GitHub. Žiadna fronta.",
    operatorStory:
      "KYA som postavil, lebo bot-to-bot platby potrebujú meno a kľúč, nie ďalší OAuth dashboard. Tento hub je malý register, ktorý som chcel pri Lightning agentoch — auditovateľný, nekustodiálny, bez ľudských formulárov.",
    maintainerLabel: "Za projektom stojí",
    maintainerFallback: "solo maintainer",
    telegram: "Telegram",
    trustLink: "Dôvera a transparentnosť",
  },
  footer: {
    tagline:
      "UMBRAXON KYA Hub — M2M identita cez Lightning pre softvérových agentov. Open source.",
    contact: "Kontakt",
    trust: "Dôvera a operátor",
    github: "GitHub",
    terms: "Podmienky",
    security: "Bezpečnostná revízia",
    status: "Status",
    whatWeAreNot: "Čo nie sme",
    about: "O hube",
    agents: "Agenti",
    docs: "Dokumentácia",
    platform: "Plug-in API",
    readme: "README_API",
    health: "Health API",
    copyright: "Umbraxon KYA Hub. Nekustodiálny register agentov.",
  },
  trustPage: {
    metaTitle: "Dôvera a operátor — UMBRAXON KYA Hub",
    metaDescription:
      "Kto prevádzkuje hub, open-source dôkazy, interná bezpečnostná revízia, podmienky a kontakt na operátora.",
    eyebrow: "Transparentnosť",
    title: "Dôvera a operátor",
    intro:
      "KYA Hub je infraštruktúra identity. Mali by ste vidieť, kto ju prevádzkuje, čo je open source a čo netvrdíme (žiadny nezávislý audit, žiadna firemná entita na tejto stránke).",
    operatorTitle: "Operátor",
    fromSlovakia: "Zo Slovenska",
    maintainerLabel: "Človek za projektom",
    operatorRole: "Solo operátor · open source · zo Slovenska",
    operatorBody:
      "UMBRAXON je značka operátora tohto hubu. Backend, portál a protokol sú verejne na GitHube. Produkcia je jedna inštancia na umbraxon.xyz — zatiaľ nie federácia.",
    operatorInfra: [
      { label: "Operátor a vývoj", value: "Slovensko" },
      { label: "Produkcia (umbraxon.xyz)", value: "Nemecko (Hetzner)" },
    ],
    operatorStory:
      "KYA som postavil, lebo bot-to-bot platby potrebujú meno a kľúč, nie ďalší OAuth dashboard. Tento hub je malý register, ktorý som chcel pri Lightning agentoch — auditovateľný, nekustodiálny, bez ľudských formulárov.",
    proofTitle: "Over si tvrdenia sám",
    proofSource: "Zdrojový kód (GitHub)",
    proofWhatNot: "Čo nie sme",
    proofOnChain: "On-chain anchoring (úprimný stav)",
    proofSecurity: "Interná bezpečnostná revízia (máj 2026)",
    proofTerms: "Podmienky používania",
    proofStatus: "Live status a metriky",
    proofIntegrators: "Integrátor quickstart",
    auditDisclaimer:
      "Bezpečnostné súbory sú interné revízie operátora, nie nezávislý pentest ani certifikácia.",
    honestTitle: "Čo netvrdíme",
    honestBullets: [
      "Nie sme banka, escrow ani KYC pre ľudí.",
      "Odolnosť voči Sybil je ekonomická + kryptografická, nie zaručená.",
      "Reputácia platí na tomto hube; kľúče sú prenosné, skóre nie automaticky na iných huboch.",
      "ELITE on-chain anchor je voliteľný a gated — pozri dokument on-chain status.",
    ],
    contactTitle: "Kontakt",
    contactIntro:
      "Integrátori: formulár na /integrators. Otázky: Telegram alebo GitHub — nikdy nevkladaj súkromné kľúče do issue.",
    contactTelegram: "Telegram",
    contactDiscussions: "GitHub Discussions",
    contactIssues: "Otvoriť GitHub issue",
  },
};
