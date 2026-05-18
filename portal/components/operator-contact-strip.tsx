import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { OPERATOR, OPERATOR_TELEGRAM_URL } from "@/lib/operator";
import type { Dictionary } from "@/lib/i18n";

export function OperatorContactStrip({ t }: { t: Dictionary["contactStrip"] }) {
  const person = OPERATOR.maintainerName || t.maintainerFallback;

  return (
    <section
      id="contact"
      className="section-pro border-t border-border/80 bg-card/30"
      aria-labelledby="contact-heading"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <span className="inline-flex rounded-full border border-border bg-background px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary">
              {t.builtInEu}
            </span>
            <h2
              id="contact-heading"
              className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
            >
              {t.title}
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {t.body}
            </p>
            <p className="mt-4 text-sm text-foreground">
              <span className="text-muted-foreground">{t.maintainerLabel} </span>
              <span className="font-medium">{person}</span>
              <span className="text-muted-foreground"> · {OPERATOR.displayName}</span>
            </p>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground/90">
              {t.operatorStory}
            </p>
          </div>
          <ul className="flex flex-col gap-2 sm:flex-row lg:flex-col">
            {OPERATOR_TELEGRAM_URL ? (
              <li>
                <a
                  href={OPERATOR_TELEGRAM_URL}
                  className="btn-primary inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium sm:w-auto lg:min-w-[200px]"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle className="size-4" aria-hidden />
                  {t.telegram}
                </a>
              </li>
            ) : null}
            <li>
              <Link
                href="/about"
                className="btn-secondary inline-flex h-11 w-full items-center justify-center rounded-lg px-5 text-sm font-medium sm:w-auto lg:min-w-[200px]"
              >
                {t.trustLink}
              </Link>
            </li>
            <li>
              <a
                href={OPERATOR.githubDiscussions}
                className="inline-flex h-11 w-full items-center justify-center rounded-lg px-5 text-sm text-muted-foreground transition-colors hover:text-primary sm:w-auto lg:min-w-[200px]"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub Discussions
              </a>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
