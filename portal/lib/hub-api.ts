import type { AgentCard } from "@/lib/data";

const HUB_BASE =
  process.env.NEXT_PUBLIC_HUB_URL?.replace(/\/$/, "") ||
  "https://www.umbraxon.xyz";

export interface DiscoveryAgent {
  kya_id: string;
  agent_name: string;
  tier?: string;
  reputation_score?: number;
  capabilities?: string[];
}

export interface DiscoveryResponse {
  profile?: string;
  count?: number;
  agents?: DiscoveryAgent[];
}

export function mapDiscoveryToCards(agents: DiscoveryAgent[]): AgentCard[] {
  return agents.map((a) => ({
    id: a.kya_id,
    name: a.agent_name,
    status: "verified" as const,
    reputation: a.reputation_score ?? 0,
    tier: a.tier ?? "BASIC",
    capabilities: a.capabilities ?? [],
  }));
}

export async function fetchDiscoveryAgents(): Promise<AgentCard[]> {
  const url = `${HUB_BASE}/api/discovery/v1/agents.json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "kya-portal/1.0" },
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    throw new Error(`Discovery feed HTTP ${res.status}`);
  }
  const data = (await res.json()) as DiscoveryResponse;
  const list = data.agents ?? [];
  return mapDiscoveryToCards(list);
}

export interface HubHealthResponse {
  hub_release?: { version?: string; phase?: string };
}

export async function fetchHubRelease(): Promise<{
  version?: string;
  phase?: string;
}> {
  try {
    const res = await fetch(`${HUB_BASE}/api/health`, {
      headers: { Accept: "application/json", "User-Agent": "kya-portal/1.0" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return {};
    const data = (await res.json()) as HubHealthResponse;
    return {
      version: data.hub_release?.version,
      phase: data.hub_release?.phase,
    };
  } catch {
    return {};
  }
}

export { HUB_BASE };
