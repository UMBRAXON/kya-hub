import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";

export function buildPageMetadata(opts: {
  title: string;
  description: string;
  path?: string;
  noIndex?: boolean;
}): Metadata {
  const canonicalPath = opts.path ?? "/";
  const url = canonicalPath.startsWith("http")
    ? canonicalPath
    : `${SITE_URL}${canonicalPath.startsWith("/") ? canonicalPath : `/${canonicalPath}`}`;

  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: url },
    robots: opts.noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true, googleBot: { index: true, follow: true } },
    openGraph: {
      type: "website",
      locale: "en_US",
      alternateLocale: ["sk_SK"],
      url,
      siteName: "UMBRAXON KYA Hub",
      title: opts.title,
      description: opts.description,
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
    },
  };
}

export const INDEXABLE_DOC_PATHS = [
  "/README_API.md",
  "/AGENTS.md",
  "/docs/FAQ-FOR-BOT-DEVELOPERS.md",
  "/docs/INTEGRATOR-TRUST-GATE.md",
  "/docs/INTEGRATOR-QUICKSTART-5MIN.md",
  "/docs/ECONOMICS-AND-SYBIL.md",
  "/docs/REGISTRATION-QUICKSTART.md",
  "/openapi/openapi.yaml",
  "/terms",
  "/about",
  "/docs/WHAT-WE-ARE-NOT.md",
  "/docs/ON-CHAIN-STATUS.md",
  "/bots/",
] as const;
