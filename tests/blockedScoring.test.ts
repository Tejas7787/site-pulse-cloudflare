// ── Cloudflare 403 regression: a blocked scan must never show Security 100 ──
// Reported by a tester: after a Cloudflare 403 challenge the Security score
// jumped 44 → 100 while 27 checks were Unable to Verify. Root cause: the block
// gate correctly excluded every unverifiable check, but the applicable-only
// formula then scored the few remaining passes (HTTPS + SSL certificate) as a
// perfect 100. These tests reproduce that exact scenario at four levels:
// the scanner-shaped check maps, the saved document as the old code wrote it,
// the shared resolver both renderers use, and the rendered PDF.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildScanPdf, type PdfScanInput } from "../src/lib/pdfReport";
import {
  OVERALL_WEIGHTS,
  overallScore,
  resolveScanScores,
  scoreCategory,
  scoreFromCounts,
  tallyChecks,
} from "../src/lib/scoring";
import type { CheckResult } from "../src/types/scan";
import { extractPdfText, normalize } from "./pdfExtract";
import { blocked429Scan, cloudflare403Scan } from "./pdfFixtures";

const GENERATED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);

function pdfNorm(scan: PdfScanInput): string {
  return normalize(extractPdfText(buildScanPdf(scan, { generatedAt: GENERATED_AT }).bytes));
}

// ── The scanner's exact gated check maps for a hard-blocked scan ─────────────
// (src/convex/scan.ts: content gate + header/cookie gate + robots/sitemap gate)

const GATED_PERFORMANCE: Record<string, CheckResult> = {
  "response-time": "pass",
  redirects: "pass",
  "http-status": "fail", // the 403 itself is an observed fact
  "page-size": "not-checked",
  "image-count": "not-checked",
  "external-resources": "not-checked",
};

const GATED_SEO: Record<string, CheckResult> = {
  title: "not-checked",
  "meta-description": "not-checked",
  "h1-tag": "not-checked",
  "heading-structure": "not-checked",
  "canonical-tag": "not-checked",
  "robots-meta": "not-checked",
  "robots-txt": "not-checked",
  "sitemap-xml": "not-checked",
};

const GATED_ACCESSIBILITY: Record<string, CheckResult> = {
  "image-alt": "not-checked",
  "html-lang": "not-checked",
  "form-labels": "not-checked",
};

const GATED_TECHNICAL: Record<string, CheckResult> = {
  "clean-urls": "pass",
  "redirect-count": "pass",
  "http-status": "fail",
  "html-structure": "not-checked",
  viewport: "not-checked",
  charset: "not-checked",
  canonical: "not-checked",
};

const GATED_SECURITY: Record<string, CheckResult> = {
  https: "pass", // transport facts that still hold behind a challenge
  "http-to-https-redirect": "na",
  "ssl-valid": "pass",
  "header-csp": "not-checked",
  "header-hsts": "not-checked",
  "header-xcto": "not-checked",
  "header-xfo": "not-checked",
  "header-rp": "not-checked",
  "header-pp": "not-checked",
  "header-xpcdp": "not-checked",
  "cookie-flags": "not-checked",
  "mixed-content": "not-checked",
};

describe("the reported Cloudflare 403 case — scanner level", () => {
  test("the block gate forces exactly 27 checks to Unable to Verify", () => {
    const maps = [GATED_PERFORMANCE, GATED_SEO, GATED_ACCESSIBILITY, GATED_TECHNICAL, GATED_SECURITY];
    const unverified = maps.reduce((acc, m) => acc + tallyChecks(m).unverified, 0);
    expect(unverified).toBe(27); // the tester's number, check for check
  });

  test("Security cannot derive 100 from the surviving passes", () => {
    const counts = tallyChecks(GATED_SECURITY);
    expect(counts.passed).toBe(2);
    expect(counts.unverified).toBe(9);
    // What the old code computed: round(100 × 2 ÷ 2) = 100.
    // What the shared layer must refuse: no score at all.
    expect(scoreFromCounts(counts)).toBeNull();
  });

  test("the scanner saves a blocked scan with NO category score and no overall", () => {
    const opts = { blocked: true };
    const perf = scoreCategory(GATED_PERFORMANCE, opts);
    const seo = scoreCategory(GATED_SEO, opts);
    const sec = scoreCategory(GATED_SECURITY, opts);
    const a11y = scoreCategory(GATED_ACCESSIBILITY, opts);
    const tech = scoreCategory(GATED_TECHNICAL, opts);
    for (const cat of [perf, seo, sec, a11y, tech]) {
      expect(cat.hasScore).toBe(false);
    }
    const overall = overallScore({
      Performance: perf.hasScore ? perf.score : null,
      SEO: seo.hasScore ? seo.score : null,
      Security: sec.hasScore ? sec.score : null,
      Accessibility: a11y.hasScore ? a11y.score : null,
      "Technical Health": tech.hasScore ? tech.score : null,
    });
    expect(overall.score).toBeNull();

    // …and the saved shape resolves back to the same verdict.
    const resolved = resolveScanScores({
      summary: { blocked: true },
      performanceChecks: perf,
      seoChecks: seo,
      securityChecks: sec,
      accessibilityChecks: a11y,
      technicalHealthChecks: tech,
    });
    expect(resolved.categories.Security?.score).toBeNull();
    expect(resolved.overall).toBeNull();
    expect(resolved.grade).toBeNull();
    expect(resolved.overallScored).toBe(false);
  });
});

describe("the saved document written by the pre-fix code", () => {
  const scan = cloudflare403Scan();
  const resolved = resolveScanScores(scan);

  test("it really does claim Security 100 (the document under test)", () => {
    // Guard against the fixture silently drifting into a passing case.
    expect(scan.securityChecks?.score).toBe(100);
    expect(scan.securityChecks?.hasScore).toBe(true);
    expect(scan.securityChecks?.unverified).toBe(9);
    expect(scan.summary?.blocked).toBe(true);
    expect(scan.summary?.counts.unverified).toBe(27);
  });

  test("the shared resolver refuses every category score it claims", () => {
    expect(resolved.categories.Security?.score).toBeNull();
    for (const cat of Object.values(resolved.categories)) expect(cat?.score).toBeNull();
    expect(resolved.overall).toBeNull();
    expect(resolved.grade).toBeNull();
    expect(resolved.overallScored).toBe(false);
  });

  test("the PDF shows dashes everywhere — never 100, a grade, or a risk claim", () => {
    const text = pdfNorm(scan);
    expect(text).toContain("SCAN BLOCKED");
    expect(text).toContain("OVERALL HEALTH SCORE —");
    expect(text).toContain("Not enough verified checks to produce a score — no data, no score.");
    expect(text).not.toContain("100/100");
    expect(text).not.toContain("82/100");
    expect(text).not.toContain("GRADE"); // no grade without a score
    expect(text).not.toContain("LOW RISK"); // risk is derived from a score that does not exist
    expect(text).not.toContain("BETTER THAN 74%");
  });

  test("even without the blocked flag the coverage floor still refuses Security 100", () => {
    // Defense in depth: a document missing summary.blocked (or a future path
    // that forgets to set it) must still never display the fabricated score.
    const { summary, ...rest } = scan;
    const unflagged = {
      ...rest,
      summary: { ...summary, blocked: false, completeness: "partial" as const },
    } as PdfScanInput;
    const r = resolveScanScores(unflagged);
    expect(r.categories.Security?.score).toBeNull(); // 9 unverified > 2 verified
    // Performance (3 verified, 3 unverified — a tie) still scores 67, and the
    // overall renormalizes over the categories that still have a score.
    expect(r.categories.Performance?.score).toBe(67);
    expect(r.overall).toBe(67);
    expect(r.overall).toBe(
      Math.round(
        (67 * OVERALL_WEIGHTS.Performance) / OVERALL_WEIGHTS.Performance,
      ),
    );
  });
});

describe("blocked fixtures stay unscored (429 rate limit)", () => {
  test("the realistic blocked 429 fixture resolves to nothing scored", () => {
    const resolved = resolveScanScores(blocked429Scan());
    expect(resolved.overall).toBeNull();
    expect(resolved.grade).toBeNull();
    for (const cat of Object.values(resolved.categories)) expect(cat?.score).toBeNull();
    expect(pdfNorm(blocked429Scan())).toContain("OVERALL HEALTH SCORE —");
  });
});

describe("both surfaces gate challenge data on the same evidence", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  test("the scanner passes the hard-block state into the shared scorer", () => {
    const scan = read("../src/convex/scan.ts");
    expect(scan).toContain("blocked: hardBlock");
  });

  test("the report page gates page metadata, page size and trust signals", () => {
    const page = read("../src/pages/Report.tsx");
    expect(page).toContain("contentUsable");
    expect(page).toContain("overallScored && <ScoreTrend");
    expect(page).toContain("overallScored && s.riskLevel");
  });

  test("the landing page never presents challenge content as the site", () => {
    const landing = read("../src/pages/Landing.tsx");
    expect(landing).toContain("contentUsable");
    expect(landing).toContain("Page metadata was not collected.");
    expect(landing).toContain("Security headers could not be verified.");
    expect(landing).toContain("overallScored && <ScoreTrend");
  });

  test("the PDF gates the risk and better-than claims on the derived score", () => {
    const pdf = read("../src/lib/pdfReport.ts");
    expect(pdf).toContain("overallScored && scan.riskLevel");
    expect(pdf).toContain("overallScored && scan.betterThanPercent");
  });
});
