import { OPERATOR_LOCATION } from "@/lib/operator";

export const en = {
  meta: {
    title: "UMBRAXON KYA Hub — Know Your Agent registry (Lightning + Ed25519)",
    description:
      "Public bot registry: Ed25519 identity, Lightning registration, integrator status API. Open source on GitHub.",
  },
  nav: {
    trust: "Trust",
    contact: "Contact",
    about: "About",
    tiers: "Tiers",
    agents: "Agents",
    video: "Intro",
    integrators: "Quickstart",
    platform: "Plug-in API",
    docs: "Docs",
    register: "Register agent",
    registerShort: "Register",
    langEn: "English",
    langSk: "Slovenčina",
    language: "Language",
  },
  hero: {
    badge: "UMBRAXON · Lightning M2M",
    titleLead: "Know Your Agent —",
    titleHighlight: "bot registry",
    body:
      "Register software agents with Ed25519 keys and a Lightning fee. Counterparties verify with one GET before payment. No human web forms — only",
    bodyCode: "POST /api/v1/register",
    bodyTail: "for bots and integrators.",
    ctaIntegrate: "Integrate in 5 min",
    ctaRegister: "Register a bot",
    ctaVideo: "75s intro",
    videoHref: "https://www.youtube.com/watch?v=Z6Fb2LFBPtY",
  },
  quickstart: {
    eyebrow: "Quick path",
    title: "Integrate or register",
    fullGuide: "Integrator quickstart",
    steps: [
      {
        title: "Verify before pay",
        body: "One GET on /api/v1/agents/{kya_id}/status — snapshot or cert_proof.",
      },
      {
        title: "Register with keys",
        body: "POST /api/v1/register — Ed25519 manifest, Lightning fee, public certificate.",
      },
      {
        title: "Ship in your stack",
        body: "LNBits plugin, npm @umbraxon_kya/kya-verify, or the Python reference client.",
      },
    ],
    code:
      'curl -sS "https://www.umbraxon.xyz/api/v1/agents/UMBRA-000467/status"',
  },
  promoVideo: {
    eyebrow: "75-second intro",
    title: "Why bots need a verifiable identity before payment",
    subtitle:
      "One HTTP check before you allow payment or action. Low risk: hub snapshot. High risk: verify the certificate signature.",
    iframeTitle: "UMBRAXON KYA Hub — Know Your Agent intro",
    watchOnYoutube: "Watch on YouTube",
  },
  platform: {
    badge: "New · Platform Integrator API",
    title: "Verify KYA agents inside your product",
    body:
      "Check KYA status inside LNBits, a marketplace, or your app — without running a hub. Agents use Ed25519; your product only calls the public read API.",
    bullets: [
      "GET /api/v1/agents/{kya_id}/status — fast snapshot (~60s cache)",
      "?include=cert_proof — cryptographic proof for larger actions",
      "umb_live_… keys are platform billing/rate limits, not agent identity",
      "Webhooks + Python SDK · agent registration stays Ed25519 + Lightning",
    ],
    codeLabel: "Plug-in gate (example)",
    codeSample: `GET /api/v1/agents/UMBRA-000467/status
→ { "verified": true, "trust_level": "TRUSTED" }

# higher-value actions:
GET .../status?include=cert_proof

Authorization: Bearer umb_live_…  (platform rate limit, not agent identity)`,
    codeFoot: "Guide: docs/INTEGRATOR-TRUST-GATE.md (status check) · FAQ §I · plugin-gate-strict.js",
    ctaPrimary: "Platform integrator docs",
    ctaSecondary: "OpenAPI",
    primaryHref: "/integrators",
    secondaryHref: "/openapi/openapi.yaml",
  },
  about: {
    title: "About UMBRAXON KYA Hub",
    hubLabel: "Hub",
    introLead: "UMBRAXON KYA Hub",
    intro:
      "is a Lightning-paid, Ed25519-anchored identity and reputation registry for software agents and bots. An agent proves it exists, pays a small fee, signs a manifest with its own key, and receives a certificate others can verify offline. Privileged actions use Ed25519 signatures — built for bots and integrators, not human web forms.",
    pillars: [
      {
        title: "Ed25519 identity (agent)",
        description:
          "Bots sign privileged actions with their own key. Platform umb_live_ keys are read-API rate limits only — they do not replace agent identity.",
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
          lead: "You keep your keys",
          rest: "reputation is recorded on this hub under your agent name and pubkey.",
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
      "Build reputation on this hub (you keep your Ed25519 keys).",
      "Opt into the public discovery feed by capability and tier.",
    ],
    integrateFoot:
      "Integrations v1 adds discovery, L402 delegation passes, and developer webhooks. **Platform Integrator API** (plug-in layer) adds GET /api/v1/agents/{id} for third-party products — see",
    platformLink: "Plug-in API",
    platformHref: "#platform",
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
    empty: "No agents in the public discovery feed yet.",
    showcaseNote:
      "Showing live production agents you can query now. Full discovery feed fills as more ELITE agents opt in.",
    noMatch: "No agents match your search.",
    reputation: "Reputation",
    tier: "Tier",
    verified: "Verified",
    unverified: "Unverified",
  },
  docs: {
    title: "Documentation & API",
    subtitle: "Everything you need to register and integrate a bot or agent.",
    read: "Read",
    viewAll: "All documentation",
    items: [
      {
        title: "Platform Integrator API (plug-ins)",
        description:
          "Status gate, cert_proof, webhooks, umbraxon-py. umb_live_ = platform rate limits, not bot identity. FAQ §I.",
      },
      {
        title: "README_API.md — M2M Register",
        description:
          "Canonical POST /api/v1/register flow, PoW, manifest, polling, certificate.",
      },
      {
        title: "AGENTS.md",
        description:
          "Integration guide for AI agents and bot developers evaluating UMBRAXON KYA Hub.",
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
  contactStrip: {
    builtInEu: OPERATOR_LOCATION.badge.en,
    title: "Contact the operator",
    body:
      "Integrators, security questions, or partnership — Telegram or GitHub. No ticket queue.",
    operatorStory:
      "I built KYA because bot-to-bot flows need a name and a key, not another OAuth screen. This hub is the small registry I wanted when wiring Lightning agents — auditable, non-custodial, no human signup forms.",
    maintainerLabel: "Maintained by",
    maintainerFallback: "solo maintainer",
    telegram: "Telegram",
    trustLink: "Trust & transparency",
  },
  footer: {
    tagline:
      "UMBRAXON KYA Hub — Lightning-paid M2M identity for software agents. Open source.",
    contact: "Contact",
    trust: "Trust & operator",
    github: "GitHub",
    terms: "Terms",
    security: "Security review",
    status: "Status",
    whatWeAreNot: "What we are not",
    about: "About hub",
    agents: "Agents",
    docs: "Docs",
    platform: "Plug-in API",
    readme: "README_API",
    health: "Health API",
    copyright: "Umbraxon KYA Hub. Non-custodial agent registry.",
  },
  trustPage: {
    metaTitle: "Trust & operator — UMBRAXON KYA Hub",
    metaDescription:
      "Who runs the hub, open-source proof, internal security review, terms, and how to contact the operator.",
    eyebrow: "Transparency",
    title: "Trust & operator",
    intro:
      "KYA Hub is identity infrastructure. You should see who operates it, what is open source, and what we do not claim (no third-party audit, no corporate entity on this page).",
    operatorTitle: "Operator",
    builtInEu: OPERATOR_LOCATION.badge.en,
    maintainerLabel: "Person behind the project",
    operatorRole: OPERATOR_LOCATION.role.en,
    operatorBody:
      "UMBRAXON is the operator brand behind this hub. The backend, portal, and protocol docs are public on GitHub. Production is a single hub instance at umbraxon.xyz — not a federation yet.",
    operatorStory:
      "I built KYA because bot-to-bot flows need a name and a key, not another OAuth screen. This hub is the small registry I wanted when wiring Lightning agents — auditable, non-custodial, no human signup forms.",
    proofTitle: "Verify claims yourself",
    proofSource: "Source code (GitHub)",
    proofWhatNot: "What we are not",
    proofOnChain: "On-chain anchoring (honest status)",
    proofSecurity: "Internal security review (May 2026)",
    proofTerms: "Terms of use",
    proofStatus: "Live status & traction metrics",
    proofIntegrators: "Integrator quickstart",
    auditDisclaimer:
      "Security files are operator-led reviews, not an independent penetration test or certification.",
    honestTitle: "What we do not claim",
    honestBullets: [
      "Not a bank, escrow, or KYC provider for humans.",
      "Sybil resistance is economic + cryptographic, not guaranteed.",
      "Reputation scores apply on this hub; keys are portable, scores are not automatically portable to other hubs.",
      "ELITE on-chain anchor is optional and gated — see on-chain status doc.",
    ],
    contactTitle: "Contact",
    contactIntro:
      "Integrators: form on /integrators. Questions: Telegram or GitHub — never post private keys in issues.",
    contactTelegram: "Telegram",
    contactDiscussions: "GitHub Discussions",
    contactIssues: "Open a GitHub issue",
  },
} as const;
