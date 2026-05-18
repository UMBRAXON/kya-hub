import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

export function Hero({ t }: { t: Dictionary["hero"] }) {
  return (
    <section className="section-glow-top section-pro-tight flex flex-col items-center justify-center text-center">
      <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs font-medium text-muted-foreground">
        {t.badge}
      </div>
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
        {t.titleLead}{" "}
        <span className="text-primary">{t.titleHighlight}</span>
      </h1>
      <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
        {t.body}{" "}
        <code className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-sm text-foreground">
          {t.bodyCode}
        </code>{" "}
        {t.bodyTail}
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/integrators"
          className="btn-primary inline-flex h-11 items-center gap-2 rounded-lg px-5 text-sm font-medium"
        >
          {t.ctaIntegrate}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
        <Link
          href="#docs"
          className="btn-secondary inline-flex h-11 items-center rounded-lg px-5 text-sm font-medium"
        >
          {t.ctaRegister}
        </Link>
        <a
          href={t.videoHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 items-center gap-2 rounded-lg px-4 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          <Play className="size-4" aria-hidden />
          {t.ctaVideo}
        </a>
      </div>
    </section>
  );
}
