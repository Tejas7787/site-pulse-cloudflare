// Phase 11A — forged saved scan reports (P0 security regression suite).
//
// Root cause this locks down: `scans.saveScan` is a public mutation, and
// before this phase it stored ANY score/grade/issues the caller sent. It now
// requires an HMAC receipt minted by the server-side `scan.scanWebsite`
// action over the canonical payload + expiry (src/lib/scanReceipt.ts).
//
// Coverage map (the 8 required cases):
//   1. legitimate server-generated receipt accepted  → "acceptance" + e2e
//   2. missing receipt rejected                      → "rejection" suite
//   3. invalid receipt rejected                      → "rejection" suite
//   4. expired receipt rejected                      → "rejection" suite
//   5. tampered payload rejected                     → "rejection" suite
//   6. receipt reuse with a modified report rejected → "rejection" suite
//   7. rejections insert nothing and consume no quota → "rejection" suite
//   8. existing scan → save → report flow still works → e2e (real action)
//
// Also cross-checks our Web Crypto HMAC against Node's crypto.createHmac
// (reference implementation) and pins the wiring that a runtime test cannot
// observe (verification ordered before quota/insert; key internal-only).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac, randomBytes } from "node:crypto";
import { ConvexError } from "convex/values";
import type { FunctionArgs } from "convex/server";
import { convexTest } from "convex-test";
import { api } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";
import {
  SCAN_RECEIPT_TTL_MS,
  canonicalScanPayload,
  mintScanReceipt,
  verifyScanReceipt,
} from "../src/lib/scanReceipt";
import { nullsToUndefined } from "../src/lib/nulls";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

// convex-test module map (keys: paths relative to src/convex, extension kept).
const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "scans.ts": () => import("../src/convex/scans.ts"),
  "rateLimit.ts": () => import("../src/convex/rateLimit.ts"),
  "scan.ts": () => import("../src/convex/scan.ts"),
};

const freshBackend = () => convexTest(schema, modules);

// A fixed test key: tests that exercise verification seed this exact key into
// the backend's internal table, mirroring the key the action creates on a
// real deployment's first scan.
const TEST_KEY = randomBytes(32).toString("hex");

type Backend = ReturnType<typeof freshBackend>;

async function seedKey(t: Backend): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("scanReceiptKeys", { key: TEST_KEY, createdAt: Date.now() }),
  );
}

/** Strip transport-only fields — exactly what the handler signs over. */
function reportPayload(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.receipt;
  delete rest.visitorId;
  return rest;
}

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
  scannedAt: 1_700_000_000_000,
  visitorId: "receipt-visitor",
};

const signed = (args: Record<string, unknown>) =>
  mintScanReceipt(reportPayload(args), TEST_KEY).then((receipt) => ({ ...args, receipt }));

async function expectRejected(
  fn: () => Promise<unknown>,
): Promise<ConvexError<{ code?: string; reason?: string }>> {
  let thrown: unknown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ConvexError);
  return thrown as ConvexError<{ code?: string; reason?: string }>;
}

async function rows<T = Record<string, unknown>>(
  t: Backend,
  table: "scans" | "rateLimits" | "scanReceiptKeys",
): Promise<T[]> {
  return (await t.run((ctx) => ctx.db.query(table).collect())) as T[];
}

/* ── 1. Library: canonical form + HMAC against Node's reference ──────────── */

describe("scanReceipt library", () => {
  test("HMAC matches Node's crypto.createHmac over the same signed bytes", async () => {
    const payload = { score: 60, grade: "D", nested: { b: 1, a: [1, 2, { z: null }] } };
    const now = 1_700_000_000_000;
    const receipt = await mintScanReceipt(payload, TEST_KEY, now);
    expect(receipt.exp).toBe(now + SCAN_RECEIPT_TTL_MS);
    const reference = createHmac("sha256", Buffer.from(TEST_KEY, "hex"))
      .update(`${receipt.exp}.${canonicalScanPayload(payload)}`)
      .digest("hex");
    expect(receipt.sig).toBe(reference);
    expect(receipt.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("canonical form: key order is irrelevant, null/undefined ≡ absent, arrays keep order", () => {
    expect(canonicalScanPayload({ a: 1, b: 2 })).toBe(canonicalScanPayload({ b: 2, a: 1 }));
    expect(canonicalScanPayload({ a: 1, b: null })).toBe(canonicalScanPayload({ a: 1 }));
    expect(canonicalScanPayload({ a: undefined })).toBe(canonicalScanPayload({}));
    expect(canonicalScanPayload({ x: { n: null, m: 1 } })).toBe(canonicalScanPayload({ x: { m: 1 } }));
    // Arrays are order-sensitive; JSON nulls stay.
    expect(canonicalScanPayload([1, null, 2])).not.toBe(canonicalScanPayload([1, 2, null]));
    // Real differences still change the bytes.
    expect(canonicalScanPayload({ score: 60 })).not.toBe(canonicalScanPayload({ score: 61 }));
    expect(canonicalScanPayload({ url: "https://a.test/" })).not.toBe(canonicalScanPayload({ url: "https://b.test/" }));
  });

  test("verify accepts an intact receipt and rejects every tamper class", async () => {
    const payload = { score: 60, issues: [finding] };
    const receipt = await mintScanReceipt(payload, TEST_KEY);

    expect(await verifyScanReceipt(payload, receipt, TEST_KEY)).toEqual({ ok: true });
    // Same payload, null-vs-absent spelling (client nullsToUndefined round trip).
    expect(await verifyScanReceipt({ ...payload, extra: null }, receipt, TEST_KEY)).toEqual({ ok: true });

    // Missing / malformed.
    expect(await verifyScanReceipt(payload, undefined, TEST_KEY)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyScanReceipt(payload, { exp: receipt.exp, sig: "not-a-signature" }, TEST_KEY)).toEqual({
      ok: false,
      reason: "malformed",
    });

    // Tampered payload / tampered expiry / wrong key.
    expect(await verifyScanReceipt({ ...payload, score: 100 }, receipt, TEST_KEY)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyScanReceipt(payload, { ...receipt, exp: receipt.exp + 60_000 }, TEST_KEY)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await verifyScanReceipt(payload, receipt, randomBytes(32).toString("hex"))).toEqual({
      ok: false,
      reason: "mismatch",
    });

    // Correctly signed, but past expiry.
    const stale = await mintScanReceipt(payload, TEST_KEY, Date.now() - SCAN_RECEIPT_TTL_MS - 1_000);
    expect(await verifyScanReceipt(payload, stale, TEST_KEY)).toEqual({ ok: false, reason: "expired" });
  });
});

/* ── 2. Real handler: acceptance, rejection, no side effects ─────────────── */

describe("saveScan — provenance verification (public write endpoint)", () => {
  test("1. a legitimate receipt is accepted and neither receipt nor visitorId is stored", async () => {
    const t = freshBackend();
    await seedKey(t);
    const id = await t.mutation(api.scans.saveScan, await signed(saveArgs));
    expect(typeof id).toBe("string");
    const doc = (await t.query(api.scans.getScan, { id })) as Record<string, unknown> | null;
    expect(doc?.url).toBe("https://example.com/");
    expect(doc?.score).toBe(60);
    expect(doc?.receipt).toBeUndefined();
    expect(doc?.visitorId).toBeUndefined();
  });

  test("2. missing receipt is rejected before any quota or row", async () => {
    const t = freshBackend();
    await seedKey(t);
    const err = await expectRejected(() => t.mutation(api.scans.saveScan, saveArgs));
    expect(err.data).toMatchObject({ code: "invalid_receipt", reason: "missing" });
    expect(await rows(t, "scans")).toHaveLength(0);
    expect(await rows(t, "rateLimits")).toHaveLength(0);
  });

  test("3. invalid receipts (garbage signature, wrong signature) are rejected", async () => {
    const t = freshBackend();
    await seedKey(t);

    const malformed = await expectRejected(() =>
      t.mutation(api.scans.saveScan, { ...saveArgs, receipt: { exp: Date.now() + 60_000, sig: "zz" } }),
    );
    expect(malformed.data).toMatchObject({ code: "invalid_receipt", reason: "malformed" });

    const wrongSig = await expectRejected(() =>
      t.mutation(api.scans.saveScan, {
        ...saveArgs,
        receipt: { exp: Date.now() + 60_000, sig: "ab".repeat(32) },
      }),
    );
    expect(wrongSig.data).toMatchObject({ code: "invalid_receipt", reason: "mismatch" });

    expect(await rows(t, "scans")).toHaveLength(0);
    expect(await rows(t, "rateLimits")).toHaveLength(0);
  });

  test("4. an expired receipt is rejected", async () => {
    const t = freshBackend();
    await seedKey(t);
    const receipt = await mintScanReceipt(reportPayload(saveArgs), TEST_KEY, Date.now() - SCAN_RECEIPT_TTL_MS - 5_000);
    const err = await expectRejected(() => t.mutation(api.scans.saveScan, { ...saveArgs, receipt }));
    expect(err.data).toMatchObject({ code: "invalid_receipt", reason: "expired" });
    expect(await rows(t, "scans")).toHaveLength(0);
  });

  test("5. a tampered payload no longer matches its receipt", async () => {
    const t = freshBackend();
    await seedKey(t);
    const receipt = await mintScanReceipt(reportPayload(saveArgs), TEST_KEY);

    for (const tampered of [
      { ...saveArgs, score: 100, grade: "A" },
      { ...saveArgs, securityScore: 99 },
      { ...saveArgs, issues: [{ ...finding, message: "Fabricated critical finding." }] },
      { ...saveArgs, url: "https://victim.example/" },
      { ...saveArgs, totalFailed: 0, totalPassed: 10 },
    ]) {
      const err = await expectRejected(() =>
        t.mutation(api.scans.saveScan, { ...tampered, receipt }),
      );
      expect(err.data).toMatchObject({ code: "invalid_receipt" });
    }
    expect(await rows(t, "scans")).toHaveLength(0);
    expect(await rows(t, "rateLimits")).toHaveLength(0);
  });

  test("6. the receipt cannot be reused to save a modified report", async () => {
    const t = freshBackend();
    await seedKey(t);
    const receipt = await mintScanReceipt(reportPayload(saveArgs), TEST_KEY);

    // First use: the exact signed payload saves fine.
    const id = await t.mutation(api.scans.saveScan, { ...saveArgs, receipt });
    expect(typeof id).toBe("string");

    // Reuse for a MODIFIED report: same receipt, one field changed → rejected.
    const err = await expectRejected(() =>
      t.mutation(api.scans.saveScan, { ...saveArgs, score: 97, grade: "A", receipt }),
    );
    expect(err.data).toMatchObject({ code: "invalid_receipt", reason: "mismatch" });
    expect(await rows(t, "scans")).toHaveLength(1); // only the legitimate save exists
  });

  test("7. rejected requests consume no quota — the honest budget stays intact", async () => {
    const t = freshBackend();
    await seedKey(t);
    for (let i = 0; i < 3; i++) {
      await expectRejected(() => t.mutation(api.scans.saveScan, saveArgs)); // missing receipt
    }
    await expectRejected(() =>
      t.mutation(api.scans.saveScan, { ...saveArgs, receipt: { exp: Date.now() + 1, sig: "cd".repeat(32) } }),
    );
    expect(await rows(t, "rateLimits")).toHaveLength(0);
    expect(await rows(t, "scans")).toHaveLength(0);

    // The very next legitimate save still works and is the FIRST quota use.
    const id = await t.mutation(api.scans.saveScan, await signed(saveArgs));
    expect(typeof id).toBe("string");
    const limits = await rows<{ key: string; count: number }>(t, "rateLimits");
    expect(limits).toHaveLength(1);
    expect(limits[0].key).toBe("save-scan:receipt-visitor");
    expect(limits[0].count).toBe(1);
  });
});

/* ── 3. End-to-end: real scanWebsite action → receipt → save → report ────── */

describe("legitimate flow: scanWebsite mints, saveScan verifies, getScan serves", () => {
  test("8. a real scan's receipt saves its real report (public /report link intact)", async () => {
    const t = freshBackend();
    const realFetch = globalThis.fetch;
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>Receipt Test Site</title></head><body><h1>Hello</h1>" +
      '<img src="/a.png" alt="a"><a href="/next">next</a></body></html>';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("robots.txt") || url.includes("sitemap.xml")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", server: "receipt-test" },
      });
    }) as typeof fetch;

    try {
      // Public IP literal: the SSRF guard passes without touching real DNS,
      // and http:// means the TLS probe is skipped. fetch is stubbed above.
      const res = await t.action(api.scan.scanWebsite, {
        url: "http://93.184.216.34/",
        visitorId: "e2e-visitor",
      });
      const receipt = (res as { receipt?: { exp: number; sig: string } }).receipt;
      expect(receipt?.sig).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt?.exp).toBeGreaterThan(Date.now());

      // The signing key was created server-side on this first scan.
      expect(await rows(t, "scanReceiptKeys")).toHaveLength(1);

      // Exactly what Landing.tsx does: normalize nulls, pass the receipt along.
      const forSave = nullsToUndefined(res) as unknown as FunctionArgs<typeof api.scans.saveScan>;
      const id = await t.mutation(api.scans.saveScan, { ...forSave, visitorId: "e2e-visitor" });
      expect(typeof id).toBe("string");

      const doc = (await t.query(api.scans.getScan, { id })) as Record<string, unknown> | null;
      expect(doc?.url).toBe("http://93.184.216.34/");
      expect(doc?.score).toBeTypeOf("number");
      expect(doc?.receipt).toBeUndefined();

      // Tampering after the fact: the SAME receipt cannot save a changed copy.
      await expectRejected(() =>
        t.mutation(api.scans.saveScan, { ...forSave, score: 100, visitorId: "e2e-visitor" }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/* ── 4. Source pins: wiring a runtime test cannot observe ─────────────────── */

describe("wiring — source pins for the Phase 11A provenance fix", () => {
  test("saveScan verifies the receipt BEFORE quota and BEFORE the insert", () => {
    const src = read("src/convex/scans.ts");
    const start = src.indexOf("export const saveScan");
    const end = src.indexOf("export const getOrCreateReceiptKey");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block.indexOf("verifyScanReceipt")).toBeLessThan(block.indexOf("consumeQuota"));
    expect(block.indexOf("consumeQuota")).toBeLessThan(block.indexOf("ctx.db.insert"));
    expect(block).toContain('"invalid_receipt"');
    // The signing key is only reachable through the internal mutation.
    expect(src).toContain("getOrCreateReceiptKey = internalMutation");
  });

  test("scanWebsite mints the receipt over the payload it returns", () => {
    const scan = read("src/convex/scan.ts");
    expect(scan).toContain("mintScanReceipt(payload, receiptKey)");
    expect(scan).toContain("getOrCreateReceiptKey");
    expect(scan).toContain("return { ...payload, receipt };");
    // The action, not the client, creates the key material.
    expect(scan).toContain("randomBytes(32)");
  });

  test("Landing forwards the receipt through the existing saveScan call", () => {
    const landing = read("src/pages/Landing.tsx");
    expect(landing).toMatch(/saveScan\(\{ \.\.\.forSave, visitorId: getVisitorId\(\) \}\)/);
    expect(landing).toContain('code === "invalid_receipt"');
    // Shared conversion used by both the client and these tests.
    expect(landing).toContain('import { nullsToUndefined } from "../lib/nulls"');
  });
});
