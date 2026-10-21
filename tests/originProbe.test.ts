// B1 regression tests — origin probes (robots.txt / sitemap.xml) must run
// through the project's SSRF policy on the initial URL and on EVERY redirect
// destination, fail closed, and expose NOTHING (no status, no body) when a
// destination is refused. Before the fix these probes used
// `fetch(..., { redirect: "follow" })`, so a scanned host could bounce them
// at loopback/private/link-local addresses and the internal HTTP status was
// written into report evidence.
//
// Everything here is offline: a fake fetch records every request (and the
// `redirect` mode it was made with), and an injectable resolver supplies DNS
// answers — the same seams fetchTarget and checkUrlSafety already expose.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  ORIGIN_PROBE_MAX_REDIRECTS,
  ORIGIN_PROBE_TIMEOUT_MS,
  probeOriginStatus,
} from "../src/lib/originProbe";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const PUBLIC_IP = "93.184.216.34";

type Route = Response | (() => Response);

/** Records every request the probe makes and its redirect mode. */
function recorder(routes: Record<string, Route>) {
  const calls: Array<{ url: string; redirect?: unknown }> = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (!route) return Promise.reject(new TypeError(`fetch failed: ${url}`));
    return Promise.resolve(typeof route === "function" ? route() : route);
  };
  return { fetchImpl, calls };
}

const redirectTo = (location: string, status = 302): Response =>
  new Response(null, { status, headers: { Location: location } });
const noLocation = (status: number): Response => new Response(null, { status });
const status200 = (body = "User-agent: *\nAllow: /\n"): Response =>
  new Response(body, { status: 200 });

/** DNS answers: every host public unless overridden. */
const publicDns = async (): Promise<string[]> => [PUBLIC_IP];

describe("probeOriginStatus — legitimate public probes", () => {
  test("a public 200 answer is returned as a status, with redirects never automatic", async () => {
    const { fetchImpl, calls } = recorder({
      "https://public.example/robots.txt": status200(),
    });
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl,
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "status", status: 200 });
    expect(calls).toHaveLength(1);
    // The client must follow redirects MANUALLY so every hop is policy-checked.
    expect(calls[0].redirect).toBe("manual");
  });

  test("a public redirect chain is followed hop-by-hop, each hop safety-checked", async () => {
    const dnsCalls: string[] = [];
    const resolve = async (host: string): Promise<string[]> => {
      dnsCalls.push(host);
      return [PUBLIC_IP];
    };
    const { fetchImpl, calls } = recorder({
      "https://public.example/robots.txt": redirectTo("https://public.example/mirror/robots.txt"),
      "https://public.example/mirror/robots.txt": new Response(null, { status: 404 }),
    });
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl,
      safety: { resolve },
    });
    // Same mapping input the scanner had before: a plain public 404.
    expect(res).toEqual({ kind: "status", status: 404 });
    expect(calls.map((c) => c.url)).toEqual([
      "https://public.example/robots.txt",
      "https://public.example/mirror/robots.txt",
    ]);
    for (const call of calls) expect(call.redirect).toBe("manual");
    // The policy resolved DNS for the initial URL AND the redirect destination.
    expect(dnsCalls).toEqual(["public.example", "public.example"]);
  });

  test("a final 3xx without a Location header stays a legitimate answer (old behaviour)", async () => {
    const { fetchImpl } = recorder({
      "https://public.example/robots.txt": noLocation(301),
    });
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl,
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "status", status: 301 });
  });
});

describe("probeOriginStatus — redirects into prohibited destinations are blocked", () => {
  const blockedDestination = async (location: string): Promise<void> => {
    const { fetchImpl, calls } = recorder({
      "https://public.example/robots.txt": redirectTo(location),
    });
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl,
      safety: { resolve: publicDns },
    });
    // Refused: NOTHING about the destination leaks — no status, no body.
    expect(res).toEqual({ kind: "unavailable" });
    expect("status" in res).toBe(false);
    // The prohibited destination was never fetched.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://public.example/robots.txt");
  };

  test("loopback (127.0.0.1) destination", async () => {
    await blockedDestination("http://127.0.0.1/internal-admin");
  });

  test("private network (10.0.0.8) destination", async () => {
    await blockedDestination("http://10.0.0.8/secrets");
  });

  test("link-local cloud metadata (169.254.169.254) destination", async () => {
    await blockedDestination("http://169.254.169.254/latest/meta-data/");
  });

  test("loopback IPv6 ([::1]) destination", async () => {
    await blockedDestination("http://[::1]/");
  });

  test("internal hostname (service.local) destination", async () => {
    await blockedDestination("http://service.local/robots.txt");
  });

  test("non-allowlisted port (8443) destination", async () => {
    await blockedDestination("https://public.example:8443/robots.txt");
  });

  test("hostname whose DNS answer is private (unsafe DNS result)", async () => {
    const resolve = async (host: string): Promise<string[]> =>
      host === "rebind.example" ? ["10.0.0.5"] : [PUBLIC_IP];
    const { fetchImpl, calls } = recorder({
      "https://public.example/robots.txt": redirectTo("http://rebind.example/robots.txt"),
    });
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl,
      safety: { resolve },
    });
    expect(res).toEqual({ kind: "unavailable" });
    // Only the first (public) hop was ever fetched.
    expect(calls).toHaveLength(1);
  });
});

describe("probeOriginStatus — the policy also guards the INITIAL url, fail closed", () => {
  test("probing an internal hostname directly is refused before any request", async () => {
    const { fetchImpl, calls } = recorder({});
    const res = await probeOriginStatus("http://localhost/robots.txt", {
      fetchImpl,
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("mixed DNS answers (one public + one private) disqualify the host", async () => {
    const { fetchImpl, calls } = recorder({
      "https://mixed.example/robots.txt": status200(),
    });
    const res = await probeOriginStatus("https://mixed.example/robots.txt", {
      fetchImpl,
      safety: { resolve: async () => [PUBLIC_IP, "192.168.0.5"] },
    });
    expect(res).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("a DNS failure fails closed — no request, no status", async () => {
    const { fetchImpl, calls } = recorder({
      "https://nodns.example/robots.txt": status200(),
    });
    const res = await probeOriginStatus("https://nodns.example/robots.txt", {
      fetchImpl,
      safety: {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      },
    });
    expect(res).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("probeOriginStatus — chains, caps and failures", () => {
  test("a never-ending redirect chain stops at the hop cap and reports no stray 3xx", async () => {
    const calls: Array<{ url: string; redirect?: unknown }> = [];
    let hops = 0;
    const res = await probeOriginStatus("https://public.example/robots.txt", {
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        calls.push({ url, redirect: init?.redirect });
        hops += 1;
        // Always a *different* next URL, so only the hop cap can stop the chain.
        return Promise.resolve(redirectTo(`https://public.example/robots.txt?h=${hops}`));
      },
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "unavailable" });
    expect("status" in res).toBe(false);
    expect(calls).toHaveLength(ORIGIN_PROBE_MAX_REDIRECTS + 1);
    for (const call of calls) expect(call.redirect).toBe("manual");
  });

  test("timeout is unavailable, never a status", async () => {
    const err = new Error("operation timed out");
    err.name = "TimeoutError";
    const res = await probeOriginStatus("https://slow.example/robots.txt", {
      fetchImpl: () => Promise.reject(err),
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "unavailable" });
  });

  test("network failure is unavailable, never a status", async () => {
    const res = await probeOriginStatus("https://down.example/robots.txt", {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
      safety: { resolve: publicDns },
    });
    expect(res).toEqual({ kind: "unavailable" });
  });

  test("the probe keeps the original timeout bound", () => {
    expect(ORIGIN_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});

// ── Source pins: wiring a runtime test cannot observe without a live target ──

describe("scan.ts wiring — probes are policy-checked, statuses can't leak", () => {
  const scan = read("src/convex/scan.ts");
  const probe = read("src/lib/originProbe.ts");
  const client = read("src/lib/fetchTarget.ts");

  test("the raw redirect-following fetches are gone from the scanner", () => {
    expect(scan).not.toContain("fetch(`${origin}/robots.txt`");
    expect(scan).not.toContain("fetch(`${origin}/sitemap.xml`");
    expect(scan).not.toContain('redirect: "follow"');
    expect(scan.match(/probeOriginStatus\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("a non-status probe result maps to Unable-to-Verify with no evidence", () => {
    expect(scan).toContain('if (robotsProbe.kind !== "status")');
    expect(scan).toContain('if (sitemapProbe.kind !== "status")');
    expect(scan).toContain('seoChecks["robots-txt"] = "not-checked"');
    expect(scan).toContain('seoChecks["sitemap-xml"] = "not-checked"');
    // Evidence text is only ever built from a real status value.
    expect(scan).toContain("HTTP ${robotsProbe.status}.");
    expect(scan).toContain("HTTP ${sitemapProbe.status}.");
  });

  test("the probe helper applies the shared SSRF policy, fail closed, status-only", () => {
    expect(probe).toContain("checkUrlSafety(candidate");
    expect(probe).toContain("failClosed: true");
    expect(probe).toContain("readBody: false");
    expect(probe).toContain('"unavailable"');
    expect(client).toContain('redirect: "manual"');
  });

  test("scoring/claim wording for the probes is untouched", () => {
    // Pinned elsewhere too (trustworthyClaims) — re-asserted here because this
    // file owns the probe replacement.
    expect(scan).toContain('"No robots.txt file found."');
    expect(scan).toContain('"No sitemap.xml found."');
    expect(scan).toContain("While not strictly required, it's considered best practice.");
    expect(scan).toContain("especially for large sites or pages not well-linked internally");
    // The quota still runs before anything touches the target (rateLimit.test).
    expect(scan.indexOf("consumeScanQuota")).toBeLessThan(scan.indexOf("fetchTarget("));
  });
});
