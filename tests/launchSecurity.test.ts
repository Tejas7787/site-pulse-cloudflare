// Pre-launch security hardening (READ-ONLY review follow-up, targeted fixes):
//   1. askAssistant enforces the server-side AI quota BEFORE any paid model
//      call, and answers with a clear quotaExceeded notice on denial.
//   2. the public saveScan mutation consumes a server-side storage quota
//      before writing a row (anonymous scans and public report links intact).
//   3. the client-supplied visitorId limitation is documented where the quota
//      keys are defined — anti-abuse only, explicitly NOT authorization.
//   4. the Copy Code button announces success through aria-live="polite".
//
// Functional parts run the REAL handlers against convex-test's in-memory
// backend (no network, no keys, no deployment). Source pins cover ordering
// and documentation that a runtime test cannot observe without a model call.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { api } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";
import { DIAGNOSIS_LIMIT_PER_HOUR } from "../src/lib/aiDoctor";
import { SAVE_SCAN_LIMIT } from "../src/convex/rateLimit";
import { mintScanReceipt } from "../src/lib/scanReceipt";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

// convex-test loads Convex modules on demand from this map (keys are paths
// relative to src/convex with the extension kept; values are lazy importers).
const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "aiAssistant.ts": () => import("../src/convex/aiAssistant.ts"),
  "scans.ts": () => import("../src/convex/scans.ts"),
  "rateLimit.ts": () => import("../src/convex/rateLimit.ts"),
};

const freshBackend = () => convexTest(schema, modules);

const CHECKS = { score: 50, passed: 1, failed: 1, warnings: 0, notChecked: 0 };

const finding = {
  category: "Security",
  severity: "warning",
  priority: "important",
  message: "Missing Referrer-Policy header.",
  whyItMatters: "Without Referrer-Policy, browsers send full URLs as referrer information.",
  howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
  evidence: "Referrer-Policy was not present in the response headers of https://example.com/.",
  stage: "headers",
  method: "http",
  checkKey: "rp",
  status: "warning",
  confirmed: false,
};

/** A complete, valid saveScan argument set (the scanner's real output shape). */
const saveArgs = {
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
  issues: [finding],
  topIssues: [],
  quickWins: [],
  totalChecksCompleted: 10,
  totalPassed: 6,
  totalFailed: 2,
  totalWarnings: 2,
  scannedAt: Date.now(),
  visitorId: "save-visitor",
};

// Phase 11A — saveScan now requires a provenance receipt over the exact
// payload it accepts (src/lib/scanReceipt.ts). Tests seed the internal
// signing key and mint receipts with the SAME shared library the server
// uses, so the real verification path is exercised, never bypassed.
const TEST_KEY = "a1".repeat(32); // 64 hex chars = 32 bytes
type Args = Record<string, unknown>;
function reportPayload(args: Args): Args {
  const rest = { ...args };
  delete rest.receipt;
  delete rest.visitorId;
  return rest;
}
const seedKey = (t: ReturnType<typeof freshBackend>) =>
  t.run((ctx) => ctx.db.insert("scanReceiptKeys", { key: TEST_KEY, createdAt: Date.now() }));
const withReceipt = async (args: Args) => ({
  ...args,
  receipt: await mintScanReceipt(reportPayload(args), TEST_KEY),
});
const signedSaveArgs = {
  ...saveArgs,
  receipt: await mintScanReceipt(reportPayload(saveArgs), TEST_KEY),
};

/* ── 2. saveScan storage quota — real handler ──────────────────────────── */

describe("saveScan — server-side storage quota (public write endpoint)", () => {
  test("allows the honest flow up to the limit, then refuses with rate_limited", async () => {
    const t = freshBackend();
    await seedKey(t);
    for (let i = 0; i < SAVE_SCAN_LIMIT; i++) {
      const id = await t.mutation(api.scans.saveScan, signedSaveArgs);
      expect(typeof id).toBe("string");
    }
    let thrown: unknown = null;
    try {
      await t.mutation(api.scans.saveScan, signedSaveArgs);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    const data = (thrown as ConvexError<{ code?: string }>).data;
    expect(data).toMatchObject({ code: "rate_limited", scope: "save-scan", limit: SAVE_SCAN_LIMIT });
    expect(typeof data.retryAfterMs).toBe("number");
  });

  test("the quota is per identity: another visitor can still save", async () => {
    const t = freshBackend();
    await seedKey(t);
    for (let i = 0; i < SAVE_SCAN_LIMIT; i++) {
      await t.mutation(api.scans.saveScan, signedSaveArgs);
    }
    const id = await t.mutation(api.scans.saveScan, {
      ...saveArgs,
      visitorId: "other-visitor",
      receipt: await mintScanReceipt(reportPayload({ ...saveArgs, visitorId: "other-visitor" }), TEST_KEY),
    });
    expect(typeof id).toBe("string");
    // Public report links are preserved: the saved scan is readable by id,
    // with no auth anywhere in the read path.
    const scan = await t.query(api.scans.getScan, { id });
    expect(scan?.url).toBe("https://example.com/");
  });

  test("non-http(s) URLs are refused before any row is written", async () => {
    const t = freshBackend();
    await seedKey(t);
    let thrown: unknown = null;
    try {
      // A valid receipt over the bad URL payload: provenance passes, then the
      // URL rule refuses it — the URL guard is still exercised on its own.
      await t.mutation(api.scans.saveScan, await withReceipt({ ...saveArgs, url: "javascript:alert(1)" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect((thrown as ConvexError<{ code?: string }>).data).toMatchObject({ code: "invalid_url" });
    const remaining = await t.run(async (ctx) => (await ctx.db.query("scans").collect()).length);
    expect(remaining).toBe(0);
  });
});

/* ── 1. askAssistant quota — real handler, refusal path (no model call) ─── */

describe("askAssistant — quota enforced server-side before any model call", () => {
  test("an exhausted AI quota returns a clear quotaExceeded answer without doing work", async () => {
    const t = freshBackend();
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", {
        key: "ai:ask-visitor",
        windowStart: Date.now(),
        count: DIAGNOSIS_LIMIT_PER_HOUR,
      }),
    );
    const res = await t.action(api.aiAssistant.askAssistant, {
      question: "What should I fix first?",
      scanData: JSON.stringify({ score: 60, url: "https://example.com/" }),
      visitorId: "ask-visitor",
    });
    expect(res.quotaExceeded).toBe(true);
    expect(res.limit).toBe(DIAGNOSIS_LIMIT_PER_HOUR);
    expect(typeof res.retryAfterMs).toBe("number");
    expect(res.answer).toContain("Question limit reached");
    expect(res.answer).toContain(String(DIAGNOSIS_LIMIT_PER_HOUR));
    // The counter was NOT double-consumed by work after the refusal.
    const rows = await t.run(async (ctx) => ctx.db.query("rateLimits").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(DIAGNOSIS_LIMIT_PER_HOUR);
  });

  test("the client sends the per-visitor identity with each question", () => {
    const ui = read("src/components/AIAssistant.tsx");
    expect(ui).toMatch(/askAssistant\(\{[\s\S]{0,160}visitorId: getVisitorId\(\)/);
  });
});

/* ── Source pins: ordering and documentation a runtime test can't see ──── */

describe("wiring — source pins for the launch hardening", () => {
  test("askAssistant consumes consumeAiQuota BEFORE vly.ai.completion", () => {
    const src = read("src/convex/aiAssistant.ts");
    const start = src.indexOf("export const askAssistant");
    const end = src.indexOf("export const explainFindings");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("internal.rateLimit.consumeAiQuota");
    expect(block).toContain("quotaExceeded");
    const quotaAt = block.indexOf("consumeAiQuota");
    expect(quotaAt).toBeLessThan(block.indexOf("vly.ai.completion"));
    // Also ahead of the deterministic fallback — quota is step one.
    expect(quotaAt).toBeLessThan(block.indexOf("deterministicAnswer"));
  });

  test("saveScan consumes its storage quota before inserting, and rejects bad URLs", () => {
    const src = read("src/convex/scans.ts");
    const start = src.indexOf("export const saveScan");
    const end = src.indexOf("export const getScan");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("save-scan:");
    expect(block).toContain("consumeQuota");
    expect(block.indexOf("consumeQuota")).toBeLessThan(block.indexOf("ctx.db.insert"));
    expect(block).toContain("rate_limited");
    expect(block).toMatch(/https\?:/);
    // getScan stays unauthenticated — public report links are preserved.
    const getScan = src.slice(end, end + 200);
    expect(getScan).toContain("ctx.db.get(args.id)");
  });

  test("Landing passes the visitor identity when persisting a scan", () => {
    const landing = read("src/pages/Landing.tsx");
    expect(landing).toMatch(/saveScan\(\{ \.\.\.forSave, visitorId: getVisitorId\(\) \}\)/);
    expect(landing).toContain('code === "rate_limited"');
  });

  test("the client-supplied identity limitation is documented, not oversold", () => {
    const rl = read("src/convex/rateLimit.ts");
    expect(rl).toContain("CLIENT-supplied");
    expect(rl).toContain("NOT authorization");
    expect(rl).toContain("SAVE_SCAN_LIMIT");
  });

  test("Copy Code announces success through a polite live region", () => {
    const rec = read("src/components/FixRecommendations.tsx");
    expect(rec).toContain('aria-live="polite"');
    expect(rec).toContain("Code snippet copied to clipboard.");
    expect(rec).toContain('aria-label={copied ? "Copied to clipboard" : "Copy code snippet"}');
  });
});
