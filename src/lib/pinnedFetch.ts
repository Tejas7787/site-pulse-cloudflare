// ── SitePulse pinned HTTP transport (Phase 11B) ──────────────────────────────
// Closes the confirmed DNS-rebinding / TOCTOU SSRF gap in src/lib/ssrf.ts:
//
//   OLD: checkUrlSafety() resolved + validated the hostname, then the stock
//   `fetch` resolved DNS AGAIN at connect time. Between the two resolutions an
//   attacker-controlled DNS server could swap the public answer for a private
//   one (127.0.0.1 / 10.x / 169.254.169.254 / …) and the request would land
//   on an internal host it was never checked against.
//
//   NEW: every request resolves and validates FIRST (resolveSafeDestination:
//   EVERY A/AAAA answer must be public, fail closed) and then opens the socket
//   through a custom `lookup` that can only return those validated addresses —
//   the socket performs no DNS of its own, so there is no window in which DNS
//   can change. The original hostname is preserved for the HTTP Host header
//   and, over TLS, for SNI + certificate identity (verified empirically on
//   this Node runtime: http.request, https.request and tls.connect all honor a
//   custom lookup — including the autoSelectFamily `all: true` form — while
//   certificate identity still checks against the hostname, not the pin).
//
// Properties, pinned by tests/pinnedFetch.test.ts:
//   - Connection address comes from ONE validation result; nothing re-resolves
//     between validate and connect (rebinding is unobservable).
//   - fetchTarget calls the transport once per hop, so every redirect
//     destination is independently re-resolved, re-validated and re-pinned.
//   - DNS failure, empty answers, internal hostnames, private/loopback/
//     link-local/reserved literals and ports outside {80,443} throw BEFORE any
//     socket is opened (fail closed).
//   - Timeout, response-size and redirect caps stay in fetchTarget, unchanged.
//
// Test seams: setPinnedFetchDepsForTests() injects deterministic DNS and a
// fake connection. Production never calls it — default = real DNS resolution +
// node http/https over the pinned lookup. An injected `send` bypasses the real
// socket path, which is exactly why it exists only for tests.

import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { resolveSafeDestination } from "./ssrf";

/** Matches fetchTarget's /private or restricted/ → kind "unsafe" classification. */
const POLICY_REFUSAL_MESSAGE = "Redirect target is a private or restricted address.";

export interface PinnedSendArgs {
  /** Original URL — the source of the Host header and (TLS) SNI identity. */
  url: URL;
  /** The ONLY addresses the socket may use (validated public answers). */
  addresses: string[];
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

/** The connection step. Default: node http/https bound to the pinned lookup. */
export type PinnedSender = (args: PinnedSendArgs) => Promise<Response>;

export interface PinnedFetchDeps {
  /** DNS resolver (default: node:dns lookup, all answers). */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Connection (default: node http/https over the pinned lookup). */
  send?: PinnedSender;
}

let deps: PinnedFetchDeps = {};

/**
 * Test-only seam for deterministic DNS + a fake connection. Passing null
 * restores the production defaults. Production code must never call this.
 */
export function setPinnedFetchDepsForTests(next: PinnedFetchDeps | null): void {
  deps = next ?? {};
}

/**
 * The socket-level lookup: returns ONLY the pre-validated pinned addresses and
 * never consults DNS. Handles both callback shapes — single address and the
 * autoSelectFamily `all: true` list form. When `expectedHost` is given, a
 * request for any other hostname fails closed instead of resolving.
 */
export function createPinnedLookup(addresses: string[], expectedHost?: string): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  if (entries.length === 0 || entries.some((entry) => entry.family === 0)) {
    throw new Error("Pinned destination is not a valid IP address.");
  }
  const lookup = ((hostname: string, options: unknown, callback?: unknown): void => {
    // Callers historically use both (host, options, cb) and (host, cb).
    const opts = (typeof options === "object" && options !== null ? options : {}) as {
      all?: boolean;
    };
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address?: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    if (typeof cb !== "function") {
      throw new Error("Pinned lookup requires a callback.");
    }
    // Fail closed if asked for anything except the host this pin was made for.
    if (expectedHost !== undefined && String(hostname).toLowerCase() !== expectedHost.toLowerCase()) {
      cb(new Error(`Unexpected connection host ${hostname}.`));
      return;
    }
    if (opts.all) cb(null, entries);
    else cb(null, entries[0].address, entries[0].family);
  }) as LookupFunction;
  return lookup;
}

/**
 * Make sure the outgoing headers carry the connection identity: the original
 * hostname as Host (IPv6 literals keep their brackets, default ports omitted)
 * and `accept-encoding: identity` — node's client does not decode
 * content-codings the way the stock fetch did, so bodies stay readable.
 * Idempotent; called both by pinnedFetch (so every sender sees the headers)
 * and by buildPinnedRequestOptions (defense in depth).
 */
function applyConnectionHeaders(headers: Record<string, string>, url: URL): void {
  const lower = Object.keys(headers).map((key) => key.toLowerCase());
  if (!lower.includes("host")) headers.host = hostHeaderFor(url);
  if (!lower.includes("accept-encoding")) headers["accept-encoding"] = "identity";
}

/** Host header value for the original URL (IPv6 literals keep their brackets). */
function hostHeaderFor(url: URL): string {
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  const secure = url.protocol === "https:";
  const port = url.port !== "" ? Number(url.port) : secure ? 443 : 80;
  const defaultPort = secure ? 443 : 80;
  const host = bare.includes(":") ? `[${bare}]` : bare;
  return port === defaultPort ? host : `${host}:${port}`;
}

/**
 * Pure builder for the node http/https request options. The key invariant:
 * the socket address is decided EXCLUSIVELY by `lookup` (the pin), while
 * `host` / `headers.host` keep the original hostname for the HTTP Host header
 * and TLS servername keeps it for SNI + certificate identity — the pinned IP
 * never appears in the protocol layer.
 */
export function buildPinnedRequestOptions(args: PinnedSendArgs): http.RequestOptions {
  const url = args.url;
  const secure = url.protocol === "https:";
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port !== "" ? Number(url.port) : secure ? 443 : 80;

  const headers: Record<string, string> = { ...args.headers };
  applyConnectionHeaders(headers, url);

  return {
    protocol: url.protocol,
    host: bare,
    port,
    path: `${url.pathname}${url.search}`,
    method: args.method,
    headers,
    lookup: createPinnedLookup(args.addresses, bare),
    // One connection per request: never reuse a pooled socket created under a
    // different pin, and never let an agent resolve on its own.
    agent: false,
    ...(secure && isIP(bare) === 0 ? { servername: bare } : {}),
  };
}

/** Wrap a node IncomingMessage as a standard Response (streams the body). */
function incomingToResponse(res: http.IncomingMessage): Response {
  const rawStatus = res.statusCode ?? 599;
  const status = rawStatus >= 200 && rawStatus <= 599 ? rawStatus : 599;
  const headers = new Headers();
  for (const key of Object.keys(res.headers)) {
    const raw = res.headers[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
    } else {
      headers.append(key, String(raw));
    }
  }
  // The Response constructor forbids a body on these statuses.
  const bodyless = status === 204 || status === 205 || status === 304;
  const body = bodyless
    ? null
    : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status, statusText: res.statusMessage ?? "" });
}

/**
 * Normalize an abort into the error class fetchTarget classifies as
 * "timeout": the caller only ever passes AbortSignal.timeout(), but runtimes
 * differ in what they destroy the request with (the spec reason vs a generic
 * abort error), so the classification must not depend on that.
 */
function abortErrorFor(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && (reason.name === "TimeoutError" || /timeout/i.test(reason.message))) {
    return reason;
  }
  const err = new Error(reason instanceof Error ? reason.message : "The operation timed out.");
  err.name = "TimeoutError";
  return err;
}

/** Default connection: node http/https with DNS replaced by the pinned lookup. */
async function nodeSend(args: PinnedSendArgs): Promise<Response> {
  const options = buildPinnedRequestOptions(args);
  const client = args.url.protocol === "https:" ? https : http;
  return new Promise<Response>((resolve, reject) => {
    const req = client.request(options, (res) => {
      try {
        resolve(incomingToResponse(res));
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.on("error", reject);
    req.end();
    // The abort path is handled HERE (not via the options.signal facility) so
    // the rejection always carries the classifiable error above, on every
    // runtime. destroy(err) surfaces err on the request's "error" event.
    const signal = args.signal;
    if (signal) {
      const onAbort = () => req.destroy(abortErrorFor(signal));
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }
  });
}

/**
 * The production sender, exported for runtime verification (the unit suite
 * injects fake connections on purpose; this is the real socket path that
 * must be exercised at least once against a local fixture before shipping).
 */
export const defaultPinnedSender: PinnedSender = nodeSend;

/**
 * fetch-compatible entry point used as fetchTarget's default transport.
 * Validates + pins per call — i.e. per redirect hop — and delegates the
 * connection to the (test-injectable) sender. Throws the shared
 * "private or restricted" message on any refusal, before a socket exists.
 * Only GET/HEAD are supported: the scanner never sends request bodies.
 */
export async function pinnedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL((input as Request).url);

  const destination = await resolveSafeDestination(url.href, {
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  if (!destination.ok) {
    throw new Error(POLICY_REFUSAL_MESSAGE);
  }

  const headers: Record<string, string> = {};
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
  }
  applyConnectionHeaders(headers, destination.url);

  const args: PinnedSendArgs = {
    url: destination.url,
    addresses: destination.addresses,
    method: (init.method ?? "GET").toUpperCase(),
    headers,
    signal: init.signal ?? null,
  };
  return (deps.send ?? defaultPinnedSender)(args);
}
