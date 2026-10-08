// ── SitePulse controlled HTTP client ────────────────────────────────────────
// Records everything needed for evidence: requested URL, redirect chain, final
// URL, status, headers, content type, duration and whether the body was
// complete. Detects blocks (403/429/CAPTCHA/bot protection), timeouts and
// incomplete responses so the caller can mark content checks Unable to Verify
// instead of reporting false failures.

export interface RedirectHop {
  /** URL that produced the redirect. */
  url: string;
  /** HTTP status of that response. */
  status: number;
  /** Location header value (raw, as sent). */
  location?: string;
}

export interface TargetFetch {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Headers;
  headerSnapshot: Record<string, string>;
  contentType: string | null;
  body: string;
  bytes: number;
  durationMs: number;
  chain: RedirectHop[];
  /** true when the body was cut short (declared length > bytes received). */
  truncated: boolean;
}

export type FetchOutcome =
  | { ok: true; fetch: TargetFetch }
  | {
      ok: false;
      kind: "invalid" | "unsafe" | "timeout" | "network" | "too-large" | "redirect-loop";
      message: string;
    };

export interface FetchTargetOptions {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** SSRF guard applied to every hop (including redirects). */
  assertSafe?: (url: string) => Promise<void>;
}

export const DEFAULT_USER_AGENT =
  "SitePulse/1.0 (+https://sitepulse.dev) Website-Health-Scanner";

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || /timeout/i.test(err.message)) return "timeout";
    return err.message;
  }
  return String(err);
}

/**
 * Fetch a URL following redirects manually so the full chain is recorded.
 * Never throws for network problems — returns a typed outcome instead.
 */
export async function fetchTarget(
  requestedUrl: string,
  options: FetchTargetOptions = {},
): Promise<FetchOutcome> {
  const {
    fetchImpl = fetch,
    maxRedirects = 10,
    timeoutMs = 12_000,
    maxBytes = 5 * 1024 * 1024,
    userAgent = DEFAULT_USER_AGENT,
    assertSafe,
  } = options;

  let parsed: URL;
  try {
    parsed = new URL(requestedUrl);
  } catch {
    return { ok: false, kind: "invalid", message: "Invalid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, kind: "invalid", message: "Only HTTP and HTTPS URLs are supported." };
  }

  const start = Date.now();
  const chain: RedirectHop[] = [];
  let currentUrl = parsed.href;
  let response: Response | null = null;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (assertSafe) await assertSafe(currentUrl);
      response = await fetchImpl(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("Location");
        if (!location) break; // redirect without target: keep this response as final
        chain.push({ url: currentUrl, status, location });
        const next = new URL(location, currentUrl).href;
        if (next === currentUrl) {
          return { ok: false, kind: "redirect-loop", message: "The site redirected in a loop." };
        }
        currentUrl = next;
        // Drain the body so the socket can be reused/discarded cleanly.
        try { await response.arrayBuffer(); } catch { /* ignore */ }
        continue;
      }
      break;
      }
  } catch (err) {
    const msg = errorMessage(err);
    if (msg === "timeout") {
      return {
        ok: false,
        kind: "timeout",
        message: "The website took too long to respond. It may be down or blocking health checks.",
      };
    }
    if (/private or restricted/i.test(msg)) {
      return { ok: false, kind: "unsafe", message: "Redirect target is a private or restricted address." };
    }
    return {
      ok: false,
      kind: "network",
      message: `Could not connect to ${parsed.href}. Please verify the URL and try again.`,
    };
  }

  if (!response) {
    return {
      ok: false,
      kind: "network",
      message: `Could not connect to ${parsed.href}. Please verify the URL and try again.`,
    };
  }
  const finalResponse = response;
  const status = finalResponse.status;
  const contentType = finalResponse.headers.get("content-type");

  // Read the FINAL response body (not the originally requested one).
  let body = "";
  let bytes = 0;
  let truncated = false;
  try {
    const buffer = await response.arrayBuffer();
    bytes = buffer.byteLength;
    if (bytes > maxBytes) {
      return {
        ok: false,
        kind: "too-large",
        message: "The page is too large to analyze (over 5 MB). Try a different page.",
      };
    }
    body = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > bytes) truncated = true;
  } catch {
    // Body read failed / aborted mid-stream: response is incomplete.
    truncated = true;
  }

  const headerSnapshot: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headerSnapshot[key.toLowerCase()] = value;
  });
  // set-cookie needs getSetCookie to avoid joining multiple cookies.
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  if (setCookies.length > 0) headerSnapshot["set-cookie"] = setCookies.join("\n");

  return {
    ok: true,
    fetch: {
      requestedUrl: parsed.href,
      finalUrl: currentUrl,
      status,
      headers: response.headers,
      headerSnapshot,
      contentType,
      body,
      bytes,
      durationMs: Date.now() - start,
      chain,
      truncated,
    },
  };
}

// ── Block / bot-protection detection ────────────────────────────────────────

export type BlockKind =
  | "rate-limited"
  | "access-denied"
  | "challenge"
  | "legal"
  | "server-error"
  | "not-found"
  | "auth-required";

export interface BlockDetection {
  kind: BlockKind;
  /** Human-readable reason, safe to show to the user. */
  reason: string;
  /** Exact observed evidence (status, header, body marker). */
  evidence: string;
}

// Strong challenge markers: their presence almost always means a bot wall,
// even on a 200 response.
const STRONG_CHALLENGE_MARKERS = [
  "cf-chl-",
  "challenge-platform",
  "cdn-cgi/challenge",
  "checking your browser",
  "enable javascript and cookies to continue",
  "turnstile.js",
];
// Weak markers: only treated as a block together with an error status.
const WEAK_CHALLENGE_MARKERS = [
  "captcha",
  "g-recaptcha",
  "hcaptcha",
  "verify you are a human",
  "verify you are human",
  "unusual traffic",
  "automated requests",
  "access denied",
  "bot detection",
  "are you a robot",
  "aws waf",
];

/**
 * Decide whether the observed response blocks a meaningful content scan.
 * Conservative on purpose: a 200 HTML page is only treated as a challenge
 * when a strong challenge marker is present, so ordinary pages that merely
 * mention the word "captcha" are not misclassified.
 */
export function detectBlock(
  status: number,
  headerSnapshot: Record<string, string>,
  body: string,
): BlockDetection | null {
  const lower = body.toLowerCase();
  const server = headerSnapshot["server"] ?? "";
  const retryAfter = headerSnapshot["retry-after"];

  if (status === 429) {
    return {
      kind: "rate-limited",
      reason: "The site rate-limited the scan (HTTP 429).",
      evidence: `HTTP 429 Too Many Requests${retryAfter ? `, Retry-After: ${retryAfter}` : ""}${server ? `, Server: ${server}` : ""}`,
    };
  }
  if (status === 401) {
    return { kind: "auth-required", reason: "The page requires authentication (HTTP 401).", evidence: `HTTP 401 Unauthorized${server ? `, Server: ${server}` : ""}` };
  }
  if (status === 403 || status === 407 || status === 999) {
    return { kind: "access-denied", reason: "The site refused the request (bot protection or access rules).", evidence: `HTTP ${status}${server ? `, Server: ${server}` : ""}, cf-ray: ${headerSnapshot["cf-ray"] ?? "not present"}` };
  }
  if (status === 451) {
    return { kind: "legal", reason: "The response was blocked for legal reasons (HTTP 451).", evidence: `HTTP 451 Unavailable For Legal Reasons` };
  }
  if (status === 404) {
    return { kind: "not-found", reason: "The page does not exist (HTTP 404).", evidence: `HTTP 404 Not Found${server ? `, Server: ${server}` : ""}` };
  }

  for (const marker of STRONG_CHALLENGE_MARKERS) {
    if (lower.includes(marker)) {
      return {
        kind: "challenge",
        reason: "A bot-protection challenge page was returned instead of the site content.",
        evidence: `Response body contains "${marker}"${server ? `, Server: ${server}` : ""}`,
      };
    }
  }

  if (status >= 500) {
    return { kind: "server-error", reason: `The server returned an error (HTTP ${status}).`, evidence: `HTTP ${status}${server ? `, Server: ${server}` : ""}` };
  }

  if (status >= 400) {
    for (const marker of WEAK_CHALLENGE_MARKERS) {
      if (lower.includes(marker)) {
        return {
          kind: "challenge",
          reason: "The site returned an error page with bot-protection markers.",
          evidence: `HTTP ${status} and body contains "${marker}"`,
        };
      }
    }
  }

  return null;
}

/** Is this response an HTML document we can meaningfully analyze? */
export function isHtmlResponse(contentType: string | null, body: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
    // Explicit non-HTML type (json, image, pdf…) → not a page.
    if (ct.includes("/")) return false;
  }
  // No usable content type: fall back to sniffing the body.
  const head = body.slice(0, 512).toLowerCase().trim();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<html");
}
