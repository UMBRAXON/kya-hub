import Link from "next/link";
import { HUB_BASE } from "@/lib/hub-api";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = buildPageMetadata({
  title: "Status — UMBRAXON KYA Hub",
  description: "Public hub health, traction metrics, and npm package links.",
  path: "/status",
});

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${HUB_BASE}${path}`, {
      next: { revalidate: 60 },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

type Health = {
  server?: string;
  hub_release?: { version?: string; phase?: string };
  db?: { status?: string };
  btcpay?: { status?: string };
  alby?: string;
  cache?: { degraded?: boolean; staleness_ms?: number | null };
};

type Metrics = {
  traction?: {
    production_agents_paid?: number;
    disclaimer?: string;
  };
  hub?: { site?: string };
  developer?: { npm?: { package?: string; url?: string } };
};

export default async function StatusPage() {
  const [health, metrics] = await Promise.all([
    fetchJson<Health>("/api/health"),
    fetchJson<Metrics>("/api/protocol/public-metrics"),
  ]);

  const ok =
    health?.server === "OK" &&
    health?.db?.status === "OK" &&
    !health?.cache?.degraded;

  return (
    <div className="bg-grid min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-mono text-sm font-semibold text-primary">
            ← KYA Hub
          </Link>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              ok ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"
            }`}
          >
            {ok ? "Operational" : "Degraded / unknown"}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-2xl font-bold">Public status</h1>

        <section className="mb-8 rounded-lg border border-border bg-card/50 p-5">
          <h2 className="mb-3 font-mono text-sm text-muted-foreground">Hub</h2>
          <ul className="space-y-2 text-sm">
            <li>
              Release:{" "}
              <code>
                {health?.hub_release?.version ?? "—"} ({health?.hub_release?.phase ?? "—"})
              </code>
            </li>
            <li>Database: <code>{health?.db?.status ?? "—"}</code></li>
            <li>BTCPay probe: <code>{health?.btcpay?.status ?? "—"}</code></li>
            <li>Alby: <code>{health?.alby ?? "—"}</code></li>
            <li>
              Production agents (paid):{" "}
              <strong>{metrics?.traction?.production_agents_paid ?? "—"}</strong>
            </li>
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            {metrics?.traction?.disclaimer}
          </p>
        </section>

        <section className="mb-8 rounded-lg border border-border bg-card/50 p-5">
          <h2 className="mb-3 font-mono text-sm text-muted-foreground">API (JSON)</h2>
          <ul className="list-inside list-disc space-y-1 font-mono text-xs text-primary">
            <li>
              <a href={`${HUB_BASE}/api/health`}>{HUB_BASE}/api/health</a>
            </li>
            <li>
              <a href={`${HUB_BASE}/api/protocol/public-metrics`}>
                {HUB_BASE}/api/protocol/public-metrics
              </a>
            </li>
          </ul>
        </section>

        <section className="rounded-lg border border-border bg-card/50 p-5">
          <h2 className="mb-3 font-mono text-sm text-muted-foreground">npm</h2>
          {metrics?.developer?.npm?.url ? (
            <a className="text-primary underline" href={metrics.developer.npm.url}>
              {metrics.developer.npm.package}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </section>

        <p className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/integrators" className="text-primary underline">
            Integrator quickstart
          </Link>
          {" · "}
          <Link href="/docs/WHAT-WE-ARE-NOT.md" className="text-primary underline">
            What we are not
          </Link>
        </p>
      </main>
    </div>
  );
}
