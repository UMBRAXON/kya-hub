import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { AboutSection } from "@/components/about-section";
import { AgentsSection } from "@/components/agents-section";
import { DocumentsSection } from "@/components/documents-section";
import { Footer } from "@/components/footer";
import {
  fetchDiscoveryAgents,
  fetchHubRelease,
  HUB_BASE,
} from "@/lib/hub-api";

export const revalidate = 60;

export default async function Home() {
  let agents: Awaited<ReturnType<typeof fetchDiscoveryAgents>> = [];
  let fetchError: string | null = null;
  try {
    agents = await fetchDiscoveryAgents();
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "fetch failed";
  }

  const { version: hubVersion, phase: hubPhase } = await fetchHubRelease();

  const fetchedAt = new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="bg-grid min-h-screen">
      <Navbar />
      <main>
        <Hero />
        <AboutSection hubVersion={hubVersion} hubPhase={hubPhase} />
        <AgentsSection
          agents={agents}
          hubBaseUrl={HUB_BASE}
          fetchedAt={`${fetchedAt} UTC`}
          error={fetchError}
        />
        <DocumentsSection />
      </main>
      <Footer />
    </div>
  );
}
