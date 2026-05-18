import Link from "next/link";
import { OPERATOR, OPERATOR_TELEGRAM_URL } from "@/lib/operator";
import type { Dictionary } from "@/lib/i18n";

export function Footer({ t }: { t: Dictionary["footer"] }) {
  const primary = [
    { href: "/integrators", label: t.platform },
    { href: "/about", label: t.trust },
    { href: "/status", label: t.status },
    { href: OPERATOR.githubRepo, label: t.github, external: true as const },
  ];

  const secondary = [
    { href: "#contact", label: t.contact },
    ...(OPERATOR_TELEGRAM_URL
      ? [{ href: OPERATOR_TELEGRAM_URL, label: "Telegram", external: true as const }]
      : []),
    { href: "/terms", label: t.terms },
    { href: OPERATOR.securityAuditPath, label: t.security, external: true as const },
    { href: "/docs/WHAT-WE-ARE-NOT.md", label: t.whatWeAreNot },
    { href: "/README_API.md", label: t.readme },
  ];

  const renderLink = (l: { href: string; label: string; external?: boolean }) =>
    l.external ? (
      <a
        key={l.href}
        href={l.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {l.label}
      </a>
    ) : (
      <Link
        key={l.href}
        href={l.href}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {l.label}
      </Link>
    );

  return (
    <footer className="border-t border-border/80 bg-[#0c0c0c] px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-widest text-primary">
              UMBRAXON KYA HUB
            </p>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">{t.tagline}</p>
          </div>
          <nav className="flex flex-col gap-4 sm:flex-row sm:gap-12" aria-label="Footer">
            <div className="flex flex-col gap-2">{primary.map(renderLink)}</div>
            <div className="flex flex-col gap-2">{secondary.map(renderLink)}</div>
          </nav>
        </div>
        <p className="mt-8 border-t border-border/60 pt-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} {t.copyright}
        </p>
      </div>
    </footer>
  );
}
