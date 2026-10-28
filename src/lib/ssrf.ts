// ── SitePulse SSRF guard ──────────────────────────────────────────────────────
// Shared by the interactive scanner (src/convex/scan.ts) and the unattended
// uptime prober (src/convex/probe.ts). Policy, per OWASP's SSRF Prevention
// Cheat Sheet and the IANA special-purpose registries:
//
//   1. Parse once with the WHATWG URL parser; only http/https, ports 80/443,
//      no embedded credentials.
//   2. Resolve the hostname and reject if ANY returned address is private or
//      special-purpose (never pick the "good" answer out of a mixed set).
//   3. IP literals are normalized before classification, including decimal /
//      hex / short forms (2130706433, 0x7f000001, 127.1) and IPv4-mapped or
//      IPv4-compatible IPv6 (::ffff:127.0.0.1) — the classes of input that a
//      plain dotted-quad regex silently lets through.
//   4. FAIL CLOSED: when the address cannot be determined, the URL is not safe.
//
// Phase 11B — the DNS-rebinding / TOCTOU gap that used to be listed here as a
// deferred residual risk is CLOSED. A one-time policy check before an
// ordinary `fetch` was not enough: the stock client resolves DNS again at
// connect time, so an attacker-controlled DNS server could answer the second
// resolution with a private address. Now every scanner/probe connection goes
// through src/lib/pinnedFetch.ts (and the TLS certificate probe through
// createPinnedLookup): each request — and each redirect hop — calls
// resolveSafeDestination() below, which resolves and validates EVERY answer,
// and the socket is then opened with a custom lookup that can only return
// those already-validated addresses. The HTTP client never resolves DNS
// itself, so there is no window between validation and connection. Targets
// remain constrained to ports 80/443.

import { isIP } from "node:net";

/** Special-purpose / non-public IPv4 ranges (IANA registry + RFC1918). */
function isPrivateIpv4Value(value: number): boolean {
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  const c = (value >>> 8) & 0xff;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/16 (includes 192.0.2 TEST-NET-1)
  if (a === 192 && b === 2) return true; // 192.2.0.0/15 benchmarking
  if (a === 192 && b === 168) return true; // private LAN  ← the gap in the old guard
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 literal into 8 hextets, or null when it does not parse. */
export function expandIpv6(addr: string): number[] | null {
  const s = addr.toLowerCase().split("%")[0]; // drop the zone id
  const dbl = s.indexOf("::");
  if (dbl !== s.lastIndexOf("::")) return null;

  const parseList = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (p.includes(".")) {
        if (i !== pieces.length - 1) return null; // embedded IPv4 is last only
        const v4 = parseLooseIpv4(p);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };

  if (dbl === -1) {
    const parts = parseList(s);
    return parts && parts.length === 8 ? parts : null;
  }
  const head = parseList(s.slice(0, dbl));
  const tail = parseList(s.slice(dbl + 2));
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * inet_aton-style IPv4 parsing: 1–4 dot-separated parts, each part decimal or
 * hex, the last part allowed to fill the remaining bytes. This is what makes
 * `127.1`, `0x7f.1` and `2130706433` resolve to loopback for an attacker —
 * they must classify as private, not slip past a dotted-quad regex.
 * Returns a 32-bit value, or null when the input is not an IPv4 literal.
 */
export function parseLooseIpv4(host: string): number | null {
  if (host.length === 0 || host.length > 64) return null;
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 0) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    const isLast = i === parts.length - 1;
    // The last part may span the remaining bytes (2^(8*(5-n)) for n parts).
    const max = isLast ? Math.pow(256, 5 - parts.length) - 1 : 255;
    if (n > max) return null;
    nums.push(n);
  }
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i);
  value += nums[nums.length - 1];
  if (value < 0 || value > 0xffffffff) return null;
  return value >>> 0;
}

function classifyIpv6(hextets: number[]): boolean {
  const zeroRun = (from: number, to: number) =>
    hextets.slice(from, to).every((h) => h === 0);

  // ::/128 unspecified and ::1 loopback (first 7 hextets zero).
  if (zeroRun(0, 7)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms:
  // classify the embedded IPv4 address with the same rules.
  if (zeroRun(0, 5) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const embedded = ((hextets[6] << 16) | hextets[7]) >>> 0;
    return isPrivateIpv4Value(embedded);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — again, classify the embedded IPv4.
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && zeroRun(2, 6)) {
    const embedded = ((hextets[6] << 16) | hextets[7]) >>> 0;
    return isPrivateIpv4Value(embedded);
  }
  const first = hextets[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Phase 11B — remaining special-purpose ranges (IANA IPv6 registry).
  if (first === 0x0100 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0) {
    return true; // 100::/64 discard-only
  }
  if (first === 0x2001 && hextets[1] === 0) return true; // 2001::/32 Teredo (embeds an IPv4)
  if (first === 0x2001 && hextets[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (first === 0x2002) return true; // 2002::/16 6to4 (embeds an IPv4)
  if (first === 0x3fff && (hextets[1] & 0xf000) === 0) return true; // 3fff::/20 documentation
  return false;
}

/** Is this address literal private, loopback, link-local or otherwise special? */
export function isPrivateAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const value = parseLooseIpv4(addr);
    return value === null ? true : isPrivateIpv4Value(value); // unparseable ⇒ unsafe
  }
  if (kind === 6) {
    const hextets = expandIpv6(addr);
    return hextets === null ? true : classifyIpv6(hextets);
  }
  // Not a canonical IP — try the loose parser (decimal/hex/short forms).
  const value = parseLooseIpv4(addr);
  if (value !== null) return isPrivateIpv4Value(value);
  const v6 = expandIpv6(addr);
  if (v6 !== null) return classifyIpv6(v6);
  return false; // a plain hostname; the DNS answer decides
}

/**
 * Normalize an IP literal to a canonical address, or null when the input is a
 * hostname. `2130706433`, `0x7f000001` and `127.1` all normalize to 127.0.0.1.
 */
export function normalizeIpLiteral(host: string): string | null {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4 || isIP(bare) === 6) return bare;
  const value = parseLooseIpv4(bare);
  if (value !== null) {
    return [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ].join(".");
  }
  if (bare.includes(":")) {
    const hextets = expandIpv6(bare);
    if (hextets !== null) {
      return hextets.map((h) => h.toString(16)).join(":");
    }
  }
  return null;
}

/** Hostnames that are internal by construction (checked before DNS). */
function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    h.endsWith(".corp") ||
    h.endsWith(".intranet") ||
    h.endsWith(".localdomain") ||
    h.endsWith(".private")
  ) {
    return true;
  }
  return h === "metadata.google.internal";
}

export type SafetyReason =
  | "ok"
  | "invalid"
  | "scheme"
  | "port"
  | "blocked"
  | "dns";

export interface SafetyOptions {
  /** Reject the URL when the address cannot be resolved (default: true). */
  failClosed?: boolean;
  /** Injectable resolver for tests: returns every A/AAAA answer. */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

/**
 * The shared URL analysis behind checkUrlSafety() (the policy verdict, used
 * since Phase 5) and resolveSafeDestination() (Phase 11B pinning). On "ok" it
 * also hands back the exact set of validated public addresses the connection
 * is allowed to use, so validation and connection share ONE resolution.
 */
async function analyzeUrl(
  urlStr: string,
  options: SafetyOptions = {},
): Promise<{ reason: SafetyReason; url?: URL; addresses?: string[] }> {
  const failClosed = options.failClosed ?? true;

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { reason: "scheme" };
  }
  // Port allowlist: an arbitrary-port target turns a health check into a
  // scanner for internal services.
  if (parsed.port !== "" && parsed.port !== "80" && parsed.port !== "443") {
    return { reason: "port" };
  }

  const host = parsed.hostname;
  const literal = normalizeIpLiteral(host);
  if (literal !== null) {
    return isPrivateAddress(literal)
      ? { reason: "blocked" }
      : { reason: "ok", url: parsed, addresses: [literal] };
  }
  if (isInternalHostname(host)) return { reason: "blocked" };

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    // Cannot prove the destination is public ⇒ do not connect.
    return failClosed ? { reason: "dns" } : { reason: "ok", url: parsed };
  }
  if (addresses.length === 0) {
    return failClosed ? { reason: "dns" } : { reason: "ok", url: parsed };
  }
  // ANY private answer disqualifies the hostname (mixed public/private sets).
  if (addresses.some((addr) => isPrivateAddress(addr))) {
    return { reason: "blocked" };
  }
  return { reason: "ok", url: parsed, addresses };
}

/**
 * Full safety check for one URL. `reason` distinguishes a policy rejection
 * ("blocked") from a DNS failure ("dns") so callers can word the error honestly.
 */
export async function checkUrlSafety(
  urlStr: string,
  options: SafetyOptions = {},
): Promise<{ ok: boolean; reason: SafetyReason }> {
  const { reason } = await analyzeUrl(urlStr, options);
  return { ok: reason === "ok", reason };
}

export type SafeDestination =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: SafetyReason };

/**
 * Phase 11B — resolve, validate, and HAND BACK the addresses a connection may
 * use. Unlike checkUrlSafety this ALWAYS fails closed (`failClosed: false` is
 * deliberately not honored: a pin that cannot be proven public must not
 * exist). The caller opens the socket to exactly these addresses with no
 * further DNS of its own — see src/lib/pinnedFetch.ts and the TLS probe in
 * src/convex/scan.ts. Inject `resolve` for deterministic tests.
 */
export async function resolveSafeDestination(
  urlStr: string,
  options: Pick<SafetyOptions, "resolve"> = {},
): Promise<SafeDestination> {
  const analysis = await analyzeUrl(urlStr, { ...options, failClosed: true });
  if (
    analysis.reason !== "ok" ||
    !analysis.url ||
    !analysis.addresses ||
    analysis.addresses.length === 0
  ) {
    // "ok but no addresses" cannot happen with failClosed: true; treat it as
    // a DNS failure anyway rather than ever returning an unpinned destination.
    return { ok: false, reason: analysis.reason === "ok" ? "dns" : analysis.reason };
  }
  return { ok: true, url: analysis.url, addresses: analysis.addresses };
}

/** Boolean convenience wrapper around checkUrlSafety(). */
export async function isUrlSafe(
  urlStr: string,
  options: SafetyOptions = {},
): Promise<boolean> {
  const result = await checkUrlSafety(urlStr, options);
  return result.ok;
}
