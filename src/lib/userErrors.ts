// ── SitePulse user-facing error text (Phase 9C) ─────────────────────────────
// Pure module. Browser-tested reality: EVERY failed user action surfaces the
// error through `err.message`, and on this stack the server error arrives
// wrapped as:
//   "[CONVEX M(module:fn)] [Request ID: ...] Server Error\n" +
//   "Uncaught ConvexError: {\"code\":\"limit\",\"message\":\"…\"} at handler (../src/…:489:7)"
// Showing that verbatim leaked internal file paths, request ids and raw JSON
// (observed on the agency client-cap and auth screens). friendlyError
// unwraps it into the sentence the SERVER authored:
//   1. embedded ConvexError JSON  → its `message` field (or the string data);
//   2. embedded generic Error     → the message on its first line;
//   3. anything else framework-shaped (or absurdly long) → the caller's
//      fixed `fallback` sentence;
//   4. short clean application messages pass through unchanged.
// Auth screens keep their stricter fixed-fallback policy in ./authErrors.ts.

/** Longest message shown verbatim to a user. */
const MAX_MESSAGE_LENGTH = 300;

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_MESSAGE_LENGTH
    ? trimmed.slice(0, MAX_MESSAGE_LENGTH - 1) + "…"
    : trimmed;
}

export function friendlyError(error: unknown, fallback: string): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (!raw) return fallback;

  // 1. ConvexError payload inside the wrapper → the authored message.
  const convexMatch = raw.match(/Uncaught ConvexError:\s*(\{[\s\S]*?\})(?=\s+at |\n|$)/);
  if (convexMatch) {
    try {
      const data = JSON.parse(convexMatch[1]) as unknown;
      if (typeof data === "string" && data.trim()) return clip(data);
      if (data !== null && typeof data === "object") {
        const message = (data as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) return clip(message);
      }
    } catch {
      // Malformed payload — fall through to the generic handlers below.
    }
  }

  // 2. Wrapped generic server error → the message line (stack starts on the
  //    next line, so [^\n]+ stops exactly where the stack begins).
  const genericMatch = raw.match(/Uncaught Error:\s*([^\n]+)/);
  if (genericMatch && genericMatch[1].trim()) return clip(genericMatch[1]);

  // 3. Framework-shaped with nothing extractable (or just too long) → fallback.
  if (
    raw.includes("[CONVEX") ||
    raw.includes("Server Error") ||
    /\n\s+at /.test(raw) ||
    raw.length > 220
  ) {
    return fallback;
  }

  // 4. Clean, short, application-authored message.
  return raw;
}
