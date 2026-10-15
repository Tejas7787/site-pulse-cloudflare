"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { fetchTarget, detectBlock } from "../lib/fetchTarget";
import { checkUrlSafety } from "../lib/ssrf";
import {
  PROBE_MAX_BYTES,
  PROBE_MAX_REDIRECTS,
  PROBE_RETRY_BACKOFF_MS,
  PROBE_TIMEOUT_MS,
  classifyFetchFailure,
  classifyHttpStatus,
  shouldRetryProbe,
  type ProbeResult,
} from "../lib/monitoring";

// ── The unattended uptime probe ──────────────────────────────────────────────
// Scheduled by monitors.dispatchDue. Reuses the scanner's controlled HTTP
// client (manual redirects, per-hop SSRF assertion, timeout, size cap) and
// block detector, but reads at most PROBE_MAX_BYTES and applies the retry
// rule from src/lib/monitoring.ts. Writes the result through recordCheck(),
// then drains the alert outbox — email is a side effect, so it is enqueued
// first and never allowed to fail the probe.

interface ProbeOutcome {
  result: ProbeResult;
  httpStatus?: number;
  durationMs?: number;
  detail?: string;
  attempt: number;
}

async function runProbe(url: string): Promise<ProbeOutcome> {
  const outcome = await fetchTarget(url, {
    maxRedirects: PROBE_MAX_REDIRECTS,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBytes: PROBE_MAX_BYTES,
    // Re-validated on every redirect hop: a public hostname must not be able
    // to bounce the probe into a private network.
    assertSafe: async (candidate) => {
      const safety = await checkUrlSafety(candidate, { failClosed: true });
      if (!safety.ok) {
        throw new Error("Redirect target is a private or restricted address.");
      }
    },
  });

  if (!outcome.ok) {
    const classified = classifyFetchFailure(outcome.kind);
    return { ...classified, attempt: 1 };
  }

  const { status, durationMs, headerSnapshot, body } = outcome.fetch;
  const classified = classifyHttpStatus(status);
  if (classified === "ok") {
    // A 200 that is actually a bot/challenge page is not "up".
    const block = detectBlock(status, headerSnapshot, body);
    if (block && block.kind === "challenge") {
      return { result: "blocked", httpStatus: status, durationMs, detail: "challenge", attempt: 1 };
    }
    return { result: "ok", httpStatus: status, durationMs, attempt: 1 };
  }
  if (classified === "blocked") {
    return { result: "blocked", httpStatus: status, durationMs, detail: `http-${status}`, attempt: 1 };
  }
  return { result: "down", httpStatus: status, durationMs, detail: `http-${status}`, attempt: 1 };
}

export const probe = internalAction({
  args: {
    monitorId: v.id("monitors"),
    url: v.string(),
    dispatchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    // 1. SSRF before anything leaves the box — fail closed, no request is
    //    made when the destination cannot be proven public.
    const safety = await checkUrlSafety(args.url, { failClosed: true });
    if (!safety.ok) {
      const detail =
        safety.reason === "dns" ? "dns-failed" : `unsafe-${safety.reason}`;
      await ctx.runMutation(internal.monitors.recordCheck, {
        monitorId: args.monitorId,
        dispatchedAt: args.dispatchedAt,
        checkedAt: Date.now(),
        result: "error",
        detail,
        attempt: 1,
      });
      return { result: "error" as const, detail };
    }

    // 2. Probe, retrying network-level failures once with a short backoff.
    let outcome = await runProbe(args.url);
    while (shouldRetryProbe(outcome.result, outcome.detail, outcome.attempt)) {
      await new Promise((resolve) =>
        setTimeout(resolve, PROBE_RETRY_BACKOFF_MS * outcome.attempt),
      );
      outcome = { ...await runProbe(args.url), attempt: outcome.attempt + 1 };
    }

    // 3. Persist through the state machine (may open/close an incident).
    const record = await ctx.runMutation(internal.monitors.recordCheck, {
      monitorId: args.monitorId,
      dispatchedAt: args.dispatchedAt,
      checkedAt: Date.now(),
      result: outcome.result,
      ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
      ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      attempt: outcome.attempt,
    });

    // 4. Alerts: enqueue idempotently, then try to send the outbox. Email
    //    failures must never fail the probe — rows stay queued for the next
    //    probe (5+ minutes later) until ALERT_MAX_AGE_MS expires them.
    if (record && !record.stale && record.events.length > 0) {
      const host = new URL(args.url).hostname;
      try {
        for (const event of record.events) {
          await ctx.runMutation(internal.alerts.enqueue, {
            monitorId: args.monitorId,
            incidentId: event.incidentId,
            kind: event.kind,
            url: args.url,
            host,
            openedAt: event.openedAt,
            ...(event.recoveredAt !== undefined ? { recoveredAt: event.recoveredAt } : {}),
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
          });
        }
        await ctx.runAction(internal.alerts.sendQueued, {});
      } catch (err) {
        console.warn("[probe] alert delivery skipped:", String(err).slice(0, 200));
      }
    }

    return { result: outcome.result, attempt: outcome.attempt };
  },
});
