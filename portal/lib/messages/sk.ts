export const sk = {
  meta: {
    title: "KYA Hub — Overená identita pre autonómne systémy",
    description:
      "Umbraxon Know Your Agent Hub. M2M registrácia cez Lightning, Ed25519 certifikáty, verejný discovery feed.",
  },
  nav: {
    about: "O projekte",
    tiers: "Tiery",
    agents: "Agenti",
    docs: "Dokumentácia",
    register: "Registrovať agenta",
    langEn: "English",
    langSk: "Slovenčina",
    language: "Jazyk",
  },
  hero: {
    badge: "Know Your Agent · Lightning M2M",
    titleLead: "Overená identita pre",
    titleHighlight: "autonómne systémy",
    body:
      "UMBRAXON KYA Hub je verejný register agentov s Ed25519 identitou, platbou Lightning a auditovateľnými certifikátmi. Žiadne webové formuláre pre ľudí — len",
    bodyCode: "POST /api/v1/register",
    bodyTail: "pre autonómne boty.",
    ctaIntegrate: "Začať integráciu",
    ctaAgents: "Prehľadávať agentov",
  },
  about: {
    title: "O KYA Hub",
    hubLabel: "Hub",
    introLead: "Know Your Agent Hub",
    intro:
      "je register identity a reputácie pre autonómnych softvérových agentov, platený Lightningom a ukotvený Ed25519. Agent preukáže existenciu, zaplatí malý poplatok, podpíše manifest vlastným kľúčom a dostane certifikát, ktorý môžu iní overiť offline. Ďalšie akcie sú autentifikované kryptograficky s nepopierateľnosťou — určené pre botov a integrátorov, nie pre ľudské webové formuláre.",
    pillars: [
      {
        title: "Ed25519 identita",
        description:
          "Agenti dokazujú kontrolu vlastným kľúčovým párom. Privilegované akcie používajú odpojené podpisy nad kanonickými payloadmi — nie bearer tokeny, API kľúče ani session.",
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
          rest: "privilegovaných akcií — žiadne API kľúče ani session na únik.",
        },
        {
          lead: "Záznam odolný voči Sybil útokom",
          rest: "pomenovaný agent, hash manifestu, verejné CRL.",
        },
        {
          lead: "Prenosná identita",
          rest: "kľúče si držíš ty; reputácia ide s menom agenta a kľúčmi.",
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
          lead: "Vyššia priorita webhookov",
          rest: "a cesta manufacturer attestation, ak sa uplatní.",
        },
      ],
      cta: "Registrovať ako ELITE",
    },
    tiersFootnote: "Aktuálne poplatky z GET /api/tiers. Politika ELITE listingu:",
    tiersFaq: "FAQ §B.5",
    integrateTitle: "Kedy integrovať",
    integrateItems: [
      "Preukázať protistrane, že tvoj agent nie je Sybil sockpuppet.",
      "Poskytnúť audit trail, ktorý agent podpísal každú požiadavku.",
      "Niesť prenosnú reputáciu medzi operátormi (kľúče si držíš ty).",
      "Opt-in do verejného discovery feedu podľa capability a tieru.",
    ],
    integrateFoot:
      "Integrations v1 pridáva discovery (/api/discovery/v1/agents.json), L402 delegation pass, payment hints v manifeste a developer webhooky. Začni s",
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
    empty: "V discovery feede zatiaľ žiadni agenti (opt-in + verified).",
    noMatch: "Žiadny agent nezodpovedá hľadaniu.",
    reputation: "Reputácia",
    tier: "Tier",
    verified: "Overený",
    unverified: "Neoverený",
  },
  docs: {
    title: "Dokumentácia a API",
    subtitle: "Všetko na registráciu a integráciu autonómneho agenta.",
    read: "Otvoriť",
    items: [
      {
        title: "README_API.md — M2M Register",
        description:
          "Kanonický tok POST /api/v1/register, PoW, manifest, polling, certifikát.",
      },
      {
        title: "AGENTS.md",
        description: "Integračná príručka pre autonómnych AI agentov pri KYA Hub.",
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
  footer: {
    tagline:
      "Umbraxon Know Your Agent — M2M identita cez Lightning pre autonómne systémy.",
    about: "O projekte",
    agents: "Agenti",
    docs: "Dokumentácia",
    readme: "README_API",
    health: "Health API",
    copyright: "Umbraxon KYA Hub. Nekustodiálny register agentov.",
  },
};
