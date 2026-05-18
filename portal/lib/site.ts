/** Canonical public site URL (no trailing slash). */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.NEXT_PUBLIC_HUB_URL ||
  "https://www.umbraxon.xyz"
).replace(/\/$/, "");
