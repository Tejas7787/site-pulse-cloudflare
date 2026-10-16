// ── Post-sign-in redirect allowlist ─────────────────────────────────────────
// Pure module: safe to import from the Auth page and from bun tests.
//
// RequireAuth (src/components/RequireAuth.tsx) sends unauthenticated users to
// /auth?returnTo=<path>, and Auth.tsx navigates there after a successful
// sign-in. Because an attacker can craft that query string, the value is
// never trusted as-is: only same-origin plain paths pass.

/**
 * Returns `returnTo` when it is a safe same-origin path, otherwise `fallback`.
 *
 * Rules (each blocks a known open-redirect / traversal trick):
 * - must start with "/" (same-origin paths only)
 * - no leading "//" (scheme-relative URLs like //evil.com)
 * - no "/./." and no "../" (directory traversal)
 * - no backslash (browsers treat "\" in URLs as "/")
 * - must be a plain path; no query strings ("?") or fragments ("#")
 */
export function resolveRedirectAfterAuth(
  returnTo: string | null,
  fallback = "/dashboard",
): string {
  if (
    returnTo &&
    typeof returnTo === "string" &&
    returnTo.startsWith("/") &&
    !returnTo.startsWith("//") &&
    !returnTo.includes("/./.") &&
    !returnTo.includes("../") &&
    !returnTo.includes(String.fromCharCode(92)) &&
    !returnTo.includes("?") &&
    !returnTo.includes("#")
  ) {
    return returnTo;
  }
  return fallback;
}
