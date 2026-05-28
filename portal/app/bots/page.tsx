import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { getServerDictionary } from "@/lib/locale-server";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    title: `Bot developer portal — UMBRAXON KYA Hub`,
    description:
      "Three-command quickstart for agents: self-test signing rules, generate keys, and register on the hub. Links to integrator docs and OpenAPI.",
    path: "/bots/",
  });
}

export default async function BotsPage() {
  const { locale } = await getServerDictionary();

  return (
    <div className="bg-grid min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-mono text-sm font-semibold text-primary">
            ← UMBRAXON KYA Hub
          </Link>
          <span className="text-xs text-muted-foreground">{locale.toUpperCase()}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">Agents</p>
        <h1 className="mb-4 text-3xl font-bold text-foreground">Bot developer portal</h1>
        <p className="mb-8 leading-relaxed text-muted-foreground">
          If you’re building an autonomous agent, this is the shortest path to a working KYA
          integration: verify signing rules offline, generate keys, then register.
        </p>

        <section className="mb-10 rounded-xl border border-border bg-muted/20 p-6">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Quickstart (3 commands)</h2>
          <pre className="overflow-x-auto rounded border border-border bg-background/50 p-3 font-mono text-xs">
{`pip install pynacl
curl -sS https://raw.githubusercontent.com/UMBRAXON/kya-hub/main/scripts/umbrexon_bot_client.py -o kya_client.py
python3 kya_client.py self-test`}
          </pre>
          <p className="mt-4 text-sm text-muted-foreground">
            The <code className="text-foreground">self-test</code> is offline and validates canonical JSON, digest
            rules, and signatures against pinned golden vectors.
          </p>
        </section>

        <section className="mb-10 grid gap-3 sm:grid-cols-2">
          <a
            className="rounded-xl border border-border bg-background/60 p-5 transition-colors hover:border-primary/50"
            href="/integrators"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Integrator docs</h2>
              <span className="text-xs text-muted-foreground">/integrators</span>
            </div>
            <p className="text-sm text-muted-foreground">
              How platforms verify agents (status gate, cert proof, sandbox).
            </p>
          </a>

          <a
            className="rounded-xl border border-border bg-background/60 p-5 transition-colors hover:border-primary/50"
            href="/openapi/openapi.yaml"
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">OpenAPI</h2>
              <ExternalLink className="size-4 opacity-60" />
            </div>
            <p className="text-sm text-muted-foreground">Full API contract (YAML).</p>
          </a>
        </section>

        <section className="rounded-xl border border-border bg-background/60 p-6">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Docs & discovery</h2>
          <ul className="space-y-2 text-sm">
            <li>
              <a className="text-primary underline-offset-4 hover:underline" href="/AGENTS.md">
                AGENTS.md
              </a>{" "}
              <span className="text-muted-foreground">— machine-readable agent integration overview</span>
            </li>
            <li>
              <a
                className="text-primary underline-offset-4 hover:underline"
                href="/.well-known/kya-hub.json"
              >
                .well-known/kya-hub.json
              </a>{" "}
              <span className="text-muted-foreground">— discovery feed + endpoints</span>
            </li>
            <li>
              <a className="text-primary underline-offset-4 hover:underline" href="/llms.txt">
                llms.txt
              </a>{" "}
              <span className="text-muted-foreground">— crawler hints</span>
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}

