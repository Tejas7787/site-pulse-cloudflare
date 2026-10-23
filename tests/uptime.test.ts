// Phase 8 uptime-insights tests: windowed uptime (7/30 days), coverage and
// insufficient-data labeling, response-time trend bucketing, incident
// duration and formatting. Pure math in src/lib/uptime.ts so the dashboard
// and Convex queries can never show a metric these tests forbid.

import { describe, expect, test } from "bun:test";
import {
  MIN_CHECKS_FOR_RELIABLE_UPTIME,
  MIN_COVERAGE_FRACTION,
  UPTIME_WINDOWS_DAYS,
  formatDuration,
  incidentDurationMs,
  responseTrend,
  trendBucketMs,
  uptimeWindow,
  type WindowCheck,
} from "../src/lib/uptime";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// A fixed "now" so window math is deterministic.
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

/** Evenly-spaced checks across the whole window (fully covered). */
function fullWindow(days: number, result: WindowCheck["result"]): WindowCheck[] {
  const count = (days * DAY) / HOUR;
  return Array.from({ length: count }, (_, i) => ({
    checkedAt: NOW - days * DAY + i * HOUR + HOUR,
    result,
  }));
}

describe("uptimeWindow", () => {
  test("windows are 7 and 30 days", () => {
    expect(UPTIME_WINDOWS_DAYS).toEqual([7, 30]);
  });

  test("an empty window yields null uptime, never an invented 100%", () => {
    const w = uptimeWindow([], NOW, 7);
    expect(w.uptime).toBeNull();
    expect(w.checks).toBe(0);
    expect(w.insufficient).toBe(true);
    expect(w.partial).toBe(true);
    expect(w.coverage).toBe(0);
  });

  test("all-ok full window reports 100 with full coverage", () => {
    const w = uptimeWindow(fullWindow(7, "ok"), NOW, 7);
    expect(w.uptime).toBe(100);
    expect(w.insufficient).toBe(false);
    expect(w.partial).toBe(false);
    expect(w.coverage).toBeGreaterThanOrEqual(MIN_COVERAGE_FRACTION);
  });

  test("downtime counts against uptime, one decimal rounding", () => {
    const checks = fullWindow(7, "ok");
    // Turn one in five conclusive checks into a failure.
    for (let i = 0; i < checks.length; i += 5) checks[i] = { ...checks[i], result: "down" };
    const w = uptimeWindow(checks, NOW, 7);
    expect(w.uptime).not.toBeNull();
    expect(w.uptime!).toBeLessThan(100);
    expect(w.uptime!).toBeGreaterThanOrEqual(79);
    // One decimal place at most.
    expect(Math.round(w.uptime! * 10) / 10).toBe(w.uptime!);
  });

  test("blocked/error observations are excluded from the denominator", () => {
    // 10 ok + 10 blocked → blocked are not evidence of downtime → 100%.
    const checks: WindowCheck[] = [
      ...fullWindow(7, "ok").slice(0, 10),
      ...Array.from({ length: 10 }, (_, i) => ({
        checkedAt: NOW - 10 * HOUR + i * HOUR,
        result: "blocked" as const,
      })),
    ];
    const w = uptimeWindow(checks, NOW, 7);
    expect(w.uptime).toBe(100);
    expect(w.insufficient).toBe(false);
    // The ok checks sit at the head of the window and the blocked ones at the
    // tail, so the outermost observations still span (nearly) all 7 days.
    expect(w.partial).toBe(false);
  });

  test("a window with only blocked/error checks reports null, not 100 or 0", () => {
    const checks: WindowCheck[] = Array.from({ length: 24 }, (_, i) => ({
      checkedAt: NOW - 24 * HOUR + i * HOUR,
      result: "blocked" as const,
    }));
    const w = uptimeWindow(checks, NOW, 7);
    expect(w.uptime).toBeNull();
    expect(w.insufficient).toBe(true);
    expect(w.checks).toBe(24);
  });

  test("checks outside the window are ignored", () => {
    const old: WindowCheck[] = [
      { checkedAt: NOW - 31 * DAY, result: "down" }, // before the 30-day window
      { checkedAt: NOW + DAY, result: "down" }, // in the future: also excluded
    ];
    const w = uptimeWindow(old, NOW, 30);
    expect(w.checks).toBe(0);
    expect(w.uptime).toBeNull();
  });

  test("a monitor created mid-window is flagged partial, not silently averaged", () => {
    // Checks only over the last 2 days of a 7-day window.
    const checks: WindowCheck[] = Array.from({ length: 48 }, (_, i) => ({
      checkedAt: NOW - 2 * DAY + i * HOUR + HOUR,
      result: "ok" as const,
    }));
    const w = uptimeWindow(checks, NOW, 7);
    expect(w.uptime).toBe(100);
    expect(w.partial).toBe(true);
    expect(w.coverage).toBeLessThan(0.5);
  });

  test("few checks in a fully covered window flag insufficient", () => {
    // Exactly MIN_CHECKS_FOR_RELIABLE_UPTIME - 1 checks, deliberately placed
    // from the very start to the very end of the window (full coverage).
    const n = MIN_CHECKS_FOR_RELIABLE_UPTIME - 1;
    const checks: WindowCheck[] = Array.from({ length: n }, (_, i) => ({
      checkedAt: NOW - 7 * DAY + 60_000 + (i * (7 * DAY - 120_000)) / (n - 1),
      result: "ok" as const,
    }));
    const w = uptimeWindow(checks, NOW, 7);
    expect(w.uptime).toBe(100);
    expect(w.insufficient).toBe(true);
    expect(w.partial).toBe(false); // coverage spans the window
  });

  test("30-day window computes over its own span", () => {
    const checks = [...fullWindow(7, "ok"), ...Array.from({ length: 20 * 24 }, (_, i) => ({
      checkedAt: NOW - 27 * DAY + i * HOUR + HOUR,
      result: "ok" as const,
    }))];
    const w = uptimeWindow(checks, NOW, 30);
    expect(w.uptime).toBe(100);
    expect(w.days).toBe(30);
    expect(w.windowStart).toBe(NOW - 30 * DAY);
  });
});

describe("responseTrend", () => {
  test("bucket sizes: hourly for 7 days, 6-hourly for 30 days", () => {
    expect(trendBucketMs(7)).toBe(HOUR);
    expect(trendBucketMs(30)).toBe(6 * HOUR);
  });

  test("empty window yields zero samples and null points", () => {
    const t = responseTrend([], NOW, 7);
    expect(t.samples).toBe(0);
    expect(t.points).toHaveLength((7 * DAY) / HOUR);
    expect(t.points.every((p) => p.medianMs === null)).toBe(true);
  });

  test("medians are computed per bucket and empty buckets stay null", () => {
    const windowStart = NOW - 7 * DAY;
    const checks = [
      { checkedAt: windowStart + 10 * 60 * 1000, result: "ok" as const, durationMs: 100 },
      { checkedAt: windowStart + 20 * 60 * 1000, result: "ok" as const, durationMs: 300 },
      { checkedAt: windowStart + 30 * 60 * 1000, result: "ok" as const, durationMs: 200 },
      // Next bucket (index 1): single sample.
      { checkedAt: windowStart + HOUR + 5 * 60 * 1000, result: "ok" as const, durationMs: 500 },
    ];
    const t = responseTrend(checks, NOW, 7);
    expect(t.samples).toBe(4);
    expect(t.points[0].medianMs).toBe(200);
    expect(t.points[0].samples).toBe(3);
    expect(t.points[1].medianMs).toBe(500);
    expect(t.points[2].medianMs).toBeNull(); // gap stays a gap
    expect(t.points[2].samples).toBe(0);
  });

  test("checks without a duration (timeouts) are not sampled", () => {
    const windowStart = NOW - 7 * DAY;
    const t = responseTrend(
      [
        { checkedAt: windowStart + HOUR + 2000, result: "down" as const }, // timeout: no duration
        { checkedAt: windowStart + HOUR + 1000, result: "ok" as const, durationMs: 120 },
      ],
      NOW,
      7,
    );
    expect(t.samples).toBe(1);
    // Both land in bucket index 1 (windowStart + 1h .. 2h).
    expect(t.points[1].medianMs).toBe(120);
    expect(t.points[1].samples).toBe(1);
    expect(t.points[0].samples).toBe(0);
  });

  test("checks outside the window are excluded", () => {
    const t = responseTrend(
      [{ checkedAt: NOW - 10 * DAY, result: "ok" as const, durationMs: 50 }],
      NOW,
      7,
    );
    expect(t.samples).toBe(0);
  });
});

describe("incidentDurationMs", () => {
  const openedAt = NOW - 90 * 60 * 1000;

  test("open incidents measure from openedAt to now", () => {
    expect(incidentDurationMs({ open: true, openedAt }, NOW)).toBe(90 * 60 * 1000);
  });

  test("closed incidents prefer recoveredAt over closedAt", () => {
    expect(
      incidentDurationMs(
        { open: false, openedAt, closedAt: openedAt + 1000, recoveredAt: openedAt + 60_000 },
        NOW,
      ),
    ).toBe(60_000);
  });

  test("closed incidents fall back to closedAt", () => {
    expect(incidentDurationMs({ open: false, openedAt, closedAt: openedAt + 45_000 }, NOW)).toBe(
      45_000,
    );
  });

  test("no close time at all yields null instead of a wrong number", () => {
    expect(incidentDurationMs({ open: false, openedAt }, NOW)).toBeNull();
  });

  test("an open incident never returns a negative duration", () => {
    expect(incidentDurationMs({ open: true, openedAt: NOW + 60_000 }, NOW)).toBeNull();
  });
});

describe("formatDuration", () => {
  test("seconds, minutes, hours and days render compactly", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(3 * HOUR + 4 * 60_000)).toBe("3h 04m");
    expect(formatDuration(2 * DAY + 6 * HOUR)).toBe("2d 6h");
  });

  test("invalid input renders an em dash, never NaN", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
