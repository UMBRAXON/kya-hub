import Link from "next/link";
import { fetchPublicMetrics } from "@/lib/hub-api";
import type { Dictionary } from "@/lib/i18n";

export async function HomeHeroMetrics({ t }: { t: Dictionary["hero"] }) {
  const publicMetrics = await fetchPublicMetrics();
  const traction = publicMetrics?.traction;
  if (!traction) return null;

  const paid = traction.production_agents_paid ?? 0;
  const calls = traction.integrator_verify_7d?.calls ?? 0;
  const metricsLine = t.metricsLine
    .replace("{paid}", String(paid))
    .replace("{calls}", String(calls));

  return (
    <p className="mt-6 text-sm text-muted-foreground">
      {metricsLine}{" "}
      <Link href="/status" className="text-primary underline underline-offset-2">
        {t.metricsLink}
      </Link>
    </p>
  );
}
