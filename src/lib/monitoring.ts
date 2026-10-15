// ── SitePulse uptime monitoring policy ────────────────────────────────────────
// Pure module: interval rules, URL normalization, HTTP/result classification,
// the retry rule and the failure-confirmation state machine. Shared verbatim by
// the Convex scheduler, the probe action and the tests — no I/O, no Convex
// imports, so it can be unit-tested the same way src/lib/scoring.ts is.

/** Allowed check intervals (ms). Creation picks the nearest allowed value. */
export const MONITOR_INTERVALS_MS = [300_000, 900_000, 1_800_000, 3_600_000] as const;
export const MIN_INTERVAL_MS = MONITOR_INTERVALS_MS[0];
export const MAX_INTERVAL_MS = MONITOR_INTERVALS_MS[MONITOR_INTERVALS_MS.length - 1];
export const DEFAULT_INTERVAL_MS = 300_000; // 5 minutes

/** Free-tier guard: 5-min checks ≈ 26k function calls per monitor per month. */
export const MAX_MONITORS_PER_OWNER = 10;
/** Monitors processed per dispatcher run (bounded batch, like scan retention). */
export const DISPATCH_BATCH = 20;

// ── Failure confirmation (false-positive prevention) ──────────────────────────
/** Consecutive failed checks before a monitor is declared down. */
export const FAILURES_TO_DECLARE_DOWN = 2;
/** Consecutive successful checks before a down monitor is declared recovered. */
export const SUCCESSES_TO_RECOVER = 2;

// ── Probe execution ───────────────────────────────────────────────────────────
export const PROBE_TIMEOUT_MS = 8_000;
/** A probe downloads at most this much of the body (a big page still counts as up). */
export const PROBE_MAX_BYTES = 256 * 1024;
export const PROBE_MAX_REDIRECTS = 5;
/** In-action retries, network-level failures only (see shouldRetryProbe). */
export const PROBE_MAX_ATTEMPTS = 2;
export const PROBE_RETRY_BACKOFF_MS = 1_000;
/** Probes are spread across this many ms so checks never synchronize. */
export const MAX_DISPATCH_JITTER_MS = 15_000;
/** Queued alert emails older than this are marked failed instead of retried. */
export const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ProbeResult = "ok" | "down" | "blocked" | "error";
export type MonitorState = "up" | "suspect" | "down" | "unknown";

/** Clamp an arbitrary interval onto the allowed set (nearest, within min/max). */
export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INTERVAL_MS;
  let best: number = MONITOR_INTERVALS_MS[0];
  for (const allowed of MONITOR_INTERVALS_MS) {
    if (Math.abs(allowed - ms) < Math.abs(best - ms)) best = allowed;
  }
  return best;
}

/**
 * Normalize user input into a storable monitor URL. Adds https:// when the
 * scheme is missing and rejects anything that is not http(s) or that carries
 * credentials (a password in a URL is a secret we must never persist).
 */
export function normalizeMonitorUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.hostname.length === 0) return null;
  return parsed.href;
}

/** Lowercased hostname without a trailing dot ("" when the URL is unparseable). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Map an HTTP status onto a probe outcome.
 * 2xx/3xx = up; edge statuses that usually mean "the site is fine but is
 * refusing *us*" (auth wall, bot wall, rate limit, legal block, slow-start)
 * = blocked; every other 4xx (including 404 — the page is gone) and all 5xx
 * = down.
 */
export function classifyHttpStatus(status: number): ProbeResult {
  if (status >= 200 && status < 400) return "ok";
  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 451
  ) {
    return "blocked";
  }
  return "down";
}

export type FetchFailureKind =
  | "invalid"
  | "unsafe"
  | "timeout"
  | "network"
  | "too-large"
  | "redirect-loop";

/** Map a fetchTarget() failure onto an outcome plus a stable detail string. */
export function classifyFetchFailure(
  kind: FetchFailureKind,
): { result: ProbeResult; detail: string } {
  switch (kind) {
    case "timeout":
      return { result: "down", detail: "timeout" };
    case "network":
      return { result: "down", detail: "network-error" };
    case "redirect-loop":
      return { result: "down", detail: "redirect-loop" };
    case "too-large":
      // The server answered — a big body is not downtime (size is capped by
      // PROBE_MAX_BYTES, so this is "responded with more than we read").
      return { result: "ok", detail: "large-response" };
    case "invalid":
      return { result: "error", detail: "invalid-url" };
    case "unsafe":
      return { result: "error", detail: "unsafe-url" };
  }
}

/**
 * Retry only network-level failures, and only once: a timeout or connection
 * error is what a transient blip looks like. HTTP responses are never
 * retried in-action (the N-of-M confirmation across scheduled checks is the
 * false-positive filter), and a policy rejection ("unsafe") is never retried.
 */
export function shouldRetryProbe(
  result: ProbeResult,
  detail: string | undefined,
  attempt: number,
): boolean {
  if (attempt >= PROBE_MAX_ATTEMPTS) return false;
  if (result !== "down") return false;
  return detail === "timeout" || detail === "network-error";
}

export interface MonitorSnapshot {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  hasOpenIncident: boolean;
}

export interface Evaluation {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** "open" = open an incident, "close" = the open incident recovered. */
  incident: "open" | "close" | "none";
  reason?: string;
}

/**
 * Failure-confirmation state machine. Rules:
 * - "ok"   → success counter up, failure counter reset. A down/suspect monitor
 *            needs SUCCESSES_TO_RECOVER consecutive successes to recover.
 * - "down" → failure counter up, success counter reset. A monitor is only
 *            declared down after FAILURES_TO_DECLARE_DOWN consecutive failures
 *            (one blip never pages anyone).
 * - "blocked" / "error" → observation only: a bot wall or an SSRF/config
 *            rejection is NOT evidence that the site is down, so counters and
 *            state are left untouched (recorded in history either way).
 */
export function evaluateResult(
  current: MonitorSnapshot,
  result: ProbeResult,
  detail?: string,
): Evaluation {
  if (result === "ok") {
    const consecutiveSuccesses = current.consecutiveSuccesses + 1;
    const consecutiveFailures = 0;
    const recovering = current.state === "down" || current.state === "suspect";
    if (recovering && consecutiveSuccesses < SUCCESSES_TO_RECOVER) {
      return {
        state: "suspect",
        consecutiveFailures,
        consecutiveSuccesses,
        incident: "none",
      };
    }
    return {
      state: "up",
      consecutiveFailures,
      consecutiveSuccesses,
      incident: current.hasOpenIncident ? "close" : "none",
    };
  }

  if (result === "down") {
    const consecutiveFailures = current.consecutiveFailures + 1;
    const consecutiveSuccesses = 0;
    if (current.state === "down") {
      return { state: "down", consecutiveFailures, consecutiveSuccesses, incident: "none" };
    }
    if (consecutiveFailures >= FAILURES_TO_DECLARE_DOWN) {
      return {
        state: "down",
        consecutiveFailures,
        consecutiveSuccesses,
        incident: current.hasOpenIncident ? "none" : "open",
        reason: detail,
      };
    }
    return {
      state: "suspect",
      consecutiveFailures,
      consecutiveSuccesses,
      incident: "none",
      reason: detail,
    };
  }

  // "blocked" or "error": no state change (see doc comment above).
  return {
    state: current.state,
    consecutiveFailures: current.consecutiveFailures,
    consecutiveSuccesses: current.consecutiveSuccesses,
    incident: "none",
    reason: detail,
  };
}

/**
 * Deterministic per-monitor jitter (0 … MAX_DISPATCH_JITTER_MS-1) so probes
 * never synchronize on the same cron tick. FNV-1a over the monitor id.
 */
export function dispatchJitter(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % MAX_DISPATCH_JITTER_MS;
}

/** Availability in percent to one decimal, or null when nothing was checked. */
export function availabilityPercent(
  results: readonly ProbeResult[],
): number | null {
  if (results.length === 0) return null;
  const up = results.filter((r) => r === "ok").length;
  return Math.round((up / results.length) * 1000) / 10;
}
