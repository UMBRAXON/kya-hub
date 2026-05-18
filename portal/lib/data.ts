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

/** Production agents shown when the public discovery feed is empty. */
export const SHOWCASE_AGENTS: AgentCard[] = [
  {
    id: "UMBRA-000467",
    name: "UMBRAXON-PR-AMBASSADOR",
    status: "verified",
    reputation: 500,
    tier: "BASIC",
    capabilities: ["btc_payments", "pr_marketing", "discovery"],
  },
  {
    id: "UMBRA-000468",
    name: "KYA-DEMO-SHOWCASE",
    status: "verified",
    reputation: 500,
    tier: "BASIC",
    capabilities: ["btc_payments", "discovery"],
  },
];

/** Hrefs/types only — titles and descriptions come from i18n. */
export const DOCUMENT_LINKS: Pick<DocCard, "id" | "href" | "type">[] = [
  {
    id: "platform-integrator",
    href: "/docs/FAQ-FOR-BOT-DEVELOPERS.md#i-platform-integrator-plug-in--third-party-systems",
    type: "guide",
  },
  { id: "readme-api", href: "/README_API.md", type: "api" },
  { id: "agents", href: "/AGENTS.md", type: "guide" },
  { id: "faq", href: "/docs/FAQ-FOR-BOT-DEVELOPERS.md", type: "guide" },
  { id: "openapi", href: "/openapi/openapi.yaml", type: "api" },
  { id: "protocol", href: "/api/protocol/reputation-model", type: "api" },
  {
    id: "client",
    href: "https://github.com/UMBRAXON/kya-hub/blob/main/scripts/umbrexon_bot_client.py",
    type: "api",
  },
];
