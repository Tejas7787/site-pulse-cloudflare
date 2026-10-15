// ── Uptime alert email content ────────────────────────────────────────────────
// Pure builders for the plain-text alert emails. No I/O and no secrets: the
// body contains only the user's own monitor data, so it is safe to store on
// the delivery row and to unit-test.

export type AlertKind = "downtime" | "recovery";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
