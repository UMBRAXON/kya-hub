import Link from "next/link";
import { Blocks, CheckCircle2, KeyRound, Webhook, Zap } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

export function PlatformSection({ t }: { t: Dictionary["platform"] }) {
  const icons = [Zap, KeyRound, Webhook, Blocks] as const;

  return (
    <section
      id="platform"
      className="section-pro scroll-mt-20"
      aria-labelledby="platform-heading"
    >
      <div className="mx-auto max-w-6xl">
        <div className="neon-card overflow-hidden border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-transparent to-transparent p-6 shadow-[0_0_48px_rgba(0,255,255,0.12)] sm:p-10">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-xl">
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-200">
                {t.badge}
              </p>
              <h2
                id="platform-heading"
                className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl md:text-4xl"
              >
                {t.title}
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
                {t.body}
              </p>
              <ul className="mt-6 space-y-3">
                {t.bullets.map((line, i) => {
                  const Icon = icons[i % icons.length];
                  return (
                    <li key={line} className="flex gap-3 text-sm text-muted-foreground sm:text-base">
                      <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                      <span>{line}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href={t.primaryHref}
                  className="neon-btn-cyan inline-flex h-11 items-center rounded-lg px-5 text-sm font-medium"
                >
                  {t.ctaPrimary}
                </Link>
                <Link
                  href={t.secondaryHref}
                  className="neon-btn-outline inline-flex h-11 items-center rounded-lg border px-5 text-sm font-medium"
                >
                  {t.ctaSecondary}
                </Link>
              </div>
            </div>
            <div className="w-full min-w-0 lg:max-w-md">
              <p className="mb-2 flex items-center gap-2 font-mono text-xs text-primary">
                <CheckCircle2 className="size-3.5" aria-hidden />
                {t.codeLabel}
              </p>
              <pre className="overflow-x-auto rounded-lg border border-cyan-500/20 bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed text-cyan-100/90 sm:text-sm">
                {t.codeSample}
              </pre>
              <p className="mt-3 text-xs text-muted-foreground">{t.codeFoot}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
