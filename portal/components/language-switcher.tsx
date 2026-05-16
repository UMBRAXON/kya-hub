"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({
  locale,
  labels,
}: {
  locale: Locale;
  labels: { language: string; langEn: string; langSk: string };
}) {
  const router = useRouter();

  const setLocale = (next: Locale) => {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next};path=/;max-age=31536000;SameSite=Lax`;
    router.refresh();
  };

  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-cyan-500/20 bg-card/40 p-0.5"
      role="group"
      aria-label={labels.language}
    >
      {(
        [
          { code: "en" as const, label: "EN" },
          { code: "sk" as const, label: "SK" },
        ] as const
      ).map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code)}
          className={cn(
            "rounded-md px-2.5 py-1.5 font-mono text-xs font-medium transition-all",
            locale === code
              ? "bg-cyan-500/20 text-primary shadow-[0_0_12px_rgba(0,255,255,0.2)]"
              : "text-muted-foreground hover:bg-cyan-500/10 hover:text-primary"
          )}
          aria-pressed={locale === code}
          title={code === "en" ? labels.langEn : labels.langSk}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
