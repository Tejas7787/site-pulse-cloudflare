// SitePulse fix-proposal integration tests (Vitest + convex-test).
//
// The real proposeFixes action (src/convex/aiAssistant.ts) runs against
// convex-test's in-memory backend — real handlers, not source-text checks:
//   - the quota is consumed server-side FIRST (persisted rateLimits rows),
//     per visitor, and the limit travels with the quotaExceeded result;
//   - the scan is fetched SERVER-SIDE by id; a client-supplied `issues`
//     payload is rejected by argument validation (proposals can only
//     describe the stored document);
//   - an unknown/deleted scan id returns notFound (after the quota, pinning
//     the runtime order);
//   - proposals are hosting-specific and deterministic. No external API key,
//     no website probe, no network, no GitHub, no production data, no
//     deployment, no mocked ctx.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import schema from "../src/convex/schema";
import { FIX_PROPOSAL_LIMIT_PER_HOUR } from "../src/lib/fixProposal";

// convex-test loads Convex function modules on demand from this map. Keys are
// paths relative to the functions root (src/convex, per convex.json) with the
// extension kept; at least one key must contain "_generated" so convex-test
// can locate the root prefix. Values are lazy importers so only the modules a
// test reaches are ever evaluated.
const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "aiAssistant.ts": () => import("../src/convex/aiAssistant.ts"),
  "scans.ts": () => import("../src/convex/scans.ts"),
  "rateLimit.ts": () => import("../src/convex/rateLimit.ts"),
};

/** Fresh in-memory backend per test: isolated test data, nothing shared. */
function freshBackend() {
  return convexTest(schema, modules);
}

const CHECKS = { score: 50, passed: 1, failed: 1, warnings: 0, notChecked: 0 };

/** A real-shape finding, exactly as the scan engine stores it. */
const referrerPolicyIssue = {
  category: "Security",
  severity: "warning",
  priority: "important",
  message: "Missing Referrer-Policy header.",
  whyItMatters:
    "Without Referrer-Policy, browsers send full URLs as referrer information to other sites. What this does not mean: nothing was exploited — the scan only observed that the header was missing from this response.",
  howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
  evidence:
    "Referrer-Policy was not present in the response headers of https://example.com/ (HTTP 200).",
  stage: "headers",
  method: "http",
  checkKey: "rp",
  status: "warning",
  confirmed: false,
};

/** Insert a saved scan document straight through the real schema. */
async function seedScan(
  t: ReturnType<typeof freshBackend>,
  serverInfo: { server?: string; technology: string[] } = { server: "nginx/1.24.0", technology: [] },
): Promise<Id<"scans">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("scans", {
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      status: 200,
      https: true,
      redirects: 0,
      responseTime: 120,
      pageSize: 1024,
      pageSizeFormatted: "1.0 KB",
      hasViewport: true,
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
      serverInfo,
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
      issues: [referrerPolicyIssue],
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

describe("proposeFixes — real handler (quota, trusted input, hosting-aware output)", () => {
  test("returns deterministic proposals built from the stored scan, not the client", async () => {
    const t = freshBackend();
    const scanId = await seedScan(t);

    const res = await t.action(api.aiAssistant.proposeFixes, { scanId });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.result.provider).toBe("deterministic");
    expect(res.result.platformLabel).toMatch(/Nginx/);
    expect(res.result.proposals).toHaveLength(1);

    const proposal = res.result.proposals[0];
    expect(proposal.message).toBe("Missing Referrer-Policy header.");
    expect(proposal.targetPath).toBe("nginx.conf");
    expect(proposal.previewKind).toBe("proposed-snippet");
    expect(proposal.diff).toContain("+add_header Referrer-Policy");
    expect(res.result.notice).toContain("Suggestions only");
    expect(typeof res.remaining).toBe("number");

    // A client-supplied finding payload is REJECTED by argument validation:
    // the action accepts only (scanId, visitorId), so proposals can only ever
    // describe the document the server fetches by id.
    await expect(
      t.action(api.aiAssistant.proposeFixes, {
        scanId,
        issues: [{ message: "Injected by the client", category: "Security" }],
      } as never),
    ).rejects.toThrow();
  });

  test("quota is enforced server-side per visitor; the limit travels with the result", async () => {
    const t = freshBackend();
    const scanId = await seedScan(t);

    for (let i = 0; i < FIX_PROPOSAL_LIMIT_PER_HOUR; i++) {
      const ok = await t.action(api.aiAssistant.proposeFixes, { scanId, visitorId: "visitor-a" });
      expect(ok.kind).toBe("ok");
    }

    const denied = await t.action(api.aiAssistant.proposeFixes, { scanId, visitorId: "visitor-a" });
    if (denied.kind !== "quotaExceeded") {
      throw new Error(`expected quotaExceeded, got ${denied.kind}`);
    }
    expect(denied.limit).toBe(FIX_PROPOSAL_LIMIT_PER_HOUR);
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // The persisted counter proves the quota ran server-side, not in the UI.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "fix-proposal:visitor-a"))
        .first(),
    );
    expect(row?.count).toBe(FIX_PROPOSAL_LIMIT_PER_HOUR);

    // A different visitor is unaffected.
    const other = await t.action(api.aiAssistant.proposeFixes, { scanId, visitorId: "visitor-b" });
    expect(other.kind).toBe("ok");
  });

  test("unknown/deleted scan id → notFound, and the quota was consumed first", async () => {
    const t = freshBackend();
    const scanId = await seedScan(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(scanId);
    });

    const res = await t.action(api.aiAssistant.proposeFixes, { scanId, visitorId: "visitor-c" });
    expect(res.kind).toBe("notFound");

    // Runtime ordering pin: the quota row exists even though the scan did not.
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("rateLimits")
        .withIndex("by_key", (q) => q.eq("key", "fix-proposal:visitor-c"))
        .first(),
    );
    expect(row?.count).toBe(1);
  });

  test("hosting platform comes from the stored response evidence", async () => {
    const t = freshBackend();
    const scanId = await seedScan(t, { server: "cloudflare", technology: [] });

    const res = await t.action(api.aiAssistant.proposeFixes, { scanId });
    if (res.kind !== "ok") throw new Error(`expected ok, got ${res.kind}`);
    expect(res.result.platform).toBe("cloudflare");
    expect(res.result.proposals[0].targetPath).toBe("hosting-control-panel");
  });
});
