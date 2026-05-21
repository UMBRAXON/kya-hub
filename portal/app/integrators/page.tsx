import Link from "next/link";
import { IntegratorQuickstart } from "@/components/integrator-quickstart";
import { PromoVideo } from "@/components/promo-video";
import { HUB_BASE } from "@/lib/hub-api";
import { getServerDictionary } from "@/lib/locale-server";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = buildPageMetadata({
  title: "Integrator quickstart — UMBRAXON KYA Hub",
  description:
    "Verify KYA agents in your product: status gate, cert_proof, sandbox, partner API keys, webhooks.",
  path: "/integrators",
});

export default async function IntegratorsPage() {
  const { t } = await getServerDictionary();

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

        <section className="mt-10 rounded-lg border border-border bg-muted/20 p-5">
          <h2 className="mb-2 text-lg font-semibold">Verify badge (embed)</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Show KYA status on your site. Replace <code>UMBRA-000467</code> with the agent you gate.
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${HUB_BASE}/api/embed/badge/UMBRA-000467`}
              alt="KYA verified badge"
              height={20}
            />
            <a
              className="text-sm text-primary underline"
              href={`${HUB_BASE}/api/v1/agents/UMBRA-000467/status`}
            >
              Live status JSON
            </a>
          </div>
          <pre className="overflow-x-auto rounded border border-border bg-background/50 p-3 font-mono text-xs">
{`<!-- Markdown -->
![KYA verified](${HUB_BASE}/api/embed/badge/UMBRA-000467)

<!-- HTML -->
<a href="${HUB_BASE}/api/v1/agents/UMBRA-000467/status">
  <img src="${HUB_BASE}/api/embed/badge/UMBRA-000467" alt="KYA verified" height="20" />
</a>`}
          </pre>
        </section>

        <pre className="mt-10 overflow-x-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-xs text-foreground">
{`npm install @umbraxon_kya/kya-verify

import { verifyAgentStatus } from '@umbraxon_kya/kya-verify';
const { verified } = await verifyAgentStatus('${HUB_BASE}', 'UMBRA-TEST-0001');`}
        </pre>
        <p className="mt-6 text-sm text-muted-foreground">
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
          {" · "}
          <a className="text-primary underline" href="/llms.txt">
            llms.txt
          </a>
          {" · "}
          <a className="text-primary underline" href="/AGENTS.md">
            AGENTS.md
          </a>
          {" · "}
          <a className="text-primary underline" href="/status">
            Status
          </a>
          {" · "}
          <a className="text-primary underline" href="/docs/KYA-VS-API-KEY.md">
            KYA vs API key
          </a>
          {" · "}
          <a className="text-primary underline" href="/operator-pack.html">
            Operator pack (Word)
          </a>
        </p>
      </main>
      <PromoVideo t={t.promoVideo} />
    </div>
  );
}
