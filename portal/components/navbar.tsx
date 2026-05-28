"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "@/components/language-switcher";
import type { Dictionary, Locale } from "@/lib/i18n";

function primaryLinks(nav: Dictionary["nav"]) {
  return [
    { href: "/bots/", label: "Bots" },
    { href: "/integrators", label: nav.integrators },
    { href: "#platform", label: nav.platform },
    { href: "/about", label: nav.trust },
    { href: "#agents", label: nav.agents },
    { href: "#docs", label: nav.docs },
  ];
}

function drawerLinks(nav: Dictionary["nav"]) {
  return [
    { href: "#contact", label: nav.contact },
    { href: "/about", label: nav.trust },
    { href: "/bots/", label: "Bots" },
    { href: "/integrators", label: nav.integrators },
    { href: "#platform", label: nav.platform },
    { href: "#about", label: nav.about },
    { href: "#tiers", label: nav.tiers },
    { href: "#agents", label: nav.agents },
    { href: "#docs", label: nav.docs },
  ];
}

const linkClass =
  "whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-card hover:text-foreground lg:text-sm";

export function Navbar({
  locale,
  nav,
}: {
  locale: Locale;
  nav: Dictionary["nav"];
}) {
  const [open, setOpen] = useState(false);
  const primary = primaryLinks(nav);
  const drawer = drawerLinks(nav);

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (window.matchMedia("(min-width: 1280px)").matches) setOpen(false);
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
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-3 sm:h-16 sm:px-6">
        <Link
          href="/"
          className="group flex min-w-0 shrink-0 items-center gap-2 font-mono text-xs font-semibold tracking-wide text-foreground sm:text-sm"
          onClick={close}
        >
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-[10px] text-primary sm:size-8">
            U
          </span>
          <span className="truncate">
            <span className="text-primary">UMBRAXON</span>
            <span className="hidden min-[400px]:inline text-muted-foreground"> KYA</span>
          </span>
        </Link>

        <nav
          className="hidden min-w-0 flex-1 items-center justify-center gap-0.5 xl:flex"
          aria-label="Main"
        >
          {primary.map((l) => (
            <Link key={l.href} href={l.href} className={linkClass}>
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <div className="hidden sm:block">
            <LanguageSwitcher
              locale={locale}
              labels={{
                language: nav.language,
                langEn: nav.langEn,
                langSk: nav.langSk,
              }}
            />
          </div>
          <Link
            href="#docs"
            className="btn-primary hidden h-9 items-center rounded-lg px-3 text-xs font-medium sm:inline-flex sm:h-10 sm:px-4 sm:text-sm"
          >
            <span className="xl:hidden">{nav.registerShort}</span>
            <span className="hidden xl:inline">{nav.register}</span>
          </Link>
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-lg border border-border text-foreground transition-colors hover:bg-card sm:size-10 xl:hidden"
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
          className="max-h-[min(70vh,520px)] overflow-y-auto border-t border-border bg-card/95 px-4 py-4 backdrop-blur-xl xl:hidden"
          aria-label="Mobile"
        >
          <ul className="flex flex-col gap-0.5">
            {drawer.map((l) => (
              <li key={`${l.href}-${l.label}`}>
                <Link href={l.href} className="block rounded-lg px-3 py-3 text-base text-muted-foreground hover:bg-background hover:text-foreground" onClick={close}>
                  {l.label}
                </Link>
              </li>
            ))}
            <li className="border-t border-border py-3 sm:hidden">
              <LanguageSwitcher
                locale={locale}
                labels={{
                  language: nav.language,
                  langEn: nav.langEn,
                  langSk: nav.langSk,
                }}
              />
            </li>
            <li className="pt-1 sm:hidden">
              <Link
                href="#docs"
                className="btn-primary flex h-11 items-center justify-center rounded-lg text-sm font-medium"
                onClick={close}
              >
                {nav.register}
              </Link>
            </li>
          </ul>
        </nav>
      )}
    </header>
  );
}
