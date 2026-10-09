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

/** A scan document is expired once its server-side `scannedAt` predates the cutoff. */
export function isScanExpired(scannedAt: number, now: number): boolean {
  return scannedAt < scanRetentionCutoff(now);
}
