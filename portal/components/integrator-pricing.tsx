import type { IntegratorLsatProfile } from "@/lib/hub-api";

function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

interface IntegratorPricingProps {
  hubBase: string;
  lsat: IntegratorLsatProfile;
}

export function IntegratorPricing({ hubBase, lsat }: IntegratorPricingProps) {
  const sats = formatSats(lsat.default_amount_sats);
  const hours = lsat.ttl_hours;

  return (
    <section className="mt-10 rounded-lg border border-border bg-muted/20 p-6">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
        Integrator access
      </p>
      <h2 className="mb-2 text-xl font-semibold text-foreground">Pricing tiers</h2>
      <p className="mb-6 text-sm text-muted-foreground">
        Gate verify calls in your marketplace, LNBits extension, or paid API. Live LSAT
        defaults from{" "}
        <code className="text-foreground">GET /api/protocol/integrator-lsat-profile</code>.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background/50 p-4">
          <h3 className="mb-1 font-semibold text-foreground">Sandbox</h3>
          <p className="mb-2 font-mono text-2xl font-bold text-primary">Free</p>
          <p className="text-sm text-muted-foreground">
            Unauthenticated read limits. Use{" "}
            <code className="text-foreground">GET …/status</code> for low-value gates.
          </p>
        </div>

        <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 ring-1 ring-primary/20">
          <h3 className="mb-1 font-semibold text-foreground">LSAT day pass</h3>
          <p className="mb-2 font-mono text-2xl font-bold text-primary">{sats} sats</p>
          <p className="text-sm text-muted-foreground">
            {hours}h access · <code className="text-foreground">umb_lsat_…</code> Bearer
            token after Lightning payment.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background/50 p-4">
          <h3 className="mb-1 font-semibold text-foreground">Partner key</h3>
          <p className="mb-2 font-mono text-2xl font-bold text-foreground">Contact</p>
          <p className="text-sm text-muted-foreground">
            <code className="text-foreground">umb_live_…</code> — higher rate limits,
            webhooks, enterprise bundle.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold text-foreground">LSAT checkout (self-serve)</h3>
        <pre className="overflow-x-auto rounded border border-border bg-background/50 p-3 font-mono text-xs text-foreground">
{`# 1. Create invoice (optional: Authorization: Bearer umb_live_…)
curl -sS -X POST ${hubBase}/api/v1/integrator/lsat/invoice -H 'Content-Type: application/json' -d '{}'

# 2. Pay bolt11 → poll GET …/lsat/status?access_id=… until status=paid

# 3. Redeem once → use Authorization: Bearer umb_lsat_… on verify endpoints`}
        </pre>
      </div>

      <p className="mt-4 text-sm text-muted-foreground">
        Paid API + identity:{" "}
        <a className="text-primary underline" href="/docs/KYA-L402-VS-X402.md">
          KYA + L402 vs raw x402
        </a>
        {" · "}
        <a className="text-primary underline" href="/docs/MCP-SECURITY-CHECKLIST.md">
          MCP security checklist
        </a>
      </p>
    </section>
  );
}
