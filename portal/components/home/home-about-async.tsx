import { AboutSection } from "@/components/about-section";
import { fetchHubRelease, fetchTiers } from "@/lib/hub-api";
import type { Dictionary, Locale } from "@/lib/i18n";

export async function HomeAboutAsync({
  locale,
  t,
}: {
  locale: Locale;
  t: Dictionary["about"];
}) {
  const [{ version: hubVersion, phase: hubPhase }, tiers] = await Promise.all([
    fetchHubRelease(),
    fetchTiers(),
  ]);

  return (
    <AboutSection
      locale={locale}
      t={t}
      hubVersion={hubVersion}
      hubPhase={hubPhase}
      tiers={tiers}
    />
  );
}
