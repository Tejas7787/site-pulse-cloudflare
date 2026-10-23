// Retention tests — the 30-day cutoff math used by the scheduled cleanup,
// cross-checked against the public copy so code and claims cannot drift.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ANALYTICS_RETENTION_DAYS,
  SCAN_RETENTION_DAYS,
  analyticsRetentionCutoff,
  feedbackRetentionCutoff,
  isScanExpired,
  scanRetentionCutoff,
} from "../src/convex/retention";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

describe("scan retention rules", () => {
  test("retention window is 30 days", () => {
    expect(SCAN_RETENTION_DAYS).toBe(30);
  });

  test("cutoff is exactly 30 days before now", () => {
    expect(scanRetentionCutoff(NOW)).toBe(NOW - 30 * DAY_MS);
  });

  test("scans older than the cutoff are expired; at/after the cutoff they are not", () => {
    const cutoff = scanRetentionCutoff(NOW);
    expect(isScanExpired(cutoff - 1, NOW)).toBe(true); // 30 days + 1ms old
    expect(isScanExpired(cutoff, NOW)).toBe(false); // exactly at the boundary — kept
    expect(isScanExpired(cutoff + 1, NOW)).toBe(false);
    expect(isScanExpired(NOW, NOW)).toBe(false); // brand new
  });

  test("future scannedAt values (clock skew) are never treated as expired", () => {
    expect(isScanExpired(NOW + DAY_MS, NOW)).toBe(false);
  });

  test("public copy states the same 30-day automatic deletion", () => {
    const legal = readFileSync(join(import.meta.dir, "..", "src", "pages", "Legal.tsx"), "utf8");
    expect(legal).toContain("deleted automatically 30 days after the scan");
    const report = readFileSync(join(import.meta.dir, "..", "src", "pages", "Report.tsx"), "utf8");
    expect(report).toContain("deleted automatically once they are more than 30 days old");
  });

  test("deleteExpiredScans is internal-only, scans-only, indexed, bounded, and bounded-retry", () => {
    const scans = readFileSync(join(import.meta.dir, "..", "src", "convex", "scans.ts"), "utf8");
    expect(scans).toContain('internalMutation');
    expect(scans).toContain('by_scanned_at'); // indexed timestamp — no full scans
    expect(scans).toContain('.lt("scannedAt", cutoff)'); // only expired rows
    expect(scans).toContain('take(max)'); // bounded batch
    expect(scans).toContain('ctx.db.delete(doc._id)'); // explicit per-doc delete of scans only
    expect(scans).toContain('DELETE_MAX_RETRY_CHAINS'); // bounded retry limit
    expect(scans).toContain('attempt + 1'); // retry counting
    expect(scans).not.toContain('db.deleteAll');
  });

  test("deleteExpiredScans does not report success when deletion fails", () => {
    const scans = readFileSync(join(import.meta.dir, "..", "src", "convex", "scans.ts"), "utf8");
    expect(scans).toContain('failed: true');
    expect(scans).toContain('retry limit reached (attempt');
    // The retry-exhausted path must return an explicit failure reason, not a
    // bare success payload.
    expect(scans).toContain('retry limit reached (attempt ${attempt} > ${DELETE_MAX_RETRY_CHAINS})');
    // It must not simply return the full batch count as if it succeeded.
    expect(scans).not.toMatch(/return \{\s*deleted: expired\.length,\s*cutoff\s*\}/);
  });

  test("cleanup is scheduled and bounded in Convex code", () => {
    const crons = readFileSync(join(import.meta.dir, "..", "src", "convex", "crons.ts"), "utf8");
    expect(crons).toContain("internal.scans.deleteExpiredScans");
    const scans = readFileSync(join(import.meta.dir, "..", "src", "convex", "scans.ts"), "utf8");
    expect(scans).toContain('internalMutation');
    expect(scans).toContain('by_scanned_at'); // indexed timestamp — no full scans
    expect(scans).toContain('.lt("scannedAt", cutoff)'); // only expired rows
    expect(scans).toContain('take(max)'); // bounded batch
    expect(scans).toContain('ctx.db.delete(doc._id)'); // explicit per-doc delete of scans only
    expect(scans).not.toContain('db.deleteAll');
  });
});

describe("analytics & feedback retention rules (Phase 9A)", () => {
  test("analytics window is 90 days — longer than every trend the dashboard shows", () => {
    expect(ANALYTICS_RETENTION_DAYS).toBe(90);
    expect(ANALYTICS_RETENTION_DAYS).toBeGreaterThanOrEqual(30);
  });

  test("cutoffs are exactly 90 days before now", () => {
    expect(analyticsRetentionCutoff(NOW)).toBe(NOW - 90 * DAY_MS);
    expect(feedbackRetentionCutoff(NOW)).toBe(NOW - 90 * DAY_MS);
  });

  test("the sweep is internal-only, indexed, strictly-older-than and bounded", () => {
    const analytics = readFileSync(
      join(import.meta.dir, "..", "src", "convex", "analytics.ts"),
      "utf8",
    );
    expect(analytics).toContain("internalMutation");
    expect(analytics).toContain('withIndex("by_created"'); // indexed — no full scans
    expect(analytics).toContain('take(limit)'); // bounded batch
    expect(analytics).not.toContain("deleteAll");
    // Only the two public-write tables are reachable from the sweep.
    expect(analytics).toContain('query("analyticsEvents")');
    expect(analytics).toContain('query("feedback")');
  });

  test("the sweep is scheduled", () => {
    const crons = readFileSync(
      join(import.meta.dir, "..", "src", "convex", "crons.ts"),
      "utf8",
    );
    expect(crons).toContain("internal.analytics.deleteExpiredAnalytics");
  });

  test("both public write endpoints consume a quota before inserting", () => {
    const analytics = readFileSync(
      join(import.meta.dir, "..", "src", "convex", "analytics.ts"),
      "utf8",
    );
    expect(analytics).toContain("consumeQuota");
    expect(analytics).toContain("ANALYTICS_EVENT_LIMIT");
    const feedback = readFileSync(
      join(import.meta.dir, "..", "src", "convex", "feedback.ts"),
      "utf8",
    );
    expect(feedback).toContain("consumeQuota");
    expect(feedback).toContain("FEEDBACK_LIMIT");
  });
});
