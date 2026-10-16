// Security regression: the post-sign-in redirect (returnTo) stays on-origin.
//
// RequireAuth sends signed-out users to /auth?returnTo=<path>. An attacker can
// craft that URL, so Auth.tsx must only ever navigate to a same-origin plain
// path (src/lib/redirects.ts) — everything else falls back to /dashboard.

import { describe, expect, test } from "bun:test";
import { resolveRedirectAfterAuth } from "../src/lib/redirects";

describe("returnTo allowlist — same-origin plain paths pass", () => {
  test("accepts app paths, including the default destinations", () => {
    expect(resolveRedirectAfterAuth("/dashboard")).toBe("/dashboard");
    expect(resolveRedirectAfterAuth("/monitors")).toBe("/monitors");
    expect(resolveRedirectAfterAuth("/")).toBe("/");
    expect(resolveRedirectAfterAuth("/report/abc123")).toBe("/report/abc123");
  });

  test("a returnTo built by RequireAuth round-trips through its encoding", () => {
    // RequireAuth does `encodeURIComponent(pathname + search)`; after the
    // router decodes it the allowlist still sees a safe plain path.
    const produced = encodeURIComponent("/monitors");
    expect(resolveRedirectAfterAuth(decodeURIComponent(produced))).toBe(
      "/monitors",
    );
  });
});

describe("returnTo allowlist — off-app targets are rejected", () => {
  const offApp = [
    "https://evil.com",
    "http://evil.com",
    "//evil.com",
    "//evil.com/path",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "evil.com",
    "dashboard",
    "",
    " ",
  ];

  test("every off-app target falls back to /dashboard", () => {
    for (const value of offApp) {
      expect(resolveRedirectAfterAuth(value)).toBe("/dashboard");
    }
  });

  test("null/undefined fall back to /dashboard", () => {
    expect(resolveRedirectAfterAuth(null)).toBe("/dashboard");
  });

  test("a custom fallback replaces the default", () => {
    expect(resolveRedirectAfterAuth(null, "/landing")).toBe("/landing");
    expect(resolveRedirectAfterAuth("//evil.com", "/landing")).toBe("/landing");
    // A valid returnTo still wins over the fallback.
    expect(resolveRedirectAfterAuth("/monitors", "/landing")).toBe("/monitors");
  });
});

describe("returnTo allowlist — traversal and query/fragment tricks are rejected", () => {
  const traversal = [
    "/../dashboard",
    "/monitors/../dashboard",
    "/././dashboard",
    "/monitors/../../etc/passwd",
  ];

  test("directory traversal falls back to /dashboard", () => {
    for (const value of traversal) {
      expect(resolveRedirectAfterAuth(value)).toBe("/dashboard");
    }
  });

  test("query strings and fragments are rejected (plain paths only)", () => {
    expect(resolveRedirectAfterAuth("/dashboard?x=1")).toBe("/dashboard");
    expect(resolveRedirectAfterAuth("/dashboard#frag")).toBe("/dashboard");
    // RequireAuth preserves location.search, so search-bearing paths land on
    // the fallback by design — documented here as the intended strictness.
    expect(resolveRedirectAfterAuth("/monitors?tab=1")).toBe("/dashboard");
  });
});
