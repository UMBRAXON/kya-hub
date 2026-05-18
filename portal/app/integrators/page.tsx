import Link from "next/link";
import { IntegratorQuickstart } from "@/components/integrator-quickstart";
import { HUB_BASE } from "@/lib/hub-api";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Integrator quickstart — UMBRAXON KYA Hub",
  description: "5-minute plug-in guide: sandbox gate, API key request, webhooks.",
};

export default function IntegratorsPage() {
  return (
    <div className="bg-grid min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-mono text-sm font-semibold text-primary">
            ← UMBRAXON KYA Hub
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">Plug-in API</p>
        <h1 className="mb-4 text-3xl font-bold text-foreground">Integrator quickstart</h1>
        <p className="mb-8 text-muted-foreground">
          Verify KYA agents before payment or action. Fast path:{" "}
          <code className="text-foreground">GET …/status</code>. High value:{" "}
          <code className="text-foreground">?include=cert_proof</code>. Hub:{" "}
          <code className="text-foreground">{HUB_BASE}</code>
        </p>
        <IntegratorQuickstart hubBase={HUB_BASE} />
        <p className="mt-10 text-sm text-muted-foreground">
          Docs:{" "}
          <a className="text-primary underline" href="/docs/INTEGRATOR-QUICKSTART-5MIN.md">
            INTEGRATOR-QUICKSTART-5MIN.md
          </a>
          {" · "}
          <a className="text-primary underline" href="/docs/FAQ-FOR-BOT-DEVELOPERS.md">
            FAQ §I
          </a>
          {" · "}
          <a className="text-primary underline" href="/openapi/openapi.yaml">
            OpenAPI
          </a>
        </p>
      </main>
    </div>
  );
}
