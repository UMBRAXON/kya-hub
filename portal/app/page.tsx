import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { AboutSection } from "@/components/about-section";
import { AgentsSection } from "@/components/agents-section";
import { DocumentsSection } from "@/components/documents-section";
import { PlatformSection } from "@/components/platform-section";
import { PromoVideo } from "@/components/promo-video";
import { Footer } from "@/components/footer";
import { SetHtmlLang } from "@/components/set-html-lang";
import {
  fetchDiscoveryAgents,
  fetchHubRelease,
  fetchTiers,
  HUB_BASE,
} from "@/lib/hub-api";
import { DOCUMENT_LINKS, type DocCard } from "@/lib/data";
import { getServerDictionary } from "@/lib/locale-server";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return buildPageMetadata({
    title: t.meta.title,
    description: t.meta.description,
    path: "/",
  });
}

export default async function Home() {
  const { locale, t } = await getServerDictionary();

  let agents: Awaited<ReturnType<typeof fetchDiscoveryAgents>> = [];
  let fetchError: string | null = null;
  try {
    agents = await fetchDiscoveryAgents();
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "fetch failed";
  }

  const [{ version: hubVersion, phase: hubPhase }, tiers] = await Promise.all([
    fetchHubRelease(),
    fetchTiers(),
  ]);

  const fetchedAt = new Date().toLocaleString(locale === "sk" ? "sk-SK" : "en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  const documents: DocCard[] = DOCUMENT_LINKS.map((link, i) => ({
    ...link,
    title: t.docs.items[i].title,
    description: t.docs.items[i].description,
  }));

  return (
    <div className="bg-grid min-h-screen">
      <SetHtmlLang locale={locale} />
      <Navbar locale={locale} nav={t.nav} />
      <main>
        <Hero t={t.hero} />
        <PromoVideo t={t.promoVideo} />
        <PlatformSection t={t.platform} />
        <AboutSection
          locale={locale}
          t={t.about}
          hubVersion={hubVersion}
          hubPhase={hubPhase}
          tiers={tiers}
        />
        <AgentsSection
          agents={agents}
          hubBaseUrl={HUB_BASE}
          fetchedAt={`${fetchedAt} UTC`}
          error={fetchError}
          t={t.agents}
        />
        <DocumentsSection documents={documents} t={t.docs} />
      </main>
      <Footer t={t.footer} />
    </div>
  );
}
