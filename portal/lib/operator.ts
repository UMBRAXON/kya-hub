/**
 * Public operator / trust links (single source of truth for portal).
 *
 * Optional env (portal/.env.local or deploy env):
 * - NEXT_PUBLIC_OPERATOR_NAME — e.g. Ftefan
 * - NEXT_PUBLIC_OPERATOR_X_URL — e.g. https://x.com/UMBRAXON
 * - NEXT_PUBLIC_OPERATOR_TELEGRAM — e.g. https://t.me/Ftefan
 *
 * Email (hello@…) is hidden until OPERATOR_EMAIL_ENABLED is true and routing works.
 */
export const OPERATOR = {
  displayName: "UMBRAXON",
  maintainerName: process.env.NEXT_PUBLIC_OPERATOR_NAME?.trim() || null,
  maintainerGithub: process.env.NEXT_PUBLIC_OPERATOR_GITHUB?.trim() || null,
  /** Flip to true when Cloudflare Email Routing is verified live. */
  emailEnabled: false,
  contactEmail: "hello@umbraxon.xyz",
  githubOrg: "https://github.com/UMBRAXON",
  githubRepo: "https://github.com/UMBRAXON/kya-hub",
  githubDiscussions: "https://github.com/UMBRAXON/kya-hub/discussions",
  securityAuditPath:
    "https://github.com/UMBRAXON/kya-hub/blob/main/SECURITY-AUDIT-2026-05-12.md",
  securityAuditEveningPath:
    "https://github.com/UMBRAXON/kya-hub/blob/main/SECURITY-AUDIT-2026-05-12-EVENING.md",
} as const;

export const OPERATOR_X_URL =
  process.env.NEXT_PUBLIC_OPERATOR_X_URL?.trim() || null;

export const OPERATOR_TELEGRAM_URL =
  process.env.NEXT_PUBLIC_OPERATOR_TELEGRAM?.trim() || null;
