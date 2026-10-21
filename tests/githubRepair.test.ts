// Phase 5 — GitHub Repair Agent: authorization, repository isolation, safe
// file access, deterministic repair proposals, approval gates and failure
// handling. Real handlers against convex-test's in-memory backend; GitHub's
// HTTP API is replaced by a recording global fetch (no network, no secrets).
//
// Proves, among others:
//  * the OAuth token never leaves the server (public outputs are asserted
//    token-free), and no user can see or act on another user's connection or
//    proposals;
//  * paths/branches/repos from every client argument are validated, secret
//    files are never read, oversized files are refused;
//  * unsupported findings return an honest "manual fix required" result;
//  * approval is per-proposal, one-shot, expiry-checked and owner-checked;
//  * the PR write path is OFF by default and makes ZERO GitHub requests when
//    disabled, unapproved, or called by the wrong user.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { api, internal } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import schema from "../src/convex/schema";
import { issueKey, type RecommendationIssue } from "../src/lib/recommendations";
import {
  GH_ANALYZE_LIMIT_PER_HOUR,
  GH_MAX_FILE_BYTES,
  PR_BRANCH_PREFIX,
  applyRepair,
  isSecretRepoPath,
  isValidBranchName,
  isValidRepoFullName,
  isValidRepoPath,
  isValidReturnPath,
  parseFileContent,
  parseRepos,
  prBodyFor,
  repairBranchName,
  sanitizeTree,
  selectRepairTarget,
  unifiedDiff,
} from "../src/lib/githubRepair";

const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "github.ts": () => import("../src/convex/github.ts"),
  "githubActions.ts": () => import("../src/convex/githubActions.ts"),
  "rateLimit.ts": () => import("../src/convex/rateLimit.ts"),
  "scans.ts": () => import("../src/convex/scans.ts"),
  // Phase 7: analyzeRepair's plan gate resolves entitlements through the
  // internal billing query, so convex-test must be able to load the module.
  "billing.ts": () => import("../src/convex/billing.ts"),
};

const freshBackend = () => convexTest(schema, modules);

async function createTestUser(t: ReturnType<typeof freshBackend>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    // Phase 7: the Repair Agent is a paid feature — test users hold an active
    // Pro subscription so this suite exercises repair logic, not the plan
    // gate (the gate itself is covered in tests/billing.test.ts).
    await ctx.db.insert("subscriptions", {
      userId,
      plan: "pro",
      status: "active",
      currency: "USD",
      provider: "simulated",
      amountPerPeriod: 500,
      currentPeriodStart: Date.now(),
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      cancelAtPeriodEnd: false,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return userId;
  });
}

function signedInAs(t: ReturnType<typeof freshBackend>, userId: string) {
  return t.withIdentity({ subject: `${userId}|session1` });
}

async function connectAs(t: ReturnType<typeof freshBackend>, userId: Id<"users">, token = "gho_super_secret_token") {
  return await t.run((ctx) =>
    ctx.db.insert("githubConnections", {
      userId,
      provider: "github",
      login: "octocat",
      scopes: "public_repo",
      token,
      connectedAt: Date.now(),
    }),
  );
}

const CHECKS = { score: 50, passed: 1, failed: 1, warnings: 0, notChecked: 0 };

const viewportFinding: RecommendationIssue = {
  category: "SEO",
  severity: "warning",
  priority: "important",
  message: "No viewport meta tag.",
  whyItMatters: "Without it, mobile browsers render at desktop width.",
  howToFix: "Add a viewport meta tag to the head.",
  checkKey: "viewport",
  status: "fail",
};

async function seedScan(
  t: ReturnType<typeof freshBackend>,
  issues: RecommendationIssue[] = [viewportFinding],
) {
  return await t.run((ctx) =>
    ctx.db.insert("scans", {
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      status: 200,
      https: true,
      redirects: 0,
      responseTime: 120,
      pageSize: 1024,
      pageSizeFormatted: "1.0 KB",
      hasViewport: issues.length === 0,
      hasCharset: true,
      hasLanguage: true,
      hasH1: true,
      h1Count: 1,
      imageCount: 1,
      imagesWithoutAlt: 0,
      linkCount: 3,
      scriptCount: 0,
      styleCount: 0,
      internalLinkCount: 3,
      externalLinkCount: 0,
      hasCSP: false,
      hasXFrameOptions: true,
      hasXContentTypeOptions: true,
      hasStrictTransportSecurity: false,
      hasXPermittedCrossDomainPolicies: true,
      hasReferrerPolicy: false,
      hasPermissionsPolicy: true,
      serverInfo: { technology: [] },
      score: 60,
      grade: "D",
      performanceScore: 70,
      seoScore: 60,
      securityScore: 40,
      accessibilityScore: 80,
      technicalHealthScore: 65,
      performanceChecks: CHECKS,
      seoChecks: CHECKS,
      securityChecks: CHECKS,
      accessibilityChecks: CHECKS,
      technicalHealthChecks: CHECKS,
      issues,
      topIssues: [],
      quickWins: [],
      totalChecksCompleted: 10,
      totalPassed: 6,
      totalFailed: 2,
      totalWarnings: 2,
      scannedAt: Date.now(),
    }),
  );
}

/** Temporarily set/unset an env var (never a real secret — test values only). */
async function withEnv(key: string, value: string | undefined, fn: () => Promise<void>) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

/** Replace global fetch with a recorder; asserts happen on `calls`. */
function spyFetch(routes: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const res = routes(url, init);
    if (!res) throw new TypeError(`unexpected fetch in test: ${url}`);
    return res;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ── 1. Safe input validation & file access (pure) ─────────────────────────── */

describe("input validation — every client string that reaches an API path", () => {
  test("repository full names: conservative charset and shape", () => {
    expect(isValidRepoFullName("octo/site")).toBe(true);
    expect(isValidRepoFullName("my-org.my_site/my.repo-1")).toBe(true);
    expect(isValidRepoFullName("octo/site/extra")).toBe(false);
    expect(isValidRepoFullName("../evil/repo")).toBe(false);
    expect(isValidRepoFullName("own er/repo")).toBe(false);
    expect(isValidRepoFullName("")).toBe(false);
    expect(isValidRepoFullName(`o/${"a".repeat(200)}`)).toBe(false);
    expect(isValidRepoFullName(42)).toBe(false);
  });

  test("branch names: no traversal, no ambiguity, bounded", () => {
    expect(isValidBranchName("main")).toBe(true);
    expect(isValidBranchName("release/1.0")).toBe(true);
    expect(isValidBranchName("..")).toBe(false);
    expect(isValidBranchName("a/../b")).toBe(false);
    expect(isValidBranchName("/abs")).toBe(false);
    expect(isValidBranchName("trailing/")).toBe(false);
    expect(isValidBranchName("has space")).toBe(false);
    expect(isValidBranchName("")).toBe(false);
    expect(isValidBranchName("a".repeat(300))).toBe(false);
  });

  test("repository paths: relative, printable, no traversal", () => {
    expect(isValidRepoPath("public/index.html")).toBe(true);
    expect(isValidRepoPath("/etc/passwd")).toBe(false);
    expect(isValidRepoPath("a/../../b")).toBe(false);
    expect(isValidRepoPath("..")).toBe(false);
    expect(isValidRepoPath("a\\b")).toBe(false);
    expect(isValidRepoPath("bad\u0000path")).toBe(false);
  });

  test("secrets-shaped files are classified as never-readable", () => {
    for (const p of [
      ".env",
      "config/.env.local",
      "server.pem",
      "tls/key.pem",
      "id_rsa",
      "credentials.json",
      ".aws/credentials",
      ".ssh/id_ed25519",
    ]) {
      expect(isSecretRepoPath(p)).toBe(true);
    }
    for (const p of ["index.html", "public/_headers", "robots.txt", "vercel.json"]) {
      expect(isSecretRepoPath(p)).toBe(false);
    }
  });

  test("OAuth return paths can never leave the origin", () => {
    expect(isValidReturnPath("/report/abc")).toBe(true);
    expect(isValidReturnPath("//evil.example")).toBe(false);
    expect(isValidReturnPath("https://evil.example")).toBe(false);
    expect(isValidReturnPath("/path\u0007")).toBe(false);
  });
});

describe("GitHub API payloads are sanitized before use", () => {
  test("tree sanitization drops secrets, build output, non-blobs and invalid paths", () => {
    const { entries, truncated } = sanitizeTree({
      tree: [
        { path: "index.html", type: "blob", size: 10 },
        { path: ".env", type: "blob" },
        { path: "certs/server.pem", type: "blob" },
        { path: "dist/bundle.js", type: "blob" },
        { path: "node_modules/pkg/index.js", type: "blob" },
        { path: "../escape.txt", type: "blob" },
        { path: "/abs.txt", type: "blob" },
        { path: "src", type: "tree" },
        { path: 123, type: "blob" },
      ],
      truncated: false,
    });
    expect(entries.map((e) => e.path)).toEqual(["index.html"]);
    expect(truncated).toBe(false);
  });

  test("malformed or oversized trees are refused as truncated (fail closed)", () => {
    expect(sanitizeTree(null)).toEqual({ entries: [], truncated: true });
    expect(sanitizeTree({ tree: "nope" })).toEqual({ entries: [], truncated: true });
    const big = Array.from({ length: 5_000 }, (_, i) => ({ path: `f${i}.txt`, type: "blob" }));
    const res = sanitizeTree({ tree: big, truncated: false });
    expect(res.entries.length).toBe(4_000);
    expect(res.truncated).toBe(true);
  });

  test("file content: size cap enforced and malformed payloads refused", () => {
    const text = "<html></html>";
    const ok = parseFileContent({
      encoding: "base64",
      size: text.length,
      content: btoa(text),
    });
    expect(ok).toEqual({ ok: true, text });
    expect(parseFileContent({ encoding: "base64", size: GH_MAX_FILE_BYTES + 1, content: "AAAA" })).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(parseFileContent({ encoding: "none", content: "AAAA" })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(parseFileContent(null)).toEqual({ ok: false, reason: "malformed" });
  });

  test("repository listings drop malformed entries", () => {
    const repos = parseRepos([
      { full_name: "octo/site", default_branch: "main", private: false, permissions: { push: true } },
      { full_name: "bad name/repo", default_branch: "main" },
      { full_name: "octo/no-default" },
      "not-an-object",
    ]);
    expect(repos).toEqual([
      { fullName: "octo/site", defaultBranch: "main", private: false, permissionsPush: true },
    ]);
  });
});

/* ── 2. Deterministic repair proposals (pure) ──────────────────────────────── */

describe("target discovery — honest unsupported results", () => {
  const entries = (paths: string[]) => paths.map((p) => ({ path: p, type: "blob" }));

  test("security header uses an existing _headers file", () => {
    const issue: RecommendationIssue = {
      ...viewportFinding,
      category: "Security",
      message: "Missing Referrer-Policy header.",
      howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
    };
    expect(selectRepairTarget(issue, "unknown", entries(["public/_headers", "index.html"]))).toEqual({
      kind: "read",
      path: "public/_headers",
    });
  });

  test("security header without _headers and unknown platform → manual fix required", () => {
    const issue: RecommendationIssue = {
      ...viewportFinding,
      category: "Security",
      message: "Missing X-Frame-Options header.",
      howToFix: "Add the header: X-Frame-Options: DENY",
    };
    const res = selectRepairTarget(issue, "unknown", entries(["index.html"]));
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") expect(res.reason).toContain("manual fix required");
  });

  test("viewport finding targets index.html, never build output", () => {
    const res = selectRepairTarget(viewportFinding, "unknown", entries(["dist/index.html"]));
    expect(res.kind).toBe("unsupported"); // only a build copy exists
  });

  test("sitemap findings are honestly unsupported (no invented URLs)", () => {
    const res = selectRepairTarget(
      { ...viewportFinding, message: "No sitemap.xml found." },
      "unknown",
      entries(["index.html"]),
    );
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") expect(res.reason).toContain("Manual fix required");
  });

  test("robots.txt discovery prefers root and creates under public/ when present", () => {
    const issue = { ...viewportFinding, message: "No robots.txt file found." };
    expect(selectRepairTarget(issue, "unknown", entries(["robots.txt"]))).toEqual({
      kind: "read",
      path: "robots.txt",
    });
    expect(selectRepairTarget(issue, "unknown", entries(["public/index.html"]))).toEqual({
      kind: "create",
      path: "public/robots.txt",
    });
  });
});

describe("deterministic edits on real file text", () => {
  const html = `<!DOCTYPE html>\n<html>\n<head>\n<title>Real page</title>\n</head>\n<body>hi</body>\n</html>\n`;

  test("head insert: real before/after, instruction comment stripped, divergence refused", () => {
    const plan = applyRepair({
      issue: viewportFinding,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "index.html",
      existed: true,
      before: html,
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.after).toContain('<meta name="viewport"');
    expect(plan.after.indexOf('<meta name="viewport"')).toBeLessThan(plan.after.indexOf("</head>"));
    expect(plan.after).not.toContain("<!-- Add inside <head> -->");
    // Divergence: the repo already has it → never "fix" it.
    const diverged = applyRepair({
      issue: viewportFinding,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "index.html",
      existed: true,
      before: html.replace("<title>", '<meta name="viewport" content="x">\n<title>'),
    });
    expect(diverged.kind).toBe("unsupported");
    if (diverged.kind === "unsupported") expect(diverged.reason).toContain("already contains");
  });

  test("_headers append: only the missing header, duplicate refused", () => {
    const issue: RecommendationIssue = {
      ...viewportFinding,
      category: "Security",
      message: "Missing Referrer-Policy header.",
      howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
    };
    const plan = applyRepair({
      issue,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "public/_headers",
      existed: true,
      before: "/*\n  X-Frame-Options: DENY\n",
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.after).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(plan.after).toContain("X-Frame-Options: DENY"); // untouched
    const dup = applyRepair({
      issue,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "public/_headers",
      existed: true,
      before: "/*\n  Referrer-Policy: same-origin\n",
    });
    expect(dup.kind).toBe("unsupported");
  });

  test("robots.txt creation uses the scanned origin; existing directives refused", () => {
    const issue = { ...viewportFinding, message: "No robots.txt file found." };
    const created = applyRepair({
      issue,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "robots.txt",
      existed: false,
      before: "",
    });
    expect(created.kind).toBe("ok");
    if (created.kind === "ok") {
      expect(created.after).toContain("Sitemap: https://example.com/sitemap.xml");
      expect(created.after).toContain("User-agent: *");
    }
    const existing = applyRepair({
      issue,
      platform: "unknown",
      scanOrigin: "https://example.com",
      targetPath: "robots.txt",
      existed: true,
      before: "User-agent: *\nDisallow: /admin\n",
    });
    expect(existing.kind).toBe("unsupported"); // merge needs human judgment
  });
});

describe("unified diffs and PR text", () => {
  test("insertion diff: real hunk, context lines, zero fabricated deletions", () => {
    const before = "line1\nline2\nline3\nline4\nline5\n";
    const after = `${before}INSERTED\n`;
    const diff = unifiedDiff(before, after, "index.html");
    expect(diff).toContain("--- a/index.html");
    expect(diff).toContain("+++ b/index.html");
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain("+INSERTED");
    expect(diff).toContain(" line3"); // context retained
    expect(diff).toContain(" line5");
    const deletions = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(deletions).toEqual([]); // pure insertion removes nothing
  });

  test("file creation emits the standard all-additions hunk", () => {
    const diff = unifiedDiff("", "a\nb\n", "robots.txt");
    expect(diff).toContain("(file does not exist yet)");
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff).toContain("+a");
    expect(diff).toContain("+b");
  });

  test("PR text states the safety rules and branch names never target the default branch", () => {
    const body = prBodyFor({
      findingMessage: "No viewport meta tag.",
      targetPath: "index.html",
      explanation: "why",
      scanUrl: "https://example.com/",
    });
    expect(body).toContain("nothing merges or deploys");
    expect(body).toContain("No AI model wrote this change");
    const branch = repairBranchName(1_700_000_000_000, 0.123);
    expect(branch.startsWith(PR_BRANCH_PREFIX)).toBe(true);
    expect(branch).not.toBe("main");
  });
});

/* ── 3. Authorization & repository isolation (real handlers) ───────────────── */

describe("authorization — every operation requires a signed-in owner", () => {
  test("signed-out callers are rejected by every mutation", async () => {
    const t = freshBackend();
    await expect(
      t.mutation(api.github.startConnection, { returnPath: "/" }),
    ).rejects.toThrow("Sign in");
    await expect(t.mutation(api.github.disconnect, {})).rejects.toThrow("Sign in");
    // A well-formed id does not help: the auth check runs first.
    const owner = await createTestUser(t);
    const proposalId = await seedProposal(t, owner);
    await expect(
      t.mutation(api.github.approveAndRequestPr, {
        proposalId,
        confirmRepoFullName: "octo/site",
      }),
    ).rejects.toThrow("Sign in");
    expect(await t.query(api.github.listProposals, {})).toEqual([]);
  });

  test("a connection is invisible to other users and the token never leaves the server", async () => {
    const t = freshBackend();
    const alice = await createTestUser(t);
    const bob = await createTestUser(t);
    await connectAs(t, alice, "gho_alice_secret_token");

    const asAlice = signedInAs(t, alice);
    const seen = await asAlice.query(api.github.getConnection, {});
    expect(seen.connected).toBe(true);
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toContain("gho_alice_secret_token");
    expect(serialized).not.toContain("token");
    expect("login" in seen && seen.login).toBe("octocat");

    const asBob = signedInAs(t, bob);
    expect((await asBob.query(api.github.getConnection, {})).connected).toBe(false);
    // Bob cannot disconnect Alice's connection (no row of his own → no-op).
    expect(await asBob.mutation(api.github.disconnect, {})).toEqual({ disconnected: false });
    const stillThere = await t.run((ctx) => ctx.db.query("githubConnections").collect());
    expect(stillThere).toHaveLength(1);
  });

  test("proposals are owner-scoped in listing and approval", async () => {
    const t = freshBackend();
    const alice = await createTestUser(t);
    const bob = await createTestUser(t);
    const scanId = await seedScan(t);
    const proposalId = await t.run((ctx) =>
      ctx.db.insert("repairProposals", {
        ownerId: alice,
        scanId,
        scanUrl: "https://example.com/",
        repoFullName: "octo/site",
        branch: "main",
        issueKey: "k",
        findingMessage: "No viewport meta tag.",
        category: "SEO",
        targetPath: "index.html",
        fileExisted: true,
        before: "a",
        after: "b",
        diff: "--- a/index.html\n+++ b/index.html\n-a\n+b",
        explanation: "e",
        status: "draft",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    );

    expect(await signedInAs(t, bob).query(api.github.listProposals, {})).toEqual([]);
    const mine = await signedInAs(t, alice).query(api.github.listProposals, {});
    expect(mine).toHaveLength(1);
    // Public output minimization: raw file contents are never returned.
    expect(Object.keys(mine[0])).not.toContain("before");
    expect(Object.keys(mine[0])).not.toContain("after");

    await expect(
      signedInAs(t, bob).mutation(api.github.approveAndRequestPr, {
        proposalId,
        confirmRepoFullName: "octo/site",
      }),
    ).rejects.toThrow("belongs to another account");
  });
});

/* ── 4. OAuth boundary (mocked GitHub, no secrets in outputs) ──────────────── */

describe("OAuth connection boundary", () => {
  test("without configuration the mutation refuses honestly", async () => {
    await withEnv("GITHUB_CLIENT_ID", undefined, async () => {
      const t = freshBackend();
      const user = await createTestUser(t);
      try {
        await signedInAs(t, user).mutation(api.github.startConnection, { returnPath: "/" });
        throw new Error("expected github_not_configured");
      } catch (err) {
        expect(err).toBeInstanceOf(ConvexError);
        expect((err as ConvexError<{ code?: string }>).data.code).toBe("github_not_configured");
      }
    });
  });

  test("startConnection returns a authorize URL with state and NO secret material", async () => {
    await withEnv("GITHUB_CLIENT_ID", "test_client_id", async () => {
      const t = freshBackend();
      const user = await createTestUser(t);
      const res = await signedInAs(t, user).mutation(api.github.startConnection, {
        returnPath: "/report/abc",
      });
      const url = new URL(res.authorizeUrl);
      expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("test_client_id");
      expect(url.searchParams.get("scope")).toBe("public_repo");
      expect(url.searchParams.get("redirect_uri")).toContain("/github/callback");
      const state = url.searchParams.get("state");
      expect(state && state.length).toBeGreaterThan(20);
      expect(res.authorizeUrl).not.toContain("secret");
      const rows = await t.run((ctx) => ctx.db.query("githubOAuthStates").collect());
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(user);
      expect(rows[0].returnPath).toBe("/report/abc");
      expect(rows[0].expiresAt - rows[0].createdAt).toBeLessThanOrEqual(10 * 60_000);
    });
  });

  test("code exchange: token stored server-side only; invalid state makes zero requests", async () => {
    await withEnv("GITHUB_CLIENT_ID", "test_client_id", async () => {
      await withEnv("GITHUB_CLIENT_SECRET", "test_client_secret", async () => {
        const t = freshBackend();
        const user = await createTestUser(t);
        const now = Date.now();
        await t.run((ctx) =>
          ctx.db.insert("githubOAuthStates", {
            state: "valid-state-1",
            userId: user,
            returnPath: "/report/abc",
            createdAt: now,
            expiresAt: now + 60_000,
          }),
        );

        // a) Unknown state → rejected with no network traffic at all.
        const spy = spyFetch(() => undefined);
        const bad = await t.action(internal.githubActions.exchangeOAuthCode, {
          code: "c",
          state: "nope",
        });
        expect(bad.ok).toBe(false);
        expect(bad.error).toBe("invalid_state");
        expect(spy.calls).toHaveLength(0);
        spy.restore();

        // b) Valid state → token exchange + verification, connection stored.
        const spy2 = spyFetch((url) => {
          if (url === "https://github.com/login/oauth/access_token") {
            return jsonResponse({ access_token: "gho_test_token", scope: "public_repo" });
          }
          if (url === "https://api.github.com/user") return jsonResponse({ login: "octo-cat" });
          return undefined;
        });
        const good = await t.action(internal.githubActions.exchangeOAuthCode, {
          code: "valid-code",
          state: "valid-state-1",
        });
        expect(good.ok).toBe(true);
        expect(good.login).toBe("octo-cat");
        // The redirect back into the app carries no token.
        expect(JSON.stringify(good)).not.toContain("gho_test_token");
        // The exchange request carried the secret to GitHub only (server-side).
        const exchangeCall = spy2.calls.find((u) => u.includes("login/oauth/access_token"));
        expect(exchangeCall).toBeDefined();
        spy2.restore();

        const connections = await t.run((ctx) => ctx.db.query("githubConnections").collect());
        expect(connections).toHaveLength(1);
        expect(connections[0].token).toBe("gho_test_token");
        // Single-use: the same state can never be redeemed again.
        const replay = await t.action(internal.githubActions.exchangeOAuthCode, {
          code: "valid-code",
          state: "valid-state-1",
        });
        expect(replay.ok).toBe(false);
      });
    });
  });
});

/* ── 5. Analysis: quotas, honest unsupported, deterministic happy path ─────── */

describe("analyzeRepair — real handler against a recording fetch", () => {
  const html = `<!DOCTYPE html>\n<html>\n<head>\n<title>Real page</title>\n</head>\n<body>hi</body>\n</html>\n`;

  test("signed-out is rejected; unconnected users make zero requests", async () => {
    const t = freshBackend();
    const scanId = await seedScan(t);
    await expect(
      t.action(api.githubActions.analyzeRepair, {
        scanId,
        issueKey: issueKey(viewportFinding),
        repoFullName: "octo/site",
        branch: "main",
      }),
    ).rejects.toThrow("Sign in");

    const user = await createTestUser(t);
    const spy = spyFetch(() => undefined);
    const res = await signedInAs(t, user).action(api.githubActions.analyzeRepair, {
      scanId,
      issueKey: issueKey(viewportFinding),
      repoFullName: "octo/site",
      branch: "main",
    });
    expect(res.kind).toBe("not_connected");
    expect(spy.calls).toHaveLength(0);
    spy.restore();
  });

  test("invalid repository names are refused before any request", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    await connectAs(t, user);
    const scanId = await seedScan(t);
    const spy = spyFetch(() => undefined);
    const res = await signedInAs(t, user).action(api.githubActions.analyzeRepair, {
      scanId,
      issueKey: issueKey(viewportFinding),
      repoFullName: "not a repo",
      branch: "main",
    });
    expect(res.kind).toBe("invalid_input");
    expect(spy.calls).toHaveLength(0);
    spy.restore();
  });

  test("the per-user quota is enforced server-side before any request", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    await connectAs(t, user);
    const scanId = await seedScan(t);
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", {
        key: `github:${user}`,
        windowStart: Date.now(),
        count: GH_ANALYZE_LIMIT_PER_HOUR,
      }),
    );
    const spy = spyFetch(() => undefined);
    const res = await signedInAs(t, user).action(api.githubActions.analyzeRepair, {
      scanId,
      issueKey: issueKey(viewportFinding),
      repoFullName: "octo/site",
      branch: "main",
    });
    expect(res.kind).toBe("quota_limited");
    expect(spy.calls).toHaveLength(0);
    spy.restore();
  });

  test("unsupported findings return honest manual-fix-required (tree fetched, nothing stored)", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    await connectAs(t, user);
    const sitemapFinding: RecommendationIssue = {
      ...viewportFinding,
      message: "No sitemap.xml found.",
    };
    const scanId = await seedScan(t, [sitemapFinding]);
    const spy = spyFetch((url) =>
      url.includes("/git/trees/") ? jsonResponse({ tree: [{ path: "index.html", type: "blob" }], truncated: false }) : undefined,
    );
    const res = await signedInAs(t, user).action(api.githubActions.analyzeRepair, {
      scanId,
      issueKey: issueKey(sitemapFinding),
      repoFullName: "octo/site",
      branch: "main",
    });
    expect(res.kind).toBe("unsupported");
    if (res.kind === "unsupported") expect(res.reason).toContain("Manual fix required");
    expect(await t.run((ctx) => ctx.db.query("repairProposals").collect())).toHaveLength(0);
    spy.restore();
  });

  test("happy path: reads only the target file, produces a verified diff, stores a draft", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    await connectAs(t, user);
    const scanId = await seedScan(t);
    const spy = spyFetch((url) => {
      if (url.includes("/git/trees/")) {
        return jsonResponse({
          tree: [
            { path: "index.html", type: "blob", size: html.length },
            { path: ".env", type: "blob" },
          ],
          truncated: false,
        });
      }
      if (url.includes("/contents/index.html")) {
        return jsonResponse({ encoding: "base64", size: html.length, content: btoa(html) });
      }
      if (url.includes("/contents/.env")) {
        throw new Error("MUST NEVER READ A SECRET FILE");
      }
      return undefined;
    });
    const res = await signedInAs(t, user).action(api.githubActions.analyzeRepair, {
      scanId,
      issueKey: issueKey(viewportFinding),
      repoFullName: "octo/site",
      branch: "main",
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.targetPath).toBe("index.html");
    expect(res.fileExisted).toBe(true);
    expect(res.diff).toContain("+<meta name=\"viewport\"");
    expect(res.explanation.length).toBeGreaterThan(20);
    // Exactly two reads: tree + the one target file.
    expect(spy.calls).toHaveLength(2);
    spy.restore();

    const rows = await t.run((ctx) => ctx.db.query("repairProposals").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("draft");
    expect(rows[0].ownerId).toBe(user);
  });
});

/* ── 6. Approval gates ─────────────────────────────────────────────────────── */

async function seedProposal(
  t: ReturnType<typeof freshBackend>,
  ownerId: Id<"users">,
  over: Record<string, unknown> = {},
): Promise<Id<"repairProposals">> {
  const scanId = await seedScan(t);
  return await t.run((ctx) =>
    ctx.db.insert("repairProposals", {
      ownerId,
      scanId,
      scanUrl: "https://example.com/",
      repoFullName: "octo/site",
      branch: "main",
      issueKey: "k",
      findingMessage: "No viewport meta tag.",
      category: "SEO",
      targetPath: "index.html",
      fileExisted: true,
      before: "<html></html>",
      after: "<html>fixed</html>",
      diff: "--- a/index.html\n+++ b/index.html\n+fixed",
      explanation: "e",
      status: "draft",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...over,
    }),
  );
}

describe("approval — per-proposal, explicit, one-shot, expiry-checked", () => {
  test("confirmation must name the proposal's repository exactly", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    const proposalId = await seedProposal(t, user);
    await expect(
      signedInAs(t, user).mutation(api.github.approveAndRequestPr, {
        proposalId,
        confirmRepoFullName: "octo/other",
      }),
    ).rejects.toThrow("must name this proposal's repository");
  });

  test("approval is one-shot and expired proposals cannot be approved", async () => {
    const t = freshBackend();
    const user = await createTestUser(t);
    const proposalId = await seedProposal(t, user);
    const me = signedInAs(t, user);
    const first = await me.mutation(api.github.approveAndRequestPr, {
      proposalId,
      confirmRepoFullName: "octo/site",
    });
    expect(first.status).toBe("pr_requested");
    await expect(
      me.mutation(api.github.approveAndRequestPr, {
        proposalId,
        confirmRepoFullName: "octo/site",
      }),
    ).rejects.toThrow("already been approved");

    const expiredId = await seedProposal(t, user, { expiresAt: Date.now() - 1_000 });
    await expect(
      me.mutation(api.github.approveAndRequestPr, {
        proposalId: expiredId,
        confirmRepoFullName: "octo/site",
      }),
    ).rejects.toThrow("expired");
  });
});

/* ── 7. Write path: OFF by default, zero requests when gated ───────────────── */

describe("createPullRequest — write safety gates", () => {
  test("write disabled (default): approved proposal, ZERO requests to GitHub", async () => {
    await withEnv("GITHUB_WRITE_ENABLED", undefined, async () => {
      const t = freshBackend();
      const user = await createTestUser(t);
      await connectAs(t, user);
      const proposalId = await seedProposal(t, user, { status: "pr_requested" });
      const spy = spyFetch(() => undefined);
      const res = await signedInAs(t, user).action(api.githubActions.createPullRequest, {
        proposalId,
      });
      expect(res.kind).toBe("write_disabled");
      expect(spy.calls).toHaveLength(0);
      spy.restore();
    });
  });

  test("write enabled but NOT approved → refused with zero requests", async () => {
    await withEnv("GITHUB_WRITE_ENABLED", "true", async () => {
      const t = freshBackend();
      const user = await createTestUser(t);
      await connectAs(t, user);
      const proposalId = await seedProposal(t, user); // status: draft
      const spy = spyFetch(() => undefined);
      const res = await signedInAs(t, user).action(api.githubActions.createPullRequest, {
        proposalId,
      });
      expect(res.kind).toBe("not_approved");
      expect(spy.calls).toHaveLength(0);
      spy.restore();
    });
  });

  test("another user cannot drive the write path for someone else's proposal", async () => {
    await withEnv("GITHUB_WRITE_ENABLED", "true", async () => {
      const t = freshBackend();
      const alice = await createTestUser(t);
      const bob = await createTestUser(t);
      await connectAs(t, alice);
      await connectAs(t, bob);
      const proposalId = await seedProposal(t, alice, { status: "pr_requested" });
      const spy = spyFetch(() => undefined);
      const res = await signedInAs(t, bob).action(api.githubActions.createPullRequest, {
        proposalId,
      });
      expect(res.kind).toBe("not_found"); // owner-scoped internal read returns nothing
      expect(spy.calls).toHaveLength(0);
      spy.restore();
    });
  });

  test("stale files are refused before any write", async () => {
    await withEnv("GITHUB_WRITE_ENABLED", "true", async () => {
      const t = freshBackend();
      const user = await createTestUser(t);
      await connectAs(t, user);
      const proposalId = await seedProposal(t, user, { status: "pr_requested" });
      const spy = spyFetch((url) => {
        if (url.endsWith("/repos/octo/site")) {
          return jsonResponse({ permissions: { push: true } });
        }
        if (url.includes("/contents/index.html")) {
          // Remote file no longer matches what the proposal diffed against.
          return jsonResponse({ encoding: "base64", size: 5, content: btoa("other") });
        }
        return undefined;
      });
      const res = await signedInAs(t, user).action(api.githubActions.createPullRequest, {
        proposalId,
      });
      expect(res.kind).toBe("stale");
      // Only read calls: repo + contents. No blob/tree/commit/ref/pull writes.
      expect(spy.calls.filter((u) => u.includes("/git/blobs"))).toHaveLength(0);
      expect(spy.calls.filter((u) => u.includes("/pulls"))).toHaveLength(0);
      spy.restore();
    });
  });
});

/* ── 8. Source pins: wiring a runtime test cannot observe ──────────────────── */

describe("wiring pins — safety rules in the shipped source", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

  test("the write gate precedes every GitHub request in createPullRequest", () => {
    const src = read("src/convex/githubActions.ts");
    const start = src.indexOf("export const createPullRequest");
    const block = src.slice(start);
    expect(block).toContain('process.env.GITHUB_WRITE_ENABLED !== "true"');
    expect(block.indexOf("GITHUB_WRITE_ENABLED")).toBeLessThan(block.indexOf("await fetch"));
    expect(block).toContain('status !== "pr_requested"');
    expect(block).toContain("parsed.text !== proposal.before"); // stale guard
    // A NEW branch is created via repairBranchName() and opened as the PR head
    // against the selected base — the selected/default branch is never pushed to.
    expect(block).toContain("repairBranchName()");
    expect(block).toContain("head: branchName");
    expect(block).toContain("base: proposal.branch");
    // Merging stays a human action on GitHub; the code never merges or deploys.
    expect(block).toContain("merges");
    expect(block).not.toContain("mergeBranch");
    expect(block).not.toContain("/merge");
  });

  test("public GitHub functions never return the token; secrets stay internal", () => {
    const src = read("src/convex/github.ts");
    const getConnectionStart = src.indexOf("export const getConnection");
    const disconnectStart = src.indexOf("export const disconnect");
    const publicBlock = src.slice(getConnectionStart, disconnectStart);
    // The connection query's return shape has no token field at all.
    expect(publicBlock).not.toContain("token:");
    expect(publicBlock).not.toContain("row.token");
    // Token reads exist only as internal functions.
    expect(src).toContain("export const getOwnConnectionSecret = internalQuery");
    expect(read("src/lib/githubRepair.ts")).not.toContain("gho_");
  });

  test("the HTTP callback routes through the internal exchange action", () => {
    const http = read("src/convex/http.ts");
    expect(http).toContain('path: "/github/callback"');
    expect(http).toContain("exchangeOAuthCode");
    expect(http).toContain("isValidReturnPath");
    // The UI section ships the honest write-disabled notice.
    expect(read("src/components/GitHubRepair.tsx")).toContain("disabled on this deployment");
  });
});
