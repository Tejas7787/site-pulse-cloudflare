// Phase 2 regression tests: uptime policy, confirmation state machine, retry
// rule and scheduler wiring. Pure logic lives in src/lib/monitoring.ts so it
// can be tested exactly the way src/lib/scoring.ts is.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FAILURES_TO_DECLARE_DOWN,
  MAX_DISPATCH_JITTER_MS,
  MONITOR_INTERVALS_MS,
  PROBE_MAX_ATTEMPTS,
  SUCCESSES_TO_RECOVER,
  availabilityPercent,
  clampInterval,
  classifyFetchFailure,
  classifyHttpStatus,
  dispatchJitter,
  evaluateResult,
  hostOf,
  normalizeMonitorUrl,
  shouldRetryProbe,
  type MonitorSnapshot,
} from "../src/lib/monitoring";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const snapshot = (over: Partial<MonitorSnapshot> = {}): MonitorSnapshot => ({
  state: "unknown",
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  hasOpenIncident: false,
  ...over,
});

describe("monitor configuration", () => {
  test("intervals clamp onto the allowed set", () => {
    expect(clampInterval(MONITOR_INTERVALS_MS[0])).toBe(300_000);
    expect(clampInterval(120_000)).toBe(300_000);
    expect(clampInterval(700_000)).toBe(900_000);
    expect(clampInterval(9_999_999)).toBe(3_600_000);
    expect(clampInterval(Number.NaN)).toBe(300_000);
  });

  test("URL normalization adds https, keeps paths and rejects credentials", () => {
    expect(normalizeMonitorUrl("example.com")).toBe("https://example.com/");
    expect(normalizeMonitorUrl(" https://example.com/a?b=1 ")).toBe(
      "https://example.com/a?b=1",
    );
    expect(normalizeMonitorUrl("https://user:pass@example.com")).toBeNull();
    expect(normalizeMonitorUrl("")).toBeNull();
    expect(normalizeMonitorUrl("   ")).toBeNull();
    expect(normalizeMonitorUrl("javascript:alert(1)")).toBeNull();
  });

  test("hostOf lowercases and drops a trailing dot", () => {
    expect(hostOf("https://Example.COM./x")).toBe("example.com");
    expect(hostOf("not a url")).toBe("");
  });
});

describe("HTTP and fetch classification", () => {
  test("2xx/3xx are up", () => {
    for (const status of [200, 201, 204, 301, 302, 399]) {
      expect(classifyHttpStatus(status)).toBe("ok");
    }
  });

  test("wall statuses are blocked, not down", () => {
    for (const status of [401, 403, 408, 425, 429, 451]) {
      expect(classifyHttpStatus(status)).toBe("blocked");
    }
  });

  test("missing pages and server errors are down", () => {
    for (const status of [400, 404, 410, 500, 502, 503]) {
      expect(classifyHttpStatus(status)).toBe("down");
    }
  });

  test("fetch failures map to honest outcomes", () => {
    expect(classifyFetchFailure("timeout")).toEqual({ result: "down", detail: "timeout" });
    expect(classifyFetchFailure("network")).toEqual({
      result: "down",
      detail: "network-error",
    });
    expect(classifyFetchFailure("redirect-loop")).toEqual({
      result: "down",
      detail: "redirect-loop",
    });
    // The server answered — a big body is not downtime.
    expect(classifyFetchFailure("too-large")).toEqual({
      result: "ok",
      detail: "large-response",
    });
    expect(classifyFetchFailure("unsafe")).toEqual({
      result: "error",
      detail: "unsafe-url",
    });
    expect(classifyFetchFailure("invalid")).toEqual({
      result: "error",
      detail: "invalid-url",
    });
  });
});

describe("retry rule", () => {
  test("only network-level failures are retried, and only once", () => {
    expect(PROBE_MAX_ATTEMPTS).toBe(2);
    expect(shouldRetryProbe("down", "timeout", 1)).toBe(true);
    expect(shouldRetryProbe("down", "network-error", 1)).toBe(true);
    expect(shouldRetryProbe("down", "timeout", 2)).toBe(false); // attempt cap
    expect(shouldRetryProbe("down", "http-503", 1)).toBe(false); // HTTP answers are confirmed across checks instead
    expect(shouldRetryProbe("ok", undefined, 1)).toBe(false);
    expect(shouldRetryProbe("error", "unsafe-url", 1)).toBe(false); // never retry a policy rejection
    expect(shouldRetryProbe("blocked", "http-429", 1)).toBe(false);
  });
});

describe("failure confirmation state machine", () => {
  test("policy constants are locked", () => {
    expect(FAILURES_TO_DECLARE_DOWN).toBe(2);
    expect(SUCCESSES_TO_RECOVER).toBe(2);
  });

  test("one failed check only raises a suspect — no incident", () => {
    const next = evaluateResult(snapshot({ state: "up" }), "down", "timeout");
    expect(next.state).toBe("suspect");
    expect(next.consecutiveFailures).toBe(1);
    expect(next.incident).toBe("none");
  });

  test("two consecutive failures open exactly one incident", () => {
    const first = evaluateResult(snapshot({ state: "up" }), "down", "timeout");
    const second = evaluateResult(
      snapshot({ ...first, state: first.state }),
      "down",
      "timeout",
    );
    expect(second.state).toBe("down");
    expect(second.incident).toBe("open");

    const third = evaluateResult(
      snapshot({ ...second, hasOpenIncident: true }),
      "down",
      "http-500",
    );
    expect(third.state).toBe("down");
    expect(third.incident).toBe("none"); // never a second incident for the same outage
  });

  test("a recovered monitor needs two successes before it is up", () => {
    const down = snapshot({ state: "down", consecutiveFailures: 3, hasOpenIncident: true });
    const first = evaluateResult(down, "ok");
    expect(first.state).toBe("suspect");
    expect(first.incident).toBe("none"); // one good check could be a blip

    const second = evaluateResult(
      snapshot({ ...first, hasOpenIncident: true }),
      "ok",
    );
    expect(second.state).toBe("up");
    expect(second.incident).toBe("close");
    expect(second.consecutiveFailures).toBe(0);
  });

  test("recovery without an open incident never emits close", () => {
    const next = evaluateResult(snapshot({ state: "up" }), "ok");
    expect(next.incident).toBe("none");
  });

  test("a second outage while still down does not reopen an incident", () => {
    const down = snapshot({ state: "down", consecutiveFailures: 2, hasOpenIncident: true });
    const next = evaluateResult(down, "down", "http-503");
    expect(next.incident).toBe("none");
    expect(next.consecutiveFailures).toBe(3);
  });

  test("blocked (bot wall) and error (SSRF/config) never change state", () => {
    const up = snapshot({ state: "up", consecutiveSuccesses: 4 });
    const afterBlocked = evaluateResult(up, "blocked", "challenge");
    expect(afterBlocked.state).toBe("up");
    expect(afterBlocked.consecutiveSuccesses).toBe(4);
    expect(afterBlocked.incident).toBe("none");

    const afterError = evaluateResult(afterBlocked, "error", "unsafe-url");
    expect(afterError.state).toBe("up");
    expect(afterError.consecutiveSuccesses).toBe(4);
    expect(afterError.incident).toBe("none");
  });

  test("a blocked observation does not mask a real failure streak", () => {
    const suspect = snapshot({ state: "suspect", consecutiveFailures: 1 });
    const afterBlocked = evaluateResult(suspect, "blocked", "http-429");
    expect(afterBlocked.consecutiveFailures).toBe(1);
    const next = evaluateResult(snapshot({ ...afterBlocked }), "down", "timeout");
    expect(next.state).toBe("down");
    expect(next.incident).toBe("open");
  });
});

describe("jitter and availability", () => {
  test("jitter is deterministic and inside the window", () => {
    const a = dispatchJitter("monitor-abc");
    expect(dispatchJitter("monitor-abc")).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(MAX_DISPATCH_JITTER_MS);
  });

  test("availability is percent to one decimal", () => {
    expect(availabilityPercent([])).toBeNull();
    expect(availabilityPercent(["ok", "ok", "down"])).toBe(66.7);
    expect(availabilityPercent(["ok", "ok"])).toBe(100);
  });
});

describe("scheduler wiring", () => {
  test("crons dispatch due monitors every minute and sweep retention hourly", () => {
    const crons = read("src/convex/crons.ts");
    expect(crons).toContain("dispatch due uptime monitors");
    expect(crons).toContain("internal.monitors.dispatchDue");
    expect(crons).toContain("delete expired uptime data");
    expect(crons).toContain("internal.monitors.deleteExpiredUptimeData");
  });

  test("dispatcher advances nextCheckAt before scheduling (no double probes)", () => {
    const monitors = read("src/convex/monitors.ts");
    expect(monitors).toContain("nextCheckAt: now + monitor.intervalMs");
    expect(monitors).toContain("internal.probe.probe");
    expect(monitors).toContain("dispatchedHosts.has(monitor.host)");
  });

  test("probe fails closed on SSRF and revalidates every redirect hop", () => {
    const probe = read("src/convex/probe.ts");
    expect(probe).toContain('checkUrlSafety(args.url, { failClosed: true })');
    expect(probe).toContain("Redirect target is a private or restricted address");
    expect(probe).toContain("internal.alerts.enqueue");
    expect(probe).toContain("internal.alerts.sendQueued");
  });

  test("alerts are enqueued idempotently before being sent", () => {
    const alerts = read("src/convex/alerts.ts");
    expect(alerts).toContain("by_incident_kind");
    expect(alerts).toContain("RESEND_API_KEY");
    // The key is read from the environment and never interpolated into output.
    expect(alerts).not.toContain("RESEND_API_KEY=");
  });
});

// The live site once served a stale bundle whose route table had no
// /monitors entry, so deep links hit the catch-all 404 and the dashboard had
// no Monitoring entry point. These tests pin the wiring so a regression is
// caught in CI instead of on production.
describe("monitoring navigation wiring", () => {
  test("router registers /monitors behind RequireAuth, before the catch-all", () => {
    const main = read("src/main.tsx");
    const routeIdx = main.indexOf('path="/monitors"');
    expect(routeIdx).toBeGreaterThan(-1);
    // The route element must be wrapped in RequireAuth…
    const routeBlock = main.slice(routeIdx, routeIdx + 250);
    expect(routeBlock).toContain("<RequireAuth>");
    expect(routeBlock).toContain("<Monitors />");
    // …and the catch-all 404 must come after it, or /monitors would 404.
    expect(main.indexOf('path="*"')).toBeGreaterThan(routeIdx);
    // The Monitors page is lazy-loaded like every other route.
    expect(main).toContain('lazy(() => import("./pages/Monitors.tsx"))');
  });

  test("logged-in dashboard exposes a Monitoring option that opens /monitors", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    // Header nav entry…
    expect(dashboard).toContain('to="/monitors"');
    expect(dashboard).toMatch(/>\s*Monitoring\s*</);
    // …and the feature card's call-to-action.
    expect(dashboard).toContain('navigate("/monitors")');
  });

  test("host rewrites unknown paths to index.html so deep links reach the SPA", () => {
    // Netlify / Cloudflare Pages (_redirects) and the Vite dev/preview server
    // (appType: 'spa' is Vite's default) must both fall back to index.html,
    // otherwise a direct visit to /monitors never boots the app at all.
    const redirects = read("public/_redirects");
    expect(redirects).toContain("/*    /index.html   200");
  });
});

// Phase 2 dashboard UX: the monitoring section must explain what the feature
// does, guide new users to their first monitor and alerts, and display ONLY
// the limit the backend actually enforces — MAX_MONITORS_PER_OWNER, the
// constant createMonitor throws on — never a hand-typed number or an
// unbacked browser global.
describe("dashboard monitoring UX", () => {
  test("the monitoring section explains checks, incidents, recovery and alerts", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toContain("Automated uptime checks");
    expect(dashboard).toContain("downtime incident tracking");
    expect(dashboard).toContain("recovery detection");
    expect(dashboard).toContain("email alerts");
    // Honest confirmation rules, matching FAILURES_TO_DECLARE_DOWN (2) and
    // SUCCESSES_TO_RECOVER (2) in src/lib/monitoring.ts.
    expect(dashboard).toContain("two consecutive failed checks");
    expect(dashboard).toContain("two consecutive successful checks");
  });

  test("a Getting started guide covers adding a monitor and configuring alerts", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toContain("Getting started");
    expect(dashboard).toContain('title: "Open Monitoring"');
    expect(dashboard).toContain('title: "Add your website URL"');
    expect(dashboard).toContain('title: "Choose a check interval"');
    expect(dashboard).toContain('title: "Configure alerts"');
    // The alert email is optional and falls back to the account address
    // (the Monitors.tsx input placeholder uses user.email).
    expect(dashboard).toContain("defaults to your account address");
  });

  test("the primary Open Monitoring CTA and header both target /monitors, with imports intact", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toContain('navigate("/monitors")');
    expect(dashboard).toContain('to="/monitors"');
    // A previous draft called useNavigate() without importing it.
    expect(dashboard).toContain('import { Link, useNavigate } from "react-router"');
  });

  test("the displayed free-monitor limit is the enforced constant, shown once", () => {
    const dashboard = read("src/pages/Dashboard.tsx");
    expect(dashboard).toContain("MAX_MONITORS_PER_OWNER");
    expect(dashboard).not.toContain("up to 10 monitors");
    // Exactly one free-plan notice — an earlier draft repeated it five times.
    expect(dashboard.split("Free plan:").length - 1).toBe(1);
    // The Monitors page helper text shows the same constant, not a literal.
    const monitors = read("src/pages/Monitors.tsx");
    expect(monitors).toContain("MAX_MONITORS_PER_OWNER");
    expect(monitors).not.toContain("up to 10 monitors");
  });

  test("the landing page reads the same constant instead of unbacked globals", () => {
    const landing = read("src/pages/Landing.tsx");
    expect(landing).toContain("MAX_MONITORS_PER_OWNER");
    // The broken fetch/localStorage shim and window.sitePulse read are gone.
    expect(landing).not.toContain("getFreeMonitorLimit");
    expect(landing).not.toContain("sitePulse.freeMonitorLimit");
    expect(landing).not.toContain("sp_free_monitor_limit");
    expect(landing).not.toContain("up to 10 monitors");
  });

  test("the limit query and the creation gate share one source of truth", () => {
    const users = read("src/convex/users.ts");
    expect(users).toContain("MAX_MONITORS_PER_OWNER");
    expect(users).not.toContain("limit: 10");
    const monitors = read("src/convex/monitors.ts");
    // The gate counts owned monitors against MAX_MONITORS_PER_OWNER + 1…
    expect(monitors).toContain("MAX_MONITORS_PER_OWNER + 1");
    // …and its error message interpolates the same constant.
    expect(monitors).toContain("Free plan limit: ${MAX_MONITORS_PER_OWNER}");
  });

  test("RequireAuth still guards the monitoring route via /auth?returnTo=", () => {
    const guard = read("src/components/RequireAuth.tsx");
    expect(guard).toContain("isAuthenticated");
    expect(guard).toContain("/auth?returnTo=");
    expect(guard).toContain("encodeURIComponent(returnTo)");
    const main = read("src/main.tsx");
    const routeIdx = main.indexOf('path="/monitors"');
    expect(routeIdx).toBeGreaterThan(-1);
    expect(main.slice(routeIdx, routeIdx + 250)).toContain("<RequireAuth>");
  });
});
