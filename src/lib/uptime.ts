// ── SitePulse uptime insights (Phase 8) ──────────────────────────────────────
// Pure module: windowed uptime (7/30 days), response-time trend bucketing,
// incident duration math and human duration formatting. Shared verbatim by
// the Convex insights queries, the monitoring dashboard UI and the tests —
// no I/O, no Convex imports (same pattern as src/lib/monitoring.ts).
//
// Honesty rules encoded here:
//  - A window with no checks yields `null` uptime, never an invented 100%.
//  - A window whose checks cover only a fraction of its span is reported as
//    "partial" alongside the real percentage, so the UI can label it.
//  - Trend buckets with no samples are `null` points, not zeros.

import type { ProbeResult } from "./monitoring";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Windows offered by the dashboard and the insights queries. */
export const UPTIME_WINDOWS_DAYS = [7, 30] as const;
export type UptimeWindowDays = (typeof UPTIME_WINDOWS_DAYS)[number];

/**
 * Below this many checks inside a window we still compute a percentage but
 * flag `insufficient: true` — the UI must label it rather than present it as
 * a reliable figure. Empty windows return `uptime: null` outright.
 */
export const MIN_CHECKS_FOR_RELIABLE_UPTIME = 6;

/**
 * A window counts as "partial" when its checks span less than this fraction
 * of the window (e.g. the monitor was created 3 days ago but the window is 7
 * days). Partial windows still show a percentage, labeled as such.
 */
export const MIN_COVERAGE_FRACTION = 0.9;

/** A check row as this module needs it (structurally matches uptimeChecks). */
export interface WindowCheck {
  checkedAt: number;
  result: ProbeResult;
}

export interface UptimeWindow {
  days: UptimeWindowDays;
  windowStart: number;
  windowEnd: number;
  /** Percent (0–100, one decimal) or null when there are no checks at all. */
  uptime: number | null;
  checks: number;
  /** Fraction (0–1) of the window actually covered by checks. */
  coverage: number;
  /** True when the window is fully covered but has few checks (label it). */
  insufficient: boolean;
  /** True when checks cover less than MIN_COVERAGE_FRACTION of the window. */
  partial: boolean;
}

/**
 * Uptime for a fixed trailing window ending at `now`.
 * "ok" counts as up; down counts against; blocked/error are excluded from the
 * denominator entirely — a bot wall or config rejection is not evidence the
 * site was down (same stance as the failure-confirmation state machine).
 */
export function uptimeWindow(
  checks: readonly WindowCheck[],
  now: number,
  days: UptimeWindowDays,
): UptimeWindow {
  const windowEnd = now;
  const windowStart = now - days * DAY_MS;
  const inWindow = checks.filter((c) => c.checkedAt > windowStart && c.checkedAt <= windowEnd);

  const conclusive = inWindow.filter(
    (c) => c.result === "ok" || c.result === "down",
  );
  const checksInWindow = inWindow.length;

  const coverage = coverageFraction(inWindow, windowStart, windowEnd, days);

  if (checksInWindow === 0) {
    return {
      days,
      windowStart,
      windowEnd,
      uptime: null,
      checks: 0,
      coverage: 0,
      insufficient: true,
      partial: true,
    };
  }

  // No conclusive checks (only blocked/error observations): nothing to compute
  // a ratio from — report null rather than inventing a number.
  if (conclusive.length === 0) {
    return {
      days,
      windowStart,
      windowEnd,
      uptime: null,
      checks: checksInWindow,
      coverage,
      insufficient: true,
      partial: coverage < MIN_COVERAGE_FRACTION,
    };
  }

  const up = conclusive.filter((c) => c.result === "ok").length;
  const uptime = Math.round((up / conclusive.length) * 1000) / 10;
  const partial = coverage < MIN_COVERAGE_FRACTION;
  return {
    days,
    windowStart,
    windowEnd,
    uptime,
    checks: checksInWindow,
    coverage: Math.round(coverage * 100) / 100,
    insufficient: checksInWindow < MIN_CHECKS_FOR_RELIABLE_UPTIME,
    partial,
  };
}

/**
 * How much of the window the checks actually span: from the first check to
 * the last check inside it. A monitor created mid-window (or paused for most
 * of the window) therefore reports partial coverage instead of implying it
 * was watched for the whole window; edges beyond the outermost checks count
 * as uncovered.
 */
function coverageFraction(
  inWindow: readonly WindowCheck[],
  _start: number,
  _end: number,
  days: number,
): number {
  if (inWindow.length === 0) return 0;
  let first = Infinity;
  let last = -Infinity;
  for (const c of inWindow) {
    if (c.checkedAt < first) first = c.checkedAt;
    if (c.checkedAt > last) last = c.checkedAt;
  }
  const spanned = Math.max(0, last - first);
  const total = days * DAY_MS;
  return Math.max(0, Math.min(1, spanned / total));
}

// ── Response-time trends ─────────────────────────────────────────────────────

export interface TrendPoint {
  /** Bucket start (epoch ms). */
  start: number;
  /** Median response time in the bucket, or null when the bucket is empty. */
  medianMs: number | null;
  /** Number of timed checks inside the bucket. */
  samples: number;
}

export interface ResponseTrend {
  days: UptimeWindowDays;
  bucketMs: number;
  points: TrendPoint[];
  /** Total timed samples across the window (0 → UI shows "no data"). */
  samples: number;
}

/** 7-day trend buckets hourly; 30-day trend buckets every 6 hours. */
export function trendBucketMs(days: UptimeWindowDays): number {
  return days === 7 ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
}

interface TimedCheck extends WindowCheck {
  durationMs?: number;
}

/**
 * Median response time per bucket over the trailing window. Buckets with no
 * timed checks get `medianMs: null` so charts show a gap instead of a fake
 * zero. Only checks that carry a duration are sampled (timeouts have none).
 */
export function responseTrend(
  checks: readonly TimedCheck[],
  now: number,
  days: UptimeWindowDays,
): ResponseTrend {
  const bucketMs = trendBucketMs(days);
  const windowStart = now - days * DAY_MS;
  const bucketCount = Math.ceil((days * DAY_MS) / bucketMs);
  const buckets: number[][] = Array.from({ length: bucketCount }, () => []);

  for (const c of checks) {
    if (c.durationMs === undefined || !Number.isFinite(c.durationMs)) continue;
    if (c.checkedAt <= windowStart || c.checkedAt > now) continue;
    const index = Math.min(
      bucketCount - 1,
      Math.floor((c.checkedAt - windowStart) / bucketMs),
    );
    buckets[index].push(c.durationMs);
  }

  const points: TrendPoint[] = buckets.map((values, i) => ({
    start: windowStart + i * bucketMs,
    medianMs: values.length > 0 ? median(values) : null,
    samples: values.length,
  }));

  return {
    days,
    bucketMs,
    points,
    samples: points.reduce((sum, p) => sum + p.samples, 0),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Incident history ─────────────────────────────────────────────────────────

export interface IncidentLike {
  open: boolean;
  openedAt: number;
  closedAt?: number;
  recoveredAt?: number;
}

/**
 * Duration of an incident in ms: closed → recovered − opened; still open →
 * now − opened. Returns null when neither is computable (should not happen
 * with the real state machine, but callers must not crash on it).
 */
export function incidentDurationMs(incident: IncidentLike, now: number): number | null {
  if (incident.open) {
    return now > incident.openedAt ? now - incident.openedAt : null;
  }
  const closed = incident.recoveredAt ?? incident.closedAt;
  if (closed === undefined) return null;
  return Math.max(0, closed - incident.openedAt);
}

/** Compact duration label: "45s", "12m", "3h 04m", "2d 6h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}
