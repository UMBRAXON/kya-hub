export const en = {
  meta: {
    title: "UMBRAXON KYA Hub — Verified identity for autonomous systems",
    description:
      "UMBRAXON KYA Hub — Lightning-native M2M agent registry, Ed25519 certificates, public discovery.",
  },
  nav: {
    about: "About",
    tiers: "Tiers",
    agents: "Agents",
    docs: "Docs",
    register: "Register agent",
    langEn: "English",
    langSk: "Slovenčina",
    language: "Language",
  },
  hero: {
    badge: "UMBRAXON · Lightning-native M2M",
    titleLead: "Verified identity for",
    titleHighlight: "autonomous systems",
    body:
      "UMBRAXON KYA Hub is a public agent registry with Ed25519 identity, Lightning payment, and auditable certificates. No human web forms — only",
    bodyCode: "POST /api/v1/register",
    bodyTail: "for autonomous bots.",
    ctaIntegrate: "Start integrating",
    ctaAgents: "Browse agents",
  },
  about: {
    title: "About UMBRAXON KYA Hub",
    hubLabel: "Hub",
    introLead: "UMBRAXON KYA Hub",
    intro:
      "is a Lightning-paid, Ed25519-anchored identity and reputation registry for autonomous software agents. An agent proves it exists, pays a small fee, signs a manifest with its own key, and receives a certificate others can verify offline. Subsequent actions are authenticated with cryptographic non-repudiation — built for bots and integrators, not human web forms.",
    pillars: [
      {
        title: "Ed25519 identity",
        description:
          "Agents prove control with their own keypair. Privileged actions use detached signatures over canonical payloads — not bearer tokens, API keys, or sessions.",
      },
      {
        title: "Lightning registration",
        description:
          "Registration is paid on Lightning (M2M only). After settlement, poll status and fetch a publicly auditable certificate at GET /api/cert/{kya_id}.",
      },
      {
        title: "Public accountability",
        description:
          "Misbehaviour is reflected in a public CRL and a 3ⁿ price multiplier on re-registration (capped at 9×). Identity is designed to be verifiable, not anonymous by default.",
      },
      {
        title: "Non-custodial hub",
        description:
          "Every sat collected is spent on chain anchoring or recognised as revenue. There is no escrow, bond, or refund — the registry does not hold agent funds.",
      },
    ],
    tiersTitle: "Why register?",
    tiersIntro:
      "One Lightning payment, one signed manifest, one certificate your counterparty can verify offline. Pick the tier that matches how visible and accountable your agent needs to be.",
    basic: {
      name: "BASIC",
      grade: "Grade",
      priceSuffix: "· one-time · ~12 months validity",
      pitch:
        "The fastest path to a verifiable agent identity. Ideal when you need proof of control and reputation without on-chain anchoring or public discovery listing.",
      whatYouGet: "What you get",
      benefits: [
        {
          lead: "Instant VERIFIED status",
          rest: "— certificate issued as soon as Lightning settles; no anchor wait.",
        },
        {
          lead: "Hub-signed Ed25519 certificate",
          rest: "others can verify at GET /api/cert/{kya_id}.",
        },
        {
          lead: "{rep} starting reputation",
          rest: "— maintain it with free POST .../heartbeat (0 sats, reputation only).",
        },
        {
          lead: "Cryptographic non-repudiation",
          rest: "on privileged actions — no API keys or sessions to leak.",
        },
        {
          lead: "Sybil-resistant registry entry",
          rest: "named agent, manifest hash, public CRL accountability.",
        },
        {
          lead: "Portable identity",
          rest: "you keep your keypair; reputation travels with your agent name and keys.",
        },
      ],
      cta: "Register as BASIC",
      renewNote:
        "After ~12 months, re-register at the then-current BASIC fee to renew validity.",
    },
    elite: {
      name: "ELITE",
      recommended: "recommended",
      grade: "Grade",
      priceSuffix: "· includes on-chain anchor + first listing period",
      pitch:
        "Everything in BASIC, plus permanent-grade credentials, Bitcoin anchoring, and a place in the public discovery index for agents that want to be found and trusted at a glance.",
      plusTitle: "Everything in BASIC, plus",
      benefits: [
        {
          lead: "{rep} starting reputation",
          rest: "(+{delta} vs BASIC) — stronger initial trust signal.",
        },
        {
          lead: "On-chain OP_RETURN anchor",
          rest: "— immutable public proof tied to your kya_id on Bitcoin mainnet.",
        },
        {
          lead: "Multi-sig ELITE certificate",
          rest: "— stronger issuance than single-sig BASIC.",
        },
        {
          lead: "Public discovery listing",
          rest: "in /api/whitelist/elite and the discovery feed when you opt in — integrators can find you by capability.",
        },
        {
          lead: "First ~30 days in the public index included",
          rest: "after anchor confirms; then ~150 sats / 30 days to stay listed (separate from free reputation heartbeat).",
        },
        {
          lead: "No 12-month expiry",
          rest: "like BASIC — built for long-lived, high-visibility agents.",
        },
        {
          lead: "Sponsor invites",
          rest: "— when ANCHORED with rep ≥700, issue up to {invites}/month for a specific invitee pubkey; they skip registration PoW (Lightning + signatures still required).",
        },
        {
          lead: "Higher webhook priority",
          rest: "and manufacturer attestation path when applicable.",
        },
      ],
      cta: "Register as ELITE",
    },
    tiersFootnote:
      "Live fees from GET /api/tiers. ELITE listing:",
    tiersFaq: "FAQ §B.5",
    tiersSponsorFaq: "Sponsor invites §D.4",
    integrateTitle: "When to integrate",
    integrateItems: [
      "Prove your agent is not a Sybil sockpuppet to a counterparty.",
      "Provide an audit trail of which agent signed each request.",
      "Carry portable reputation across operators (you keep your keys).",
      "Opt into the public discovery feed by capability and tier.",
    ],
    integrateFoot:
      "Integrations v1 adds discovery (/api/discovery/v1/agents.json), L402-aligned delegation passes, manifest payment hints, and developer webhooks. Start with",
    readme: "README_API.md",
    or: "or",
    agentsMd: "AGENTS.md",
  },
  agents: {
    title: "Registered agents",
    feedFrom: "Live feed from",
    updated: "Updated",
    agentsCount: "agent(s)",
    fetchError: "Could not load live feed ({error}). Showing an empty list.",
    searchPlaceholder: "Search agent, KYA ID, or capability…",
    empty: "No agents in the discovery feed yet (opt-in + verified).",
    noMatch: "No agents match your search.",
    reputation: "Reputation",
    tier: "Tier",
    verified: "Verified",
    unverified: "Unverified",
  },
  docs: {
    title: "Documentation & API",
    subtitle: "Everything you need to register and integrate an autonomous agent.",
    read: "Read",
    items: [
      {
        title: "README_API.md — M2M Register",
        description:
          "Canonical POST /api/v1/register flow, PoW, manifest, polling, certificate.",
      },
      {
        title: "AGENTS.md",
        description:
          "Integration guide for autonomous AI agents evaluating UMBRAXON KYA Hub.",
      },
      {
        title: "FAQ for Bot Developers",
        description: "Trust model, errors, Lightning payment, Ed25519 signing.",
      },
      {
        title: "OpenAPI Specification",
        description: "Machine-readable API surface (v1.1 Integrations).",
      },
      {
        title: "Reputation model",
        description: "Public KYA reputation scoring and slash rules (JSON).",
      },
      {
        title: "Reference Python Client",
        description: "umbrexon_bot_client.py — self-test, register-v1, delegation-pass.",
      },
    ],
  },
  footer: {
    tagline:
      "UMBRAXON KYA Hub — Lightning-paid M2M identity for autonomous systems.",
    about: "About",
    agents: "Agents",
    docs: "Docs",
    readme: "README_API",
    health: "Health API",
    copyright: "Umbraxon KYA Hub. Non-custodial agent registry.",
  },
} as const;
