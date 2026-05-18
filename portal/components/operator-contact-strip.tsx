import Link from "next/link";
import { Mail, MessageCircle } from "lucide-react";
import {
  OPERATOR,
  OPERATOR_TELEGRAM_URL,
} from "@/lib/operator";
import type { Dictionary } from "@/lib/i18n";

export function OperatorContactStrip({ t }: { t: Dictionary["contactStrip"] }) {
  const person = OPERATOR.maintainerName || t.maintainerFallback;

  return (
    <section
      id="contact"
      className="border-y border-cyan-500/15 bg-cyan-500/5 px-4 py-10"
      aria-labelledby="contact-heading"
    >
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <span className="mb-3 inline-flex rounded-full border border-cyan-500/40 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
              {t.builtInEu}
            </span>
            <h2
              id="contact-heading"
              className="text-xl font-semibold text-foreground sm:text-2xl"
            >
              {t.title}
            </h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t.body}</p>
            <p className="mt-3 text-sm text-foreground">
              <span className="text-muted-foreground">{t.maintainerLabel}</span>{" "}
              {OPERATOR.maintainerGithub ? (
                <a
                  href={OPERATOR.maintainerGithub}
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {person}
                </a>
              ) : (
                <span className="font-medium">{person}</span>
              )}
              <span className="text-muted-foreground"> · {OPERATOR.displayName}</span>
            </p>
          </div>
          <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <li>
              <a
                href={`mailto:${OPERATOR.contactEmail}`}
                className="neon-btn-outline inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm font-medium"
              >
                <Mail className="size-4" aria-hidden />
                {OPERATOR.contactEmail}
              </a>
            </li>
            {OPERATOR_TELEGRAM_URL ? (
              <li>
                <a
                  href={OPERATOR_TELEGRAM_URL}
                  className="neon-btn-outline inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm font-medium"
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
                className="neon-btn-cyan inline-flex h-11 items-center rounded-lg px-4 text-sm font-medium"
              >
                {t.trustLink}
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
