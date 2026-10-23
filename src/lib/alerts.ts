// ── Uptime alert email content ────────────────────────────────────────────────
// Pure builders for the plain-text alert emails. No I/O and no secrets: the
// body contains only the user's own monitor data, so it is safe to store on
// the delivery row and to unit-test.

export type AlertKind = "downtime" | "recovery";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Sender address resolution (Phase 9D: Resend configuration) ──────────────
// Resend requires the From domain to be verified for the account. This
// project's verified domain is alerts.tejasdev.xyz, so it is the default
// sender whenever no operator-supplied value is configured. The Convex
// deployment supplies the override through the server-side environment
// variables RESEND_FROM_EMAIL (canonical) or RESEND_FROM (legacy name kept
// for compatibility) — those are read ONLY inside Convex functions
// (src/convex/alerts.ts, src/convex/integrations.ts); this module stays pure
// so the resolution logic is unit-testable and can never touch an env value
// in the browser bundle.

/**
 * The Resend-verified domain for this project. Deliberately the SUBDOMAIN
 * alerts.tejasdev.xyz — the root domain tejasdev.xyz is NOT verified for
 * sending, so any sender outside this exact domain fails closed.
 */
export const VERIFIED_SENDER_DOMAIN = "alerts.tejasdev.xyz";

/** Verified-sender default: used when no sender env var is configured. */
export const DEFAULT_ALERT_FROM = `SitePulse Alerts <alerts@${VERIFIED_SENDER_DOMAIN}>`;

/** Accepts `email@example.com` or a display form `Name <email@example.com>`. */
const FROM_SHAPE = /^(?:[^<>"\n]*<)?[^\s@<>"\n]+@[^\s@<>"\n]+\.[^\s@<>"\n]{2,}>?$/;

/** True when a configured From candidate looks like a usable sender address. */
export function isPlausibleFrom(value: string | null | undefined): boolean {
  return typeof value === "string" && FROM_SHAPE.test(value.trim());
}

/**
 * Resolve the From header for outgoing mail. Candidates are checked in
 * priority order and the first plausible one wins; when none is configured
 * (or the configured value is garbage), the verified default is used so a
 * mistyped env var can never send mail from an unverified domain.
 * Deliberately takes values as ARGUMENTS — it never reads process.env.
 */
export function resolveAlertFrom(
  candidates: Array<string | null | undefined>,
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && FROM_SHAPE.test(trimmed)) return trimmed;
  }
  return DEFAULT_ALERT_FROM;
}

/**
 * Extract the domain of a From candidate (`a@b.c` or `Name <a@b.c>`),
 * lowercased; null when the candidate is not a parseable address.
 */
export function fromDomain(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const addr = trimmed.includes("<")
    ? (trimmed.match(/<([^<>]+)>/)?.[1] ?? null)
    : trimmed;
  const candidate = addr?.trim();
  if (!candidate || !EMAIL_SHAPE.test(candidate)) return null;
  return candidate.split("@").pop()?.toLowerCase() ?? null;
}

/**
 * True when the sender resolveAlertFrom WOULD pick is on the verified domain
 * — including the no-config default (which is verified by construction).
 * Pure and value-free: callers get a boolean and can never echo the
 * configured address from it.
 */
export function configuredSenderIsVerified(
  candidates: Array<string | null | undefined>,
): boolean {
  return fromDomain(resolveAlertFrom(candidates)) === VERIFIED_SENDER_DOMAIN;
}

/** Validate a recipient address (same deliberately simple shape as feedback). */
export function isValidAlertEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_SHAPE.test(email);
}

export function alertSubject(kind: AlertKind, host: string): string {
  return kind === "downtime"
    ? `SitePulse: ${host} is DOWN`
    : `SitePulse: ${host} is back up`;
}

export interface AlertInput {
  kind: AlertKind;
  url: string;
  host: string;
  /** What the probe observed ("timeout", "http-503", …). */
  reason?: string;
  openedAt: number;
  /** Present for recovery emails. */
  recoveredAt?: number;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function alertText(input: AlertInput): string {
  const lines: string[] = [];
  if (input.kind === "downtime") {
    lines.push(`${input.host} appears to be DOWN.`);
    lines.push("");
    lines.push(`URL:      ${input.url}`);
    lines.push(`Detected: ${formatTime(input.openedAt)}`);
    lines.push(`Reason:   ${input.reason ?? "failed checks"}`);
    lines.push("");
    lines.push(
      "SitePulse confirmed this with consecutive failed checks before alerting you.",
    );
    lines.push(
      "A recovery email follows once the site passes consecutive successful checks.",
    );
  } else {
    lines.push(`${input.host} is back UP.`);
    lines.push("");
    lines.push(`URL:      ${input.url}`);
    lines.push(`Opened:   ${formatTime(input.openedAt)}`);
    lines.push(
      `Recovered:${input.recoveredAt ? ` ${formatTime(input.recoveredAt)}` : " (just now)"}`,
    );
    if (input.recoveredAt) {
      const minutes = Math.max(
        1,
        Math.round((input.recoveredAt - input.openedAt) / 60000),
      );
      lines.push(`Duration: ~${minutes} minute${minutes === 1 ? "" : "s"}`);
    }
  }
  lines.push("");
  lines.push("Manage your monitors in SitePulse → /monitors");
  lines.push("");
  lines.push("You are receiving this because alerts are enabled for this monitor.");
  return lines.join("\n");
}
