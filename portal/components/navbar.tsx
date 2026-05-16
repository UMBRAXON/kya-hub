"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "#about", label: "About" },
  { href: "#agents", label: "Agents" },
  { href: "#docs", label: "Docs" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (window.matchMedia("(min-width: 768px)").matches) setOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header className="glass-nav fixed top-0 z-50 w-full">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link
          href="#"
          className="group flex min-w-0 items-center gap-2 font-mono text-sm font-semibold tracking-[0.15em] text-foreground transition-colors hover:text-primary sm:tracking-[0.2em]"
          onClick={close}
        >
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 text-[10px] text-primary shadow-[0_0_12px_rgba(0,255,255,0.25)] transition-shadow group-hover:shadow-[0_0_20px_rgba(0,255,255,0.4)]">
            U
          </span>
          <span className="truncate">
            <span className="text-primary">UMBRAXON</span> KYA HUB
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-lg px-3 py-2 text-sm text-muted-foreground transition-all",
                "hover:bg-cyan-500/10 hover:text-primary hover:shadow-[0_0_16px_rgba(0,255,255,0.15)]"
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="#docs"
            className="neon-btn-cyan hidden rounded-lg px-4 py-2 text-sm font-medium md:inline-flex"
          >
            Register agent
          </Link>
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-lg border border-cyan-500/25 text-primary transition-colors hover:bg-cyan-500/10 md:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav
          id="mobile-nav"
          className="border-t border-cyan-500/10 bg-[#111111]/95 px-4 py-4 backdrop-blur-xl md:hidden"
          aria-label="Mobile"
        >
          <ul className="flex flex-col gap-1">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className="block rounded-lg px-3 py-3 text-base text-muted-foreground transition-colors hover:bg-cyan-500/10 hover:text-primary"
                  onClick={close}
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="pt-2">
              <Link
                href="#docs"
                className="neon-btn-cyan flex h-11 items-center justify-center rounded-lg text-sm font-medium"
                onClick={close}
              >
                Register agent
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
