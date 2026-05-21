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

export interface TierInfo {
  total: number;
  grade: string;
  durationMonths: number | null;
  startingReputation: number;
  requiresAnchor: boolean;
}

export interface TiersResponse {
  BASIC?: TierInfo;
  ELITE?: TierInfo;
}

export async function fetchTiers(): Promise<{
  basic: TierInfo;
  elite: TierInfo;
}> {
  const fallback = {
    basic: {
      total: 10_000,
      grade: "B",
      durationMonths: 12,
      startingReputation: 500,
      requiresAnchor: false,
    },
    elite: {
      total: 80_000,
      grade: "S",
      durationMonths: null,
      startingReputation: 900,
      requiresAnchor: true,
    },
  };
  try {
    const res = await fetch(`${HUB_BASE}/api/tiers`, {
      headers: { Accept: "application/json", "User-Agent": "kya-portal/1.0" },
      next: { revalidate: 300 },
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as TiersResponse;
    return {
      basic: data.BASIC
        ? {
            total: data.BASIC.total,
            grade: data.BASIC.grade,
            durationMonths: data.BASIC.durationMonths ?? 12,
            startingReputation: data.BASIC.startingReputation,
            requiresAnchor: data.BASIC.requiresAnchor ?? false,
          }
        : fallback.basic,
      elite: data.ELITE
        ? {
            total: data.ELITE.total,
            grade: data.ELITE.grade,
            durationMonths: data.ELITE.durationMonths,
            startingReputation: data.ELITE.startingReputation,
            requiresAnchor: data.ELITE.requiresAnchor ?? true,
          }
        : fallback.elite,
    };
  } catch {
    return fallback;
  }
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

export interface IntegratorAgentStatus {
  kya_id: string;
  verified: boolean;
  trust_level: string;
  tier?: string;
  agent_status?: string;
  serial?: string;
  reasons?: string[];
}

/** Plug-in gate — lightweight trust check (Platform API v1). */
export async function fetchIntegratorAgentStatus(
  kyaId: string
): Promise<IntegratorAgentStatus | null> {
  const url = `${HUB_BASE}/api/v1/agents/${encodeURIComponent(kyaId)}/status`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "kya-portal/1.0" },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as IntegratorAgentStatus;
  } catch {
    return null;
  }
}

export interface PublicMetrics {
  updated_at?: string;
  traction?: {
    production_agents_paid?: number;
    disclaimer?: string;
    integrator_verify_7d?: {
      calls?: number;
      verified_ok?: number;
      cert_checks?: number;
    };
  };
  hub?: { version?: string; phase?: string; site?: string };
  developer?: {
    npm?: { package?: string; url?: string };
  };
}

export async function fetchPublicMetrics(): Promise<PublicMetrics | null> {
  try {
    const res = await fetch(`${HUB_BASE}/api/protocol/public-metrics`, {
      headers: { Accept: "application/json", "User-Agent": "kya-portal/1.0" },
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicMetrics;
  } catch {
    return null;
  }
}

export { HUB_BASE };
