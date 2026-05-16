import { cookies, headers } from "next/headers";
import {
  getDictionary,
  isLocale,
  type Dictionary,
  type Locale,
  LOCALE_COOKIE,
} from "@/lib/i18n";

export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(raw)) return raw;
  const accept = (await headers()).get("accept-language") ?? "";
  if (accept.toLowerCase().startsWith("sk")) return "sk";
  return "en";
}

export async function getServerDictionary(): Promise<{
  locale: Locale;
  t: Dictionary;
}> {
  const locale = await getServerLocale();
  return { locale, t: getDictionary(locale) };
}
