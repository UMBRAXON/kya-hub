import { en } from "@/lib/messages/en";
import { sk } from "@/lib/messages/sk";

export type Locale = "en" | "sk";

export type Dictionary = typeof en;

const dictionaries = { en, sk };

export function isLocale(v: string | undefined): v is Locale {
  return v === "en" || v === "sk";
}

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] as Dictionary;
}

export function formatSats(n: number, locale: Locale): string {
  return n.toLocaleString(locale === "sk" ? "sk-SK" : "en-US");
}

export const LOCALE_COOKIE = "kya_locale";
