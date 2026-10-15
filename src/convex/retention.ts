// ── Scan retention rules ─────────────────────────────────────────────────────
// Single source of truth for how long saved scan reports are kept. Pure module:
// safe to import from Convex functions, from tests, and from app code.

/**
 * Days a saved scan report is kept before automatic deletion.
 * The public copy (Privacy Policy, Report page) must state the same number.
 */
export const SCAN_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms; scans with `scannedAt` strictly before this are expired. */
export function scanRetentionCutoff(now: number): number {
  return now - SCAN_RETENTION_DAYS * DAY_MS;
}

// ── Uptime monitoring retention rules ────────────────────────────────────────
// Phase 2 (automatic uptime monitoring) keeps three kinds of rows. Raw probe
// history is short-lived (it is the bulk of the writes), incidents are the
// product's long-term record, and undelivered alert emails are only worth
// keeping briefly.

/** Days of raw probe history (uptimeChecks) kept before automatic deletion. */
export const UPTIME_CHECK_RETENTION_DAYS = 30;
/** Days incidents are kept — the availability record users build on. */
export const INCIDENT_RETENTION_DAYS = 365;
/** Days alert delivery rows are kept for audit/diagnostics. */
export const ALERT_RETENTION_DAYS = 90;

export function uptimeCheckRetentionCutoff(now: number): number {
  return now - UPTIME_CHECK_RETENTION_DAYS * DAY_MS;
}

export function incidentRetentionCutoff(now: number): number {
  return now - INCIDENT_RETENTION_DAYS * DAY_MS;
}

export function alertRetentionCutoff(now: number): number {
  return now - ALERT_RETENTION_DAYS * DAY_MS;
}

/** A scan document is expired once its server-side `scannedAt` predates the cutoff. */
export function isScanExpired(scannedAt: number, now: number): boolean {
  return scannedAt < scanRetentionCutoff(now);
}
