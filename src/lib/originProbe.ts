// ── SitePulse origin probes (robots.txt / sitemap.xml) ───────────────────────
// These are the two small side requests a scan makes after the main fetch.
// They previously called fetch() with `redirect: "follow"`, which applied NO
// SSRF policy to the redirect chain: a scanned host could answer
// /robots.txt with a 302 into localhost, a private range or a link-local
// metadata address, and the resulting HTTP status was written into report
// evidence — a status-code oracle against destinations the scanner must never
// touch. Both probes now go through the same controlled client as the main
// fetch and the uptime probe:
//
//   - redirects are followed MANUALLY (never automatically), so every
//     destination is an explicit hop;
//   - the project SSRF policy (checkUrlSafety: scheme + port allowlist,
//     IP-literal normalization, internal hostnames, fail-closed DNS where ANY
//     private answer disqualifies the host) runs on the INITIAL url and on
//     EVERY hop — identical wording/behaviour to scan.ts's main fetch and
//     probe.ts's uptime probe;
//   - the response BODY of the final answer is never read, so a probe cannot
//     buffer, size or leak internal content;
//   - a refused/failed probe returns `{ kind: "unavailable" }` — deliberately
//     NO status field — so blocked destinations cannot surface in report
//     evidence at all (scan.ts maps "unavailable" to Unable-to-Verify).
//
// Phase 11B: the residual DNS-rebinding TOCTOU risk formerly documented here
// is CLOSED. The shared client's default transport (src/lib/pinnedFetch.ts)
// re-resolves, re-validates and PINS the socket address for the initial URL
// and for every redirect hop, so a probe can no longer be rebound into a
// private network between check and connect. Targets stay constrained to
// ports 80/443.

import { fetchTarget } from "./fetchTarget";
import { checkUrlSafety, type SafetyOptions } from "./ssrf";

/** Probe timeout — same 5s the old direct fetch used. */
export const ORIGIN_PROBE_TIMEOUT_MS = 5_000;
/**
 * Redirect hops the probe may follow (the old `redirect: "follow"` path was
 * bounded by the fetch spec's 20-hop cap). Every hop is safety-checked; a
 * chain that never ends yields `unavailable`, never a stray 3xx "answer".
 */
export const ORIGIN_PROBE_MAX_REDIRECTS = 20;

export type OriginProbeOutcome =
  /** A response we are allowed to describe: the status is safe to record. */
  | { kind: "status"; status: number }
  /**
   * No usable answer: policy refusal (loopback / private / link-local /
   * internal hostname / non-allowlisted port / DNS failure), timeout, network
   * failure, redirect loop, redirect-cap reached, or an unexpected error.
   * Carries NO status and NO body — a blocked request must not leak anything
   * about the destination into the report.
   */
  | { kind: "unavailable" };

export interface OriginProbeOptions {
  /** Injectable HTTP client for tests (same seam fetchTarget accepts). */
  fetchImpl?: typeof fetch;
  /** Injectable DNS answers for tests (same seam checkUrlSafety accepts). */
  safety?: SafetyOptions;
}

/**
 * Fetch one origin file (robots.txt / sitemap.xml) for its HTTP status only,
 * with the full SSRF policy applied to the initial URL and every redirect
 * destination. Never throws; blocked requests expose nothing.
 */
export async function probeOriginStatus(
  url: string,
  options: OriginProbeOptions = {},
): Promise<OriginProbeOutcome> {
  const outcome = await fetchTarget(url, {
    fetchImpl: options.fetchImpl,
    maxRedirects: ORIGIN_PROBE_MAX_REDIRECTS,
    timeoutMs: ORIGIN_PROBE_TIMEOUT_MS,
    // Status-only: the body is never buffered (no content, no size concern).
    readBody: false,
    // Safety policy on the initial URL and on EVERY redirect destination,
    // fail closed — the same guard scan.ts's main fetch and probe.ts use.
    assertSafe: async (candidate) => {
      const safety = await checkUrlSafety(candidate, {
        failClosed: true,
        ...(options.safety ?? {}),
      });
      if (!safety.ok) {
        throw new Error("Redirect target is a private or restricted address.");
      }
    },
  });

  if (!outcome.ok) return { kind: "unavailable" };

  const { status, chain } = outcome.fetch;
  // Still a redirect after following the chain: the hop cap was reached (a
  // redirect without a Location has chain.length === 0 and is a legitimate
  // final answer, kept as-is). Treat it like the old client did when it
  // exceeded its cap — Unable to Verify, no stray status in evidence.
  if (status >= 300 && status < 400 && chain.length > 0) {
    return { kind: "unavailable" };
  }
  return { kind: "status", status };
}
