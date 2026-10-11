import { describe, expect, test } from "bun:test";
import {
  CATEGORY_SCORE_FORMULA,
  OVERALL_SCORE_FORMULA,
  categoryFactors,
  overallScore,
  scoreCategory,
  scoreFromCounts,
  tallyChecks,
} from "../src/lib/scoring";
import type { CheckResult } from "../src/types/scan";

describe("tallyChecks (five check states)", () => {
  test("counts every state separately", () => {
    const checks: Record<string, CheckResult> = {
      a: "pass",
      b: "pass",
      c: "fail",
      d: "warn",
      e: "not-checked", // Unable to Verify
      f: "na", // Not Applicable
    };
    const counts = tallyChecks(checks);
    expect(counts.passed).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.warnings).toBe(1);
    expect(counts.unverified).toBe(1);
    expect(counts.notApplicable).toBe(1);
    expect(counts.applicable).toBe(4); // pass+fail+warn only
    expect(counts.total).toBe(6);
  });

  test("unknown values fall back to unverified instead of failing", () => {
    const counts = tallyChecks({ x: "not-checked" as CheckResult });
    expect(counts.unverified).toBe(1);
    expect(counts.failed).toBe(0);
  });
});

describe("scoreFromCounts — documented formula", () => {
  test("score = round(100 × (passed + 0.5 × warnings) ÷ applicable)", () => {
    const counts = tallyChecks({ a: "pass", b: "pass", c: "fail" });
    expect(scoreFromCounts(counts)).toBe(Math.round((100 * 2) / 3));
  });

  test("unverified and NA are excluded from the denominator", () => {
    const withUnknowns = tallyChecks({
      a: "pass",
      b: "fail",
      u1: "not-checked",
      u2: "not-checked",
      n1: "na",
    });
    // Only 2 applicable checks: 1 pass → 50, NOT diluted by unknowns
    expect(scoreFromCounts(withUnknowns)).toBe(50);
  });

  test("no applicable checks → null (never 0)", () => {
    expect(scoreFromCounts(tallyChecks({ a: "not-checked", b: "na" }))).toBeNull();
  });
});

describe("scoreCategory — honest category scores", () => {
  test("REGRESSION: a category with a few failures among many passes is not 0", () => {
    // The old engine deducted 10 points per missing-alt image, so 10 images
    // with 1 failing check produced Accessibility 0/100.
    const checks: Record<string, CheckResult> = {
      "image-alt": "fail",
      "html-lang": "pass",
      "form-labels": "pass",
    };
    const cat = scoreCategory(checks);
    expect(cat.failed).toBe(1);
    expect(cat.hasScore).toBe(true);
    expect(cat.score).toBe(67); // 1 of 3 applicable checks fails → not 0
  });

  test("all-unverified category reports hasScore=false instead of 0/100", () => {
    const cat = scoreCategory({ x: "not-checked", y: "na" });
    expect(cat.hasScore).toBe(false);
    expect(cat.unverified).toBe(1);
    expect(cat.notApplicable).toBe(1);
    expect(cat.applicable).toBe(0);
  });

  test("carries the formula and factors", () => {
    const cat = scoreCategory({ good: "pass", bad: "fail", warn: "warn", u: "not-checked" });
    expect(cat.formula).toBe(CATEGORY_SCORE_FORMULA);
    expect(cat.factors?.join(" | ")).toContain("Failing: bad");
    expect(cat.factors?.join(" | ")).toContain("Unable to verify: u");
  });
});

describe("categoryFactors", () => {
  test("lists failing checks first, then warnings, then unknowns", () => {
    const factors = categoryFactors({
      z: "not-checked",
      a: "pass",
      m: "warn",
      f: "fail",
    });
    expect(factors[0]).toBe("Failing: f");
    expect(factors[1]).toBe("Warning: m");
    expect(factors[2]).toBe("Unable to verify: z");
  });
});

describe("overallScore — weighted and renormalized", () => {
  test("uses the documented category weights", () => {
    const result = overallScore({
      Security: 100,
      Performance: 100,
      SEO: 100,
      "Technical Health": 100,
      Accessibility: 100,
    });
    expect(result.score).toBe(100);
    expect(result.usedWeight).toBeCloseTo(1, 5);
    expect(result.formula).toBe(OVERALL_SCORE_FORMULA);
  });

  test("a category without a score is excluded and weights renormalize", () => {
    // Accessibility null (no verified checks) must not drag the score down.
    const a = overallScore({
      Security: 80,
      Performance: 80,
      SEO: 80,
      "Technical Health": 80,
      Accessibility: null,
    });
    expect(a.score).toBe(80);
    expect(a.usedWeight).toBeCloseTo(0.9, 5);
  });

  test("all categories unknown → null, never 0", () => {
    const result = overallScore({
      Security: null,
      Performance: null,
      SEO: null,
      "Technical Health": null,
      Accessibility: null,
    });
    expect(result.score).toBeNull();
    expect(result.usedWeight).toBe(0);
  });

  test("weighted mix matches the published weights", () => {
    // Security 100×.30 + Performance 0×.25 + SEO 80×.25 + Tech 100×.10 + A11y 60×.10
    const expected = Math.round(100 * 0.3 + 0 * 0.25 + 80 * 0.25 + 100 * 0.1 + 60 * 0.1);
    const result = overallScore({
      Security: 100,
      Performance: 0,
      SEO: 80,
      "Technical Health": 100,
      Accessibility: 60,
    });
    expect(result.score).toBe(expected);
  });
});

describe("coverage floor — insufficiently verified categories never score", () => {
  // Reported bug: a Cloudflare 403 challenge forced 27 checks to "Unable to
  // Verify"; with those checks gone from the denominator, the only remaining
  // passes (HTTPS + SSL certificate) computed to a perfect Security 100 —
  // even though the site's real score had been 44.
  const blockedSecurity: Record<string, CheckResult> = {
    https: "pass",
    "http-to-https-redirect": "na",
    "header-csp": "not-checked",
    "header-hsts": "not-checked",
    "header-xcto": "not-checked",
    "header-xfo": "not-checked",
    "header-rp": "not-checked",
    "header-pp": "not-checked",
    "header-xpcdp": "not-checked",
    "ssl-valid": "pass",
    "cookie-flags": "not-checked",
    "mixed-content": "not-checked",
  };

  test("the exact blocked-403 Security map scores nothing, never 100", () => {
    const counts = tallyChecks(blockedSecurity);
    expect(counts.passed).toBe(2);
    expect(counts.applicable).toBe(2);
    expect(counts.unverified).toBe(9);
    expect(counts.notApplicable).toBe(1);
    // The raw formula would compute 100 from the 2 remaining passes — the
    // floor refuses it because most of the category could not be verified.
    expect(scoreFromCounts(counts)).toBeNull();
    const cat = scoreCategory(blockedSecurity);
    expect(cat.hasScore).toBe(false);
    expect(cat.score).toBe(0);
    // Counts are still recorded so the report shows what was verified.
    expect(cat.passed).toBe(2);
    expect(cat.unverified).toBe(9);
  });

  test("the floor trips only when unverified exceeds verified", () => {
    // 2 verified / 2 unverified — a tie still scores, so normal partial
    // scans (truncated bodies, one unreachable sub-check) are unchanged.
    expect(scoreFromCounts(tallyChecks({ a: "pass", b: "fail", u1: "not-checked", u2: "not-checked" }))).toBe(50);
    // 1 verified / 2 unverified — the floor trips.
    expect(scoreFromCounts(tallyChecks({ a: "pass", u1: "not-checked", u2: "not-checked" }))).toBeNull();
    // Not Applicable is genuinely irrelevant to the target — it never counts
    // against coverage.
    expect(scoreFromCounts(tallyChecks({ a: "pass", n1: "na", n2: "na" }))).toBe(100);
  });

  test("complete scans are untouched by the floor", () => {
    expect(scoreFromCounts(tallyChecks({ a: "pass", b: "fail", c: "warn" }))).toBe(
      Math.round((100 * (1 + 0.5)) / 3),
    );
  });
});

describe("scoreCategory — blocked scans carry no score", () => {
  test("even an all-pass map is unscored when the scan was blocked", () => {
    const cat = scoreCategory({ https: "pass", "ssl-valid": "pass" }, { blocked: true });
    expect(cat.hasScore).toBe(false);
    expect(cat.score).toBe(0);
    expect(cat.passed).toBe(2); // counts preserved for the report
    expect(cat.factors).toBeDefined();
  });

  test("the same map scores normally when the scan was not blocked", () => {
    const cat = scoreCategory({ https: "pass", "ssl-valid": "pass" });
    expect(cat.hasScore).toBe(true);
    expect(cat.score).toBe(100);
  });
});
