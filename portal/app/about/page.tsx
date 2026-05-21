import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
  OPERATOR,
  OPERATOR_TELEGRAM_URL,
  OPERATOR_X_URL,
} from "@/lib/operator";
import { getServerDictionary } from "@/lib/locale-server";
import { buildPageMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return buildPageMetadata({
    title: t.trustPage.metaTitle,
    description: t.trustPage.metaDescription,
    path: "/about",
  });
}

export default async function AboutPage() {
  const { locale, t } = await getServerDictionary();
  const p = t.trustPage;

  const proofLinks: { href: string; label: string; external?: boolean }[] = [
    { href: OPERATOR.githubRepo, label: p.proofSource, external: true },
    { href: "/docs/WHAT-WE-ARE-NOT.md", label: p.proofWhatNot },
    { href: "/docs/ON-CHAIN-STATUS.md", label: p.proofOnChain },
    { href: OPERATOR.securityAuditPath, label: p.proofSecurity, external: true },
    { href: "/terms", label: p.proofTerms },
    { href: "/status", label: p.proofStatus },
    { href: "/integrators", label: p.proofIntegrators },
  ];

  const contactLinks: { href: string; label: string; external?: boolean }[] = [
    ...(OPERATOR.emailEnabled
      ? [{ href: `mailto:${OPERATOR.contactEmail}`, label: OPERATOR.contactEmail }]
      : []),
    ...(OPERATOR_TELEGRAM_URL
      ? [{ href: OPERATOR_TELEGRAM_URL, label: p.contactTelegram, external: true as const }]
      : []),
    { href: OPERATOR.githubDiscussions, label: p.contactDiscussions, external: true },
    {
      href: `${OPERATOR.githubRepo}/issues/new/choose`,
      label: p.contactIssues,
      external: true,
    },
  ];

  return (
    <div className="bg-grid min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link href="/" className="font-mono text-sm font-semibold text-primary">
            ← UMBRAXON KYA Hub
          </Link>
          <span className="text-xs text-muted-foreground">{locale.toUpperCase()}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-primary">
          {p.eyebrow}
        </p>
        <h1 className="mb-4 text-3xl font-bold text-foreground">{p.title}</h1>
        <p className="mb-8 leading-relaxed text-muted-foreground">{p.intro}</p>

        <section className="mb-10 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-cyan-500/40 bg-cyan-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-primary">
              {p.fromSlovakia}
            </span>
          </div>
          <h2 className="mb-2 text-lg font-semibold text-foreground">{p.operatorTitle}</h2>
          {OPERATOR.maintainerName ? (
            <p className="text-lg font-medium text-foreground">
              <span className="text-muted-foreground">{p.maintainerLabel}: </span>
              {OPERATOR.maintainerGithub ? (
                <a
                  href={OPERATOR.maintainerGithub}
                  className="text-primary underline-offset-4 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {OPERATOR.maintainerName}
                </a>
              ) : (
                OPERATOR.maintainerName
              )}
            </p>
          ) : null}
          <p className="mt-2 font-mono text-xl text-primary">{OPERATOR.displayName}</p>
          <p className="mt-2 text-sm text-muted-foreground">{p.operatorRole}</p>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{p.operatorBody}</p>
          <dl className="mt-4 space-y-2 rounded-lg border border-border/60 bg-background/40 px-4 py-3 text-sm">
            {p.operatorInfra.map((row) => (
              <div key={row.label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="shrink-0 font-medium text-foreground/90 sm:w-52">{row.label}</dt>
                <dd className="text-muted-foreground">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-foreground/90">{p.operatorStory}</p>
          <ul className="mt-4 flex flex-wrap gap-3">
            <li>
              <a
                href={OPERATOR.githubOrg}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub <ExternalLink className="size-3.5 opacity-60" />
              </a>
            </li>
            {OPERATOR_TELEGRAM_URL ? (
              <li>
                <a
                  href={OPERATOR_TELEGRAM_URL}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {p.contactTelegram}{" "}
                  <ExternalLink className="size-3.5 opacity-60" />
                </a>
              </li>
            ) : null}
            {OPERATOR_X_URL ? (
              <li>
                <a
                  href={OPERATOR_X_URL}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/50 hover:text-primary"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  X <ExternalLink className="size-3.5 opacity-60" />
                </a>
              </li>
            ) : null}
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold text-foreground">{p.proofTitle}</h2>
          <ul className="space-y-2">
            {proofLinks.map((item) =>
              item.external ? (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                  </a>
                </li>
              ) : (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {item.label}
                  </Link>
                </li>
              ),
            )}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">{p.auditDisclaimer}</p>
        </section>

        <section className="mb-10 rounded-lg border border-border bg-muted/20 p-5">
          <h2 className="mb-2 text-lg font-semibold text-foreground">{p.honestTitle}</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {p.honestBullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold text-foreground">{p.contactTitle}</h2>
          <p className="mb-4 text-sm text-muted-foreground">{p.contactIntro}</p>
          <ul className="space-y-2">
            {contactLinks.map((item) =>
              item.external ? (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {item.label}
                  </a>
                </li>
              ) : (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    {item.label}
                  </a>
                </li>
              ),
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}
