import { AgentsSection } from "@/components/agents-section";
import { fetchDiscoveryAgents, HUB_BASE } from "@/lib/hub-api";
import { SHOWCASE_AGENTS } from "@/lib/data";
import type { Dictionary, Locale } from "@/lib/i18n";

export async function HomeAgentsAsync({
  locale,
  t,
}: {
  locale: Locale;
  t: Dictionary["agents"];
}) {
  let agents: Awaited<ReturnType<typeof fetchDiscoveryAgents>> = [];
  let fetchError: string | null = null;
  try {
    agents = await fetchDiscoveryAgents();
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "fetch failed";
  }

  const showcaseMode = agents.length === 0 && !fetchError;
  const displayAgents = showcaseMode ? SHOWCASE_AGENTS : agents;

  const fetchedAt = new Date().toLocaleString(locale === "sk" ? "sk-SK" : "en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <AgentsSection
      agents={displayAgents}
      hubBaseUrl={HUB_BASE}
      fetchedAt={`${fetchedAt} UTC`}
      error={fetchError}
      showcaseMode={showcaseMode}
      t={t}
    />
  );
}
