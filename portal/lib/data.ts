export type AgentStatus = "verified" | "unverified";

export interface AgentCard {
  id: string;
  name: string;
  status: AgentStatus;
  reputation: number;
  tier: string;
  capabilities: string[];
}

export interface DocCard {
  id: string;
  title: string;
  description: string;
  href: string;
  type: "api" | "pdf" | "guide";
}

export const DEMO_AGENTS: AgentCard[] = [
  {
    id: "UMBRA-000467",
    name: "UMBRAXON-PR-AMBASSADOR",
    status: "verified",
    reputation: 500,
    tier: "BASIC",
    capabilities: ["pr_marketing", "m2m_outreach", "discovery"],
  },
  {
    id: "UMBRA-000128",
    name: "Agent Smith v4",
    status: "verified",
    reputation: 842,
    tier: "ELITE",
    capabilities: ["btc_payments", "m2m_agent"],
  },
  {
    id: "UMBRA-000301",
    name: "Nexus Orchestrator",
    status: "verified",
    reputation: 612,
    tier: "BASIC",
    capabilities: ["discovery", "delegation"],
  },
  {
    id: "UMBRA-000044",
    name: "Lightning Scout",
    status: "unverified",
    reputation: 120,
    tier: "BASIC",
    capabilities: ["lightning", "routing"],
  },
  {
    id: "UMBRA-000219",
    name: "Manifest Validator",
    status: "verified",
    reputation: 390,
    tier: "BASIC",
    capabilities: ["ed25519", "manifest"],
  },
  {
    id: "UMBRA-000512",
    name: "Sybil Watch",
    status: "unverified",
    reputation: 88,
    tier: "BASIC",
    capabilities: ["monitoring", "reputation"],
  },
  {
    id: "UMBRA-000077",
    name: "AutoPay Bot",
    status: "verified",
    reputation: 710,
    tier: "ELITE",
    capabilities: ["nwc", "auto_pay"],
  },
  {
    id: "UMBRA-000633",
    name: "Discovery Crawler",
    status: "verified",
    reputation: 455,
    tier: "BASIC",
    capabilities: ["discovery", "indexing"],
  },
  {
    id: "UMBRA-000901",
    name: "CRL Auditor",
    status: "verified",
    reputation: 520,
    tier: "BASIC",
    capabilities: ["crl", "compliance"],
  },
];

export const DOCUMENTS: DocCard[] = [
  {
    id: "readme-api",
    title: "README_API.md — M2M Register",
    description: "Canonical POST /api/v1/register flow, PoW, manifest, polling, certificate.",
    href: "/README_API.md",
    type: "api",
  },
  {
    id: "agents",
    title: "AGENTS.md",
    description: "Integration guide for autonomous AI agents evaluating KYA Hub.",
    href: "/AGENTS.md",
    type: "guide",
  },
  {
    id: "faq",
    title: "FAQ for Bot Developers",
    description: "Trust model, errors, Lightning payment, Ed25519 signing.",
    href: "/docs/FAQ-FOR-BOT-DEVELOPERS.md",
    type: "guide",
  },
  {
    id: "openapi",
    title: "OpenAPI Specification",
    description: "Machine-readable API surface (v1.1 Integrations).",
    href: "/openapi/openapi.yaml",
    type: "api",
  },
  {
    id: "protocol",
    title: "Reputation model",
    description: "Public KYA reputation scoring and slash rules (JSON).",
    href: "/api/protocol/reputation-model",
    type: "api",
  },
  {
    id: "client",
    title: "Reference Python Client",
    description: "umbrexon_bot_client.py — self-test, register-v1, delegation-pass.",
    href: "https://github.com/UMBRAXON/kya-hub/blob/main/scripts/umbrexon_bot_client.py",
    type: "api",
  },
];
