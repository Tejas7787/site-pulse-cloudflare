// ── SitePulse auth error presentation (Phase 9C) ────────────────────────────
// Pure module: map an auth failure to honest, user-safe text — never a raw
// framework error. Convex wraps UNCAUGHT server errors as
// "[CONVEX A(...)] [Request ID: ...] Server Error ... <stack with file
// paths>"; browser-tested on the sign-in form, showing that leaked internal
// paths/request ids and read as a crash. Known, clean messages (short,
// single-line application errors) pass through unchanged; anything
// framework-shaped falls back to a fixed, actionable sentence. Callers keep
// logging the full error to the console.

/** Longest message shown verbatim to a user on the auth screens. */
const MAX_PASSTHROUGH_LENGTH = 220;

export function friendlyAuthError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  if (!raw) return fallback;
  if (
    raw.includes("[CONVEX") ||
    raw.includes("Server Error") ||
    /\n\s+at /.test(raw) || // stack frames
    raw.length > MAX_PASSTHROUGH_LENGTH
  ) {
    return fallback;
  }
  return raw;
}
