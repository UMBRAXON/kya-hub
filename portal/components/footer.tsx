import Link from "next/link";
import type { Dictionary } from "@/lib/i18n";

export function Footer({ t }: { t: Dictionary["footer"] }) {
  const LINKS = [
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
        <nav className="flex flex-wrap justify-center gap-6">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-sm text-muted-foreground transition-colors hover:text-primary hover:drop-shadow-[0_0_8px_rgba(0,255,255,0.5)]"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <p className="mx-auto mt-10 max-w-6xl text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} {t.copyright}
      </p>
    </footer>
  );
}
