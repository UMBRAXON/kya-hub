/**
 * Public operator / trust links (single source of truth for portal).
 *
 * Optional env (portal/.env.local or deploy env):
 * - NEXT_PUBLIC_OPERATOR_X_URL — e.g. https://x.com/UMBRAXON
 * - NEXT_PUBLIC_OPERATOR_TELEGRAM — e.g. https://t.me/your_handle (no @ in URL)
 */
export const OPERATOR = {
  displayName: "UMBRAXON",
  /** Public name of the person behind the hub (set NEXT_PUBLIC_OPERATOR_NAME on deploy). */
  maintainerName:
    process.env.NEXT_PUBLIC_OPERATOR_NAME?.trim() || null,
  /** Personal GitHub profile, e.g. https://github.com/yourhandle */
  maintainerGithub:
    process.env.NEXT_PUBLIC_OPERATOR_GITHUB?.trim() || null,
  githubOrg: "https://github.com/UMBRAXON",
  githubRepo: "https://github.com/UMBRAXON/kya-hub",
  githubDiscussions:
    "https://github.com/UMBRAXON/kya-hub/discussions",
  contactEmail: "hello@umbraxon.xyz",
  securityAuditPath:
    "https://github.com/UMBRAXON/kya-hub/blob/main/SECURITY-AUDIT-2026-05-12.md",
  securityAuditEveningPath:
    "https://github.com/UMBRAXON/kya-hub/blob/main/SECURITY-AUDIT-2026-05-12-EVENING.md",
} as const;

export const OPERATOR_X_URL =
  process.env.NEXT_PUBLIC_OPERATOR_X_URL?.trim() || null;

export const OPERATOR_TELEGRAM_URL =
  process.env.NEXT_PUBLIC_OPERATOR_TELEGRAM?.trim() || null;
