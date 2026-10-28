// Phase 11B — DNS rebinding / TOCTOU SSRF regression suite.
//
// Root cause this locks down: the SSRF policy validated a hostname's DNS
// answer, then the HTTP client resolved DNS AGAIN at connect time. Between
// those two resolutions an attacker-controlled DNS server could swap the
// public answer for a private one and the request would land on an internal
// host it was never checked against.
//
// The fix (src/lib/pinnedFetch.ts + resolveSafeDestination in src/lib/ssrf.ts):
// every request resolves and validates FIRST (every answer must be public,
// fail closed), then connects through a custom `lookup` that can only return
// those already-validated addresses. fetchTarget calls the transport once per
// hop, so redirect destinations are independently re-resolved and re-pinned.
//
// Coverage map (the required cases):
//   - public resolution + successful pinned connection        → "pinning"
//   - rebinding public → private                              → "pinning"
//   - loopback/private/link-local/reserved rejection          → "pinning" + "IPv6"
//   - redirect public → private (literal and via DNS)         → "per-hop"
//   - redirect to another public host, independent validation → "per-hop"
//   - DNS failure and empty answers                           → "pinning"
//   - IPv4-mapped IPv6 + IPv6 special ranges                  → "IPv6"
//   - the connection can never reach an unvalidated IP        → "pinning"/"lookup"/"per-hop"
//   - existing scan/monitoring/robots/sitemap behavior        → their own suites
//
// Everything is deterministic: DNS and the connection are injected seams.
// Nothing here contacts the network, real or internal.

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPinnedRequestOptions,
  createPinnedLookup,
  pinnedFetch,
  setPinnedFetchDepsForTests,
  type PinnedSendArgs,
} from "../src/lib/pinnedFetch";
import { resolveSafeDestination } from "../src/lib/ssrf";
import { fetchTarget } from "../src/lib/fetchTarget";

const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "151.101.1.140";

const dnsCalls: string[] = [];
const sent: PinnedSendArgs[] = [];
let dnsTable: Record<string, string[] | "error"> = {};

async function resolveFake(hostname: string): Promise<string[]> {
  dnsCalls.push(hostname);
  const entry = dnsTable[hostname];
  if (entry === undefined || entry === "error") throw new Error("ENOTFOUND");
  return entry;
}

async function sendFake(args: PinnedSendArgs): Promise<Response> {
  sent.push(args);
  return new Response("", { status: 200 });
}

function answerDnsWith(table: Record<string, string[] | "error">): void {
  dnsTable = table;
}

function installFakeTransport(): void {
  setPinnedFetchDepsForTests({ resolve: resolveFake, send: sendFake });
}

afterEach(() => {
  sent.length = 0;
  dnsCalls.length = 0;
  dnsTable = {};
  setPinnedFetchDepsForTests(null);
});

/** Every refusal must carry the shared message fetchTarget maps to "unsafe". */
async function expectRefusal(fn: () => Promise<unknown>): Promise<void> {
  let err: unknown = null;
  try {
    await fn();
  } catch (thrown) {
    err = thrown;
  }
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toContain("private or restricted");
}

/* ── 1. Public resolution and a successful pinned connection ──────────────── */

describe("pinning — resolve once, connect to the validated address", () => {
  test("a public host resolves once and the connection is pinned to that exact answer", async () => {
    answerDnsWith({ "example.com": [PUBLIC_IP] });
    installFakeTransport();

    const res = await pinnedFetch("http://example.com/page?q=1");
    expect(res.status).toBe(200);

    expect(dnsCalls).toEqual(["example.com"]); // exactly ONE resolution per request
    expect(sent).toHaveLength(1);
    expect(sent[0].addresses).toEqual([PUBLIC_IP]);
    expect(sent[0].method).toBe("GET");
    // The original hostname is preserved for the protocol layer...
    expect(sent[0].url.hostname).toBe("example.com");
    expect(sent[0].headers.host).toBe("example.com");
    // ...and the body is requested uncompressed (node's client does not decode
    // content-codings, so the stock fetch's gzip handling must not be assumed).
    expect(sent[0].headers["accept-encoding"]).toBe("identity");
    // An IP-literal target never touches DNS — the literal itself is validated.
    dnsCalls.length = 0;
    await pinnedFetch(`http://${PUBLIC_IP}/`);
    expect(dnsCalls).toHaveLength(0);
    expect(sent[1].addresses).toEqual([PUBLIC_IP]);
  });

  test("DNS rebinding: the socket never re-resolves, so a flipped answer is unobservable", async () => {
    answerDnsWith({ "rebind.example": [PUBLIC_IP] });
    installFakeTransport();
    await pinnedFetch("http://rebind.example/");
    expect(sent[0].addresses).toEqual([PUBLIC_IP]);
    expect(dnsCalls).toEqual(["rebind.example"]);

    // The attacker now rebinds the name to loopback. The pinned lookup has NO
    // access to the resolver — it can only hand out the validated address.
    dnsTable = { "rebind.example": ["127.0.0.1"] };
    const lookup = createPinnedLookup(sent[0].addresses, "rebind.example");
    lookup("rebind.example", { all: false }, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe(PUBLIC_IP);
    });
    expect(dnsCalls).toEqual(["rebind.example"]); // still exactly one resolution

    // A NEW request re-validates and is now refused — with no connection made.
    await expectRefusal(() => pinnedFetch("http://rebind.example/"));
    expect(sent).toHaveLength(1);
    expect(dnsCalls).toEqual(["rebind.example", "rebind.example"]);
  });

  test("loopback, private, link-local and reserved literals are refused before any connection", async () => {
    installFakeTransport();
    const urls = [
      "http://127.0.0.1/",              // loopback
      "http://10.1.2.3/",                // RFC1918
      "http://192.168.1.10/",            // RFC1918 LAN
      "http://172.16.0.1/",              // RFC1918
      "http://169.254.169.254/latest/",  // link-local / cloud metadata
      "http://100.64.0.1/",              // CGNAT
      "http://0.0.0.0/",                 // this network
      "http://2130706433/",              // decimal loopback
      "http://224.0.0.1/",               // multicast / reserved
      "http://198.18.0.1/",              // benchmarking
      "http://192.0.2.1/",               // TEST-NET-1
      "http://198.51.100.9/",            // TEST-NET-2
      "http://203.0.113.9/",             // TEST-NET-3
      "http://localhost/",
      "http://db.internal/",
      "http://router.local/",
      "https://app.corp/",
    ];
    for (const url of urls) await expectRefusal(() => pinnedFetch(url));
    expect(sent).toHaveLength(0);
    expect(dnsCalls).toHaveLength(0); // literals and internal names never resolve
  });

  test("a mixed public/private DNS answer set is refused — no connection", async () => {
    answerDnsWith({ "mixed.example": [PUBLIC_IP, "127.0.0.1"] });
    installFakeTransport();
    await expectRefusal(() => pinnedFetch("http://mixed.example/"));
    expect(dnsCalls).toEqual(["mixed.example"]);
    expect(sent).toHaveLength(0);
  });

  test("DNS failure and empty DNS answers fail closed — no connection", async () => {
    answerDnsWith({ "nodns.example": "error", "empty.example": [] });
    installFakeTransport();
    await expectRefusal(() => pinnedFetch("http://nodns.example/"));
    await expectRefusal(() => pinnedFetch("http://empty.example/"));
    expect(sent).toHaveLength(0);

    // resolveSafeDestination itself never honors a fail-closed opt-out: a pin
    // that cannot be proven public must not exist.
    const failing = async (): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    const dest = await resolveSafeDestination("http://nodns.example/", { resolve: failing });
    expect(dest.ok).toBe(false);
  });

  test("a non-allowlisted port or scheme is refused before any connection", async () => {
    installFakeTransport();
    await expectRefusal(() => pinnedFetch("http://example.com:8443/"));
    await expectRefusal(() => pinnedFetch("ftp://example.com/"));
    expect(sent).toHaveLength(0);
  });
});

/* ── 2. IPv4-mapped IPv6 and IPv6 special ranges ──────────────────────────── */

describe("IPv6 — mapped and special-purpose ranges are refused", () => {
  test("IPv4-mapped/compatible, NAT64, and special-purpose answers never connect", async () => {
    installFakeTransport();
    const bad = [
      "::ffff:127.0.0.1",     // IPv4-mapped loopback
      "::ffff:10.0.0.1",      // IPv4-mapped RFC1918
      "::ffff:169.254.169.254", // IPv4-mapped metadata
      "::1",                  // loopback
      "::",                   // unspecified
      "fe80::1",              // link-local
      "fd00::1",              // unique local
      "ff02::1",              // multicast
      "64:ff9b::10.0.0.1",    // NAT64-embedded private IPv4
      "2002:7f00:1::",        // 6to4-embedded 127.0.0.1
      "2001:db8::1",          // documentation
      "2001::1",              // Teredo
      "100::1",               // discard-only
      "3fff::1",              // documentation (RFC 9637)
    ];
    for (const addr of bad) {
      answerDnsWith({ "v6.example": [addr] });
      await expectRefusal(() => pinnedFetch("http://v6.example/"));
    }
    expect(sent).toHaveLength(0);

    // A genuine public IPv6 answer still pins and connects.
    answerDnsWith({ "v6.example": ["2606:4700:4700::1111"] });
    const res = await pinnedFetch("http://v6.example/");
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].addresses).toEqual(["2606:4700:4700::1111"]);
  });
});

/* ── 3. Per-hop pinning through the shared client (redirects) ─────────────── */

describe("fetchTarget + pinned transport — every hop is revalidated and repinned", () => {
  test("a redirect into a private IP literal is refused; the second connection never happens", async () => {
    answerDnsWith({ "a.example": [PUBLIC_IP] });
    setPinnedFetchDepsForTests({
      resolve: resolveFake,
      send: async (args) => {
        sent.push(args);
        return new Response("", {
          status: 302,
          headers: { Location: "http://10.0.0.5/internal-admin" },
        });
      },
    });

    const outcome = await fetchTarget("http://a.example/");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("unsafe");
    expect(sent).toHaveLength(1); // only the first (validated) hop connected
    expect(dnsCalls).toEqual(["a.example"]);
  });

  test("a redirect to a hostname whose DNS answer is private is refused before connecting", async () => {
    answerDnsWith({ "a.example": [PUBLIC_IP], "rebind.test": ["192.168.0.5"] });
    setPinnedFetchDepsForTests({
      resolve: resolveFake,
      send: async (args) => {
        sent.push(args);
        return new Response("", {
          status: 302,
          headers: { Location: "http://rebind.test/robots.txt" },
        });
      },
    });

    const outcome = await fetchTarget("http://a.example/");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("unsafe");
    // The redirect target WAS resolved and validated — then refused. It never
    // got a connection, which is exactly the rebinding scenario.
    expect(dnsCalls).toEqual(["a.example", "rebind.test"]);
    expect(sent).toHaveLength(1);
  });

  test("a redirect to a different public hostname is independently resolved, validated and repinned", async () => {
    answerDnsWith({ "a.example": [PUBLIC_IP], "www.example": [OTHER_PUBLIC_IP] });
    setPinnedFetchDepsForTests({
      resolve: resolveFake,
      send: async (args) => {
        sent.push(args);
        if (args.url.hostname === "a.example") {
          return new Response("", {
            status: 301,
            headers: { Location: "https://www.example/home" },
          });
        }
        return new Response("<html><title>Home</title></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    const outcome = await fetchTarget("http://a.example/");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetch.finalUrl).toBe("https://www.example/home");
    expect(outcome.fetch.status).toBe(200);
    expect(outcome.fetch.chain.map((hop) => hop.status)).toEqual([301]);

    // Two independent resolutions, two independent pins — one per hop.
    expect(dnsCalls).toEqual(["a.example", "www.example"]);
    expect(sent).toHaveLength(2);
    expect(sent[0].addresses).toEqual([PUBLIC_IP]);
    expect(sent[1].addresses).toEqual([OTHER_PUBLIC_IP]);
    expect(sent[1].headers.host).toBe("www.example"); // Host stays the hostname
  });
});

/* ── 4. The socket layer itself can only ever use the pin ─────────────────── */

describe("createPinnedLookup / buildPinnedRequestOptions — connection-time invariants", () => {
  test("the lookup answers both callback shapes with the pin only, never DNS", () => {
    const lookup = createPinnedLookup([PUBLIC_IP], "example.com");

    lookup("example.com", { all: false }, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe(PUBLIC_IP);
      expect(family).toBe(4);
    });

    lookup("example.com", { all: true }, (err, addresses) => {
      expect(err).toBeNull();
      expect(addresses).toEqual([{ address: PUBLIC_IP, family: 4 }]);
    });
  });

  test("a request for any host the pin was not made for fails closed", () => {
    const lookup = createPinnedLookup([PUBLIC_IP], "example.com");
    lookup("evil.internal", { all: false }, (err) => {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Unexpected connection host");
    });
  });

  test("empty or non-IP pins are rejected outright", () => {
    expect(() => createPinnedLookup([])).toThrow();
    expect(() => createPinnedLookup(["not-an-ip"])).toThrow();
  });

  test("IPv6 pins report family 6", () => {
    const lookup = createPinnedLookup(["2606:4700:4700::1111"], "v6.example");
    lookup("v6.example", { all: false }, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe("2606:4700:4700::1111");
      expect(family).toBe(6);
    });
  });

  test("request options: the socket address comes ONLY from the lookup; host/Host/SNI keep the hostname", () => {
    const options = buildPinnedRequestOptions({
      url: new URL("https://example.com/path?q=1"),
      addresses: [PUBLIC_IP],
      method: "GET",
      headers: { "user-agent": "SitePulse/test" },
      signal: null,
    });

    // The pinned IP never appears as the connection target field...
    expect(options.host).toBe("example.com");
    expect(options.lookup).toBeFunction();
    // ...it is only reachable through the lookup:
    options.lookup?.("example.com", { all: false }, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe(PUBLIC_IP);
    });
    // Protocol-layer identity stays the original hostname (Host + SNI).
    expect(options.headers).toMatchObject({
      host: "example.com",
      "accept-encoding": "identity",
      "user-agent": "SitePulse/test",
    });
    expect(options.servername).toBe("example.com");
    expect(options.agent).toBe(false); // never reuse a socket from another pin
    expect(options.path).toBe("/path?q=1");
    expect(options.protocol).toBe("https:");
  });

  test("Host header formatting: default ports omitted, explicit ports kept, IPv6 bracketed", () => {
    const build = (href: string) =>
      buildPinnedRequestOptions({
        url: new URL(href),
        addresses: [PUBLIC_IP],
        method: "GET",
        headers: {},
        signal: null,
      }).headers;

    expect(build("http://example.com/")).toMatchObject({ host: "example.com" });
    expect(build("https://example.com/")).toMatchObject({ host: "example.com" });
    expect(build("http://example.com:8443/")).toMatchObject({ host: "example.com:8443" });
    expect(build("http://[2606:4700:4700::1111]/")).toMatchObject({
      host: "[2606:4700:4700::1111]",
    });
  });
});
