import Link from "next/link";

const LINKS = [
  { href: "#about", label: "About" },
  { href: "#agents", label: "Agents" },
  { href: "#docs", label: "Docs" },
  { href: "/README_API.md", label: "README_API" },
  { href: "/api/health", label: "Health API" },
];

export function Footer() {
  return (
    <footer className="border-t border-cyan-500/10 bg-[#0d0d0d] px-4 py-12">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-8 md:flex-row">
        <div>
          <p className="font-mono text-sm font-semibold tracking-widest text-primary">
            UMBRAXON KYA HUB
          </p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Umbraxon Know Your Agent — Lightning-paid M2M identity for autonomous
            systems.
          </p>
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
        © {new Date().getFullYear()} Umbraxon KYA Hub. Non-custodial agent registry.
      </p>
    </footer>
  );
}
