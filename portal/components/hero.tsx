import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

export function Hero({ t }: { t: Dictionary["hero"] }) {
  return (
    <section className="section-glow-top relative flex min-h-[min(85vh,720px)] flex-col items-center justify-center px-4 pt-20 pb-12 text-center sm:min-h-[85vh] sm:pt-24">
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-500/25 bg-cyan-500/5 px-4 py-1.5 text-xs font-medium text-primary shadow-[0_0_20px_rgba(0,255,255,0.1)]">
        <Shield className="size-3.5" aria-hidden />
        {t.badge}
      </div>
      <h1 className="max-w-4xl text-3xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
        {t.titleLead}{" "}
        <span className="bg-gradient-to-r from-primary via-cyan-300 to-primary bg-clip-text text-transparent drop-shadow-[0_0_24px_rgba(0,255,255,0.35)]">
          {t.titleHighlight}
        </span>
      </h1>
      <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        {t.body}{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-primary">
          {t.bodyCode}
        </code>{" "}
        {t.bodyTail}
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <Link
          href="#docs"
          className="neon-btn-cyan inline-flex h-11 items-center gap-2 rounded-lg px-6 text-sm font-medium"
        >
          {t.ctaIntegrate}
          <ArrowRight className="size-4" />
        </Link>
        <Link
          href="#platform"
          className="neon-btn-outline inline-flex h-11 items-center rounded-lg border border-amber-400/40 px-6 text-sm font-medium text-amber-100/90 hover:border-amber-400/60"
        >
          {t.ctaPlatform}
        </Link>
        <Link
          href="#agents"
          className="neon-btn-outline inline-flex h-11 items-center rounded-lg border px-6 text-sm font-medium"
        >
          {t.ctaAgents}
        </Link>
      </div>
    </section>
  );
}
