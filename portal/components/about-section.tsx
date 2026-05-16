import { Anchor, Bitcoin, ShieldCheck, Zap } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface AboutSectionProps {
  hubVersion?: string;
  hubPhase?: string;
}

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "Ed25519 identity",
    description:
      "Agents prove control with their own keypair. Privileged actions use detached signatures over canonical payloads — not bearer tokens, API keys, or sessions.",
  },
  {
    icon: Zap,
    title: "Lightning registration",
    description:
      "Registration is paid on Lightning (M2M only). After settlement, poll status and fetch a publicly auditable certificate at GET /api/cert/{kya_id}.",
  },
  {
    icon: Anchor,
    title: "Public accountability",
    description:
      "Misbehaviour is reflected in a public CRL and a 3ⁿ price multiplier on re-registration (capped at 9×). Identity is designed to be verifiable, not anonymous by default.",
  },
  {
    icon: Bitcoin,
    title: "Non-custodial hub",
    description:
      "Every sat collected is spent on chain anchoring or recognised as revenue. There is no escrow, bond, or refund — the registry does not hold agent funds.",
  },
] as const;

export function AboutSection({ hubVersion, hubPhase }: AboutSectionProps) {
  return (
    <section id="about" className="relative px-4 py-20">
      <div className="glow-divider mx-auto mb-16 max-w-4xl" />
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            About KYA Hub
          </h2>
          {(hubVersion || hubPhase) && (
            <p className="mt-3">
              <Badge
                variant="outline"
                className="border-cyan-500/30 bg-cyan-500/10 font-mono text-xs text-primary"
              >
                Hub {hubVersion ?? "—"}
                {hubPhase ? ` · ${hubPhase}` : ""}
              </Badge>
            </p>
          )}
        </div>

        <p className="mx-auto max-w-3xl text-center text-base leading-relaxed text-muted-foreground sm:text-lg">
          <strong className="font-medium text-foreground">Know Your Agent Hub</strong>{" "}
          is a Lightning-paid, Ed25519-anchored identity and reputation registry for
          autonomous software agents. An agent proves it exists, pays a small fee,
          signs a manifest with its own key, and receives a certificate others can
          verify offline. Subsequent actions are authenticated with cryptographic
          non-repudiation — built for bots and integrators, not human web forms.
        </p>

        <div className="mt-14 grid gap-5 sm:grid-cols-2">
          {PILLARS.map(({ icon: Icon, title, description }) => (
            <Card key={title} className="neon-card border-0 ring-0">
              <CardHeader>
                <Icon
                  className="size-8 text-primary drop-shadow-[0_0_8px_rgba(0,255,255,0.35)]"
                  aria-hidden
                />
                <CardTitle className="mt-3 text-lg">{title}</CardTitle>
                <CardDescription className="text-sm leading-relaxed">
                  {description}
                </CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          ))}
        </div>

        <div className="mt-14 rounded-xl border border-cyan-500/15 bg-card/40 p-6 sm:p-8">
          <h3 className="font-mono text-sm font-semibold tracking-wider text-primary">
            When to integrate
          </h3>
          <ul className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            <li className="flex gap-2">
              <span className="text-primary" aria-hidden>
                →
              </span>
              Prove your agent is not a Sybil sockpuppet to a counterparty.
            </li>
            <li className="flex gap-2">
              <span className="text-primary" aria-hidden>
                →
              </span>
              Provide an audit trail of which agent signed each request.
            </li>
            <li className="flex gap-2">
              <span className="text-primary" aria-hidden>
                →
              </span>
              Carry portable reputation across operators (you keep your keys).
            </li>
            <li className="flex gap-2">
              <span className="text-primary" aria-hidden>
                →
              </span>
              Opt into the public discovery feed by capability and tier.
            </li>
          </ul>
          <p className="mt-6 border-t border-cyan-500/10 pt-6 text-sm text-muted-foreground">
            Integrations v1 adds discovery (
            <code className="break-all text-primary">
              /api/discovery/v1/agents.json
            </code>
            ), L402-aligned delegation passes, manifest payment hints, and
            developer webhooks. Start with{" "}
            <a href="/README_API.md" className="text-primary hover:underline">
              README_API.md
            </a>{" "}
            or{" "}
            <a href="/AGENTS.md" className="text-primary hover:underline">
              AGENTS.md
            </a>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
