import { describe, expect, test } from "bun:test";
import { detectBlock, fetchTarget, isHtmlResponse } from "../src/lib/fetchTarget";

function response(
  status: number,
  body = "",
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

describe("fetchTarget — redirect chain", () => {
  test("follows redirects manually and records the chain, final URL and status", async () => {
    const hops: Record<string, Response> = {
      "https://example.com/": response(301, "", { Location: "/start" }),
      "https://example.com/start": response(302, "", { Location: "https://www.example.com/home" }),
      "https://www.example.com/home": response(200, "<html><title>Home</title></html>", {
        "content-type": "text/html; charset=utf-8",
        server: "nginx",
      }),
    };
    const outcome = await fetchTarget("https://example.com/", {
      fetchImpl: (input) => Promise.resolve(hops[String(input)]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetch.requestedUrl).toBe("https://example.com/");
    expect(outcome.fetch.finalUrl).toBe("https://www.example.com/home");
    expect(outcome.fetch.status).toBe(200);
    expect(outcome.fetch.chain.map((h) => h.status)).toEqual([301, 302]);
    expect(outcome.fetch.chain[1].location).toBe("https://www.example.com/home");
    expect(outcome.fetch.headerSnapshot["server"]).toBe("nginx");
    expect(outcome.fetch.contentType).toContain("text/html");
    expect(outcome.fetch.body).toContain("<title>Home</title>");
    expect(outcome.fetch.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.fetch.truncated).toBe(false);
  });

  test("self-redirect is detected as a loop instead of hanging", async () => {
    const outcome = await fetchTarget("https://loop.test/", {
      fetchImpl: () => Promise.resolve(response(302, "", { Location: "/same" })),
    });
    // First hop: / → /same (different URL, allowed), second: /same → /same = loop
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("redirect-loop");
  });

  test("redirect without Location keeps the redirect response as final", async () => {
    const outcome = await fetchTarget("https://example.com/", {
      fetchImpl: () => Promise.resolve(response(301, "moved")),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetch.status).toBe(301);
    expect(outcome.fetch.chain).toHaveLength(0);
  });
});

describe("fetchTarget — failures", () => {
  test("timeout becomes a typed timeout outcome with a user-facing message", async () => {
    const err = new Error("operation timed out");
    err.name = "TimeoutError";
    const outcome = await fetchTarget("https://slow.test/", {
      fetchImpl: () => Promise.reject(err),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("timeout");
    expect(outcome.message).toContain("took too long");
  });

  test("network failure keeps the requested URL in the message", async () => {
    const outcome = await fetchTarget("https://down.test/", {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("network");
    expect(outcome.message).toContain("https://down.test/");
  });

  test("SSRF guard failure surfaces as unsafe", async () => {
    const outcome = await fetchTarget("https://example.com/", {
      fetchImpl: () => Promise.resolve(response(200)),
      assertSafe: () => Promise.reject(new Error("Redirect target is a private or restricted address.")),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("unsafe");
  });

  test("oversized body is refused", async () => {
    const outcome = await fetchTarget("https://example.com/big", {
      fetchImpl: () => Promise.resolve(response(200, "x".repeat(2000))),
      maxBytes: 1000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("too-large");
  });

  test("invalid URL is rejected before any request", async () => {
    let called = false;
    const outcome = await fetchTarget("not a url", {
      fetchImpl: () => {
        called = true;
        return Promise.resolve(response(200));
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("invalid");
    expect(called).toBe(false);
  });
});

describe("fetchTarget — incomplete responses", () => {
  test("declared content-length larger than received bytes marks truncated", async () => {
    const outcome = await fetchTarget("https://example.com/cut", {
      fetchImpl: () => Promise.resolve(response(200, "<html>partial", { "content-length": "999999" })),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetch.truncated).toBe(true);
  });

  test("complete response is not marked truncated", async () => {
    const outcome = await fetchTarget("https://example.com/ok", {
      fetchImpl: () => Promise.resolve(response(200, "<html>full", { "content-length": "9" })),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fetch.truncated).toBe(false);
  });
});

describe("detectBlock — blocked scans", () => {
  test("429 with Retry-After is rate limiting, with exact evidence", () => {
    const block = detectBlock(429, { "retry-after": "120", server: "cloudflare" }, "");
    expect(block?.kind).toBe("rate-limited");
    expect(block?.evidence).toContain("HTTP 429");
    expect(block?.evidence).toContain("Retry-After: 120");
  });

  test("403 is access denied (bot protection / access rules)", () => {
    const block = detectBlock(403, { server: "cloudflare", "cf-ray": "abc123" }, "");
    expect(block?.kind).toBe("access-denied");
    expect(block?.evidence).toContain("HTTP 403");
    expect(block?.evidence).toContain("cf-ray: abc123");
  });

  test("200 challenge page is detected via strong markers", () => {
    const block = detectBlock(200, { server: "cloudflare" }, "<html>cf-chl-xyz challenge-platform</html>");
    expect(block?.kind).toBe("challenge");
    expect(block?.evidence).toContain("cf-chl-");
  });

  test("no false positive: a 200 page that merely mentions captcha is not a block", () => {
    const body = "<html><body><h1>How to solve a captcha</h1><p>captcha tips</p></body></html>";
    expect(detectBlock(200, {}, body)).toBeNull();
  });

  test("404 is not-found — a real observation, not a bot block", () => {
    const block = detectBlock(404, { server: "nginx" }, "<html>404</html>");
    expect(block?.kind).toBe("not-found");
  });

  test("5xx is a server error block", () => {
    const block = detectBlock(503, { server: "nginx" }, "");
    expect(block?.kind).toBe("server-error");
  });

  test("healthy 200 response produces no block", () => {
    expect(detectBlock(200, { server: "nginx" }, "<html><body>hello</body></html>")).toBeNull();
  });
});

describe("isHtmlResponse", () => {
  test("html content type", () => {
    expect(isHtmlResponse("text/html; charset=utf-8", "")).toBe(true);
  });
  test("explicit non-html content type", () => {
    expect(isHtmlResponse("application/json", "<html>")).toBe(false);
    expect(isHtmlResponse("image/png", "")).toBe(false);
  });
  test("missing content type sniffs the body", () => {
    expect(isHtmlResponse(null, "<!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlResponse(null, '{"ok":true}')).toBe(false);
  });
});
