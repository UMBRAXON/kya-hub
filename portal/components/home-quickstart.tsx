import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";

export function HomeQuickstart({ t }: { t: Dictionary["quickstart"] }) {
  return (
    <section className="section-pro border-y border-border/80 bg-card/40">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-primary">
              {t.eyebrow}
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {t.title}
            </h2>
          </div>
          <Link
            href="/integrators"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {t.fullGuide}
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <ol className="grid gap-4 md:grid-cols-3">
          {t.steps.map((step, i) => (
            <li
              key={step.title}
              className="rounded-xl border border-border/80 bg-background/60 p-5"
            >
              <span className="font-mono text-xs text-muted-foreground">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 text-sm font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {step.body}
              </p>
            </li>
          ))}
        </ol>
        <pre className="pro-code mt-6 overflow-x-auto rounded-lg border border-border/80 bg-[#0a0a0a] p-4 text-left text-xs leading-relaxed text-foreground/90 sm:text-sm">
          <code>{t.code}</code>
        </pre>
      </div>
    </section>
  );
}
