import Link from "next/link";
import { OPERATOR, OPERATOR_TELEGRAM_URL } from "@/lib/operator";
import type { Dictionary } from "@/lib/i18n";

export function Footer({ t }: { t: Dictionary["footer"] }) {
  const LINKS = [
    { href: "#contact", label: t.contact },
    { href: `mailto:${OPERATOR.contactEmail}`, label: OPERATOR.contactEmail },
    ...(OPERATOR_TELEGRAM_URL
      ? [{ href: OPERATOR_TELEGRAM_URL, label: "Telegram", external: true as const }]
      : []),
    { href: "/about", label: t.trust },
    { href: OPERATOR.githubRepo, label: t.github, external: true },
    { href: "/status", label: t.status },
    { href: "/terms", label: t.terms },
    { href: OPERATOR.securityAuditPath, label: t.security, external: true },
    { href: "/docs/WHAT-WE-ARE-NOT.md", label: t.whatWeAreNot },
    { href: "/integrators", label: t.platform },
    { href: "#about", label: t.about },
    { href: "#agents", label: t.agents },
    { href: "#docs", label: t.docs },
    { href: "/README_API.md", label: t.readme },
    { href: "/api/health", label: t.health },
  ];

  return (
    <footer className="border-t border-cyan-500/10 bg-[#0d0d0d] px-4 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-8 md:flex-row">
        <div>
          <p className="font-mono text-sm font-semibold tracking-widest text-primary">
            UMBRAXON KYA HUB
          </p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t.tagline}</p>
        </div>
        <nav className="flex flex-wrap justify-center gap-x-6 gap-y-3">
          {LINKS.map((l) =>
            l.external ? (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground transition-colors hover:text-primary hover:drop-shadow-[0_0_8px_rgba(0,255,255,0.5)]"
              >
                {l.label}
              </a>
            ) : (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-muted-foreground transition-colors hover:text-primary hover:drop-shadow-[0_0_8px_rgba(0,255,255,0.5)]"
              >
                {l.label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <p className="mx-auto mt-10 max-w-6xl text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {t.copyright}
      </p>
    </footer>
  );
}
