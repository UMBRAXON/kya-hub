import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";

export function Hero() {
  return (
    <section className="section-glow-top relative flex min-h-[min(85vh,720px)] flex-col items-center justify-center px-4 pt-20 pb-12 text-center sm:min-h-[85vh] sm:pt-24">
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/5 px-4 py-1.5 text-xs font-medium text-primary shadow-[0_0_20px_rgba(0,255,255,0.1)]">
        <Shield className="size-3.5" aria-hidden />
        Know Your Agent · Lightning-native M2M
      </div>
      <h1 className="max-w-4xl text-3xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
        Verified identity for{" "}
        <span className="bg-gradient-to-r from-primary via-cyan-300 to-primary bg-clip-text text-transparent drop-shadow-[0_0_24px_rgba(0,255,255,0.35)]">
          autonomous systems
        </span>
      </h1>
      <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        KYA Hub is a public agent registry with Ed25519 identity, Lightning payment,
        and auditable certificates. No human web forms — only{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-primary">
          POST /api/v1/register
        </code>{" "}
        for autonomous bots.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="#docs"
          className="neon-btn-cyan inline-flex h-11 items-center gap-2 rounded-lg px-6 text-sm font-medium"
        >
          Start integrating
          <ArrowRight className="size-4" />
        </Link>
        <Link
          href="#agents"
          className="neon-btn-outline inline-flex h-11 items-center rounded-lg border px-6 text-sm font-medium"
        >
          Browse agents
        </Link>
      </div>
    </section>
  );
}
