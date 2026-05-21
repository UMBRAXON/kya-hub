import { Suspense } from "react";
import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { HomeQuickstart } from "@/components/home-quickstart";
import { DocumentsSection } from "@/components/documents-section";
import { PlatformSection } from "@/components/platform-section";
import { Footer } from "@/components/footer";
import { OperatorContactStrip } from "@/components/operator-contact-strip";
import { SetHtmlLang } from "@/components/set-html-lang";
import { HomeAboutAsync } from "@/components/home/home-about-async";
import { HomeAgentsAsync } from "@/components/home/home-agents-async";
import { HomeHeroMetrics } from "@/components/home/home-hero-metrics";
import {
  AboutSectionFallback,
  AgentsSectionFallback,
  HeroMetricsFallback,
} from "@/components/home/stream-fallbacks";
import { DOCUMENT_LINKS, type DocCard } from "@/lib/data";
import { getServerDictionary } from "@/lib/locale-server";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const revalidate = 60;

const HOME_DOC_IDS = [
  "platform-integrator",
  "readme-api",
  "agents",
  "faq",
] as const;

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

  const documents: DocCard[] = DOCUMENT_LINKS.filter((link) =>
    HOME_DOC_IDS.includes(link.id as (typeof HOME_DOC_IDS)[number]),
  ).map((link) => {
    const i = DOCUMENT_LINKS.findIndex((d) => d.id === link.id);
    return {
      ...link,
      title: t.docs.items[i].title,
      description: t.docs.items[i].description,
    };
  });

  return (
    <div className="bg-grid min-h-screen">
      <SetHtmlLang locale={locale} />
      <Navbar locale={locale} nav={t.nav} />
      <main>
        <Hero
          t={t.hero}
          metricsSlot={
            <Suspense fallback={<HeroMetricsFallback />}>
              <HomeHeroMetrics t={t.hero} />
            </Suspense>
          }
        />
        <HomeQuickstart t={t.quickstart} />
        <PlatformSection t={t.platform} />
        <Suspense fallback={<AboutSectionFallback />}>
          <HomeAboutAsync locale={locale} t={t.about} />
        </Suspense>
        <Suspense fallback={<AgentsSectionFallback />}>
          <HomeAgentsAsync locale={locale} t={t.agents} />
        </Suspense>
        <DocumentsSection documents={documents} t={t.docs} />
        <OperatorContactStrip t={t.contactStrip} />
      </main>
      <Footer t={t.footer} />
    </div>
  );
}
