// Accuracy & trustworthiness regression tests (tester feedback follow-up).
//
// 1. Quick-win score-gain claims must be derived from the scoring formula —
//    never fabricated from the priority label (scan.ts used to hardcode
//    important→10, recommended→6, other→3 and every surface rendered it as
//    "+N pts potential").
// 2. A category score backed by very few verified checks (the tester's
//    example.com case: Accessibility 100 from 1 pass + 2 N/A) must be
//    rendered with explicit low-coverage context.
// 3. Performance must be described as server-response based, not browser
//    page speed.
// 4. Best-practice SEO probes (robots.txt / sitemap.xml / title length) must
//    keep their best-practice framing — never defect language.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  estimateOverallGain,
  honestQuickWinGains,
  OVERALL_WEIGHTS,
  overallScore,
  scoreFromCounts,
} from "../src/lib/scoring";
import { buildScanPdf } from "../src/lib/pdfReport";
import { extractPdfText, normalize } from "./pdfExtract";
import { sparseCoverageScan } from "./pdfFixtures";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");
const scanSource = read("src/convex/scan.ts");
const landingSource = read("src/pages/Landing.tsx");
const reportSource = read("src/pages/Report.tsx");
const pdfSource = read("src/lib/pdfReport.ts");

describe("estimateOverallGain — honest quick-win impact", () => {
  // applicable = 5 passed + 2 failed + 2 warnings = 9; Security weight .30.
  const security = { score: 60, passed: 5, failed: 2, warnings: 2 };

  test("fixing a failed check: +100/applicable scaled by weight over scored weight", () => {
    // (100/9) × 0.30/1.00 = 3.33… → 3.3
    expect(estimateOverallGain(security, "Security", "fail", 1)).toBe(3.3);
  });

  test("fixing a warning is worth half of fixing a failure", () => {
    // (50/9) × 0.30/1.00 = 1.66… → 1.7
    expect(estimateOverallGain(security, "Security", "warning", 1)).toBe(1.7);
  });

  test("the estimate is bounded by the real formula, not by priority bands", () => {
    const gain = estimateOverallGain(security, "Security", "fail", 1);
    const theoreticalMax = (100 / 9) * (OVERALL_WEIGHTS.Security / 1);
    expect(gain).toBeLessThanOrEqual(theoreticalMax + 0.05);
    expect(gain).toBeGreaterThan(0);
  });

  test("an unscored category can claim no gain", () => {
    expect(
      estimateOverallGain({ score: null, passed: 1, failed: 0, warnings: 0 }, "Accessibility", "fail", 1),
    ).toBe(0);
  });

  test("unable-to-verify findings can claim no gain", () => {
    expect(estimateOverallGain(security, "Security", "unable-to-verify", 1)).toBe(0);
  });

  test("unknown categories and zero scored weight yield 0", () => {
    expect(estimateOverallGain(security, "Not A Category", "fail", 1)).toBe(0);
    expect(estimateOverallGain(security, "Security", "fail", 0)).toBe(0);
    expect(estimateOverallGain(null, "Security", "fail", 1)).toBe(0);
  });
});

describe("honestQuickWinGains — stored claims are re-derived, not trusted", () => {
  test("ignores the fabricated stored potentialGain and uses the document's own counts", () => {
    const scan = sparseCoverageScan();
    // The stored values are the legacy fabrication (priority → 3) …
    expect(scan.quickWins[0].potentialGain).toBe(3);
    // … but the derived gains use SEO: applicable 9, warning → 0.5 checks,
    // weight .25, scored weight 1.0 → (50/9) × 0.25 = 1.38… → 1.4
    expect(honestQuickWinGains(scan, scan.quickWins)).toEqual([1.4, 1.4]);
  });

  test("a blocked scan (no scored categories) yields all-zero gains", () => {
    const blocked = sparseCoverageScan();
    blocked.summary = { ...blocked.summary, blocked: true };
    expect(honestQuickWinGains(blocked, blocked.quickWins)).toEqual([0, 0]);
  });
});

describe("scanner wiring — gains come from the formula, not the priority label", () => {
  test("scan.ts no longer fabricates gains from priority bands", () => {
    expect(scanSource).not.toContain(
      '? 10 : issue.priority === "recommended" ? 6 : 3',
    );
    expect(scanSource).toContain("estimateOverallGain(");
    expect(scanSource).toContain("overallResult.usedWeight");
  });

  test("every renderer re-derives gains and no surface shows the old pts claim", () => {
    const surfaces = [
      ["Landing", landingSource],
      ["Report", reportSource],
      ["pdf", pdfSource],
    ] as const;
    for (const [name, src] of surfaces) {
      expect(`${name} uses honestQuickWinGains: ${src.includes("honestQuickWinGains(")}`).toBe(
        `${name} uses honestQuickWinGains: true`,
      );
      expect(`${name} dropped pts-potential: ${!/pts potential|PTS POTENTIAL/i.test(src)}`).toBe(
        `${name} dropped pts-potential: true`,
      );
    }
  });
});

describe("PDF — coverage and measurement-scope disclosures", () => {
  const pdf = buildScanPdf(sparseCoverageScan(), { generatedAt: Date.UTC(2026, 9, 9, 12, 0, 0) });
  const text = normalize(extractPdfText(pdf.bytes));

  test("the tester's case renders Accessibility 100 WITH low-coverage context", () => {
    expect(text).toContain("Low coverage");
    expect(text).toContain("1 verified check — the Accessibility score rests on that evidence alone");
  });

  test("the category table states the Performance measurement basis", () => {
    expect(text).toContain(
      "Performance is measured from server response timing (HTTP), not browser-rendered page speed.",
    );
  });

  test("quick wins show the derived overall estimate, never the stored fabrication", () => {
    expect(text).toContain("~+1.4 PTS OVERALL");
    expect(text).not.toContain("PTS POTENTIAL");
  });
});

describe("SEO probes keep their best-practice framing", () => {
  test("robots.txt absence is framed as best practice, not a defect", () => {
    expect(scanSource).toContain("While not strictly required, it's considered best practice.");
    expect(scanSource).toContain('"No robots.txt file found."');
  });

  test("sitemap.xml absence is framed for large/complex sites, not as a defect", () => {
    expect(scanSource).toContain("especially for large sites or pages not well-linked internally");
    expect(scanSource).toContain('"No sitemap.xml found."');
  });

  test("title-length wording stays hedged and a missing title keeps its real failure copy", () => {
    expect(scanSource).toContain("may be truncated or not fully utilized for SEO");
    expect(scanSource).toContain("The title tag is one of the most important SEO elements");
  });
});

// ── estimateOverallGain verified against the ACTUAL scoring pipeline ────────
// Every case below recomputes the category score with scoreFromCounts() and
// the overall score with overallScore() — the exact functions the scanner and
// both renderers run — applies one simulated fix (fail → pass / warn → pass),
// and compares the recomputed overall-score change with the estimate.
//
// All fixtures keep applicable = 10, where the published formula
//   score = round(100 × (passed + 0.5 × warnings) ÷ applicable)
// always lands on an exact integer (100 × (p + 0.5w) ÷ 10 = 10p + 5w), so
// category-level rounding contributes nothing. The only rounding left is the
// final Math.round inside overallScore() — at most 0.5 per side, so ≤ 1 on a
// difference — plus the estimate's own round-to-1-decimal (≤ 0.05).
// A fail → pass or warn → pass never changes `applicable`, so per-finding
// gains in the same category are additive; and because the maximum reachable
// category score is exactly 100, the linear estimate can never overshoot it.

type CatCounts = { passed: number; failed: number; warnings: number };
type CatMap = Record<string, CatCounts | null>;
type Fix = "fail" | "warning";

// Security 60 · Performance 70 · SEO 80 · Technical Health 85 · Accessibility 90
// Overall = 60×.30 + 70×.25 + 80×.25 + 85×.10 + 90×.10 = 73, usedWeight = 1.
const BASE: CatMap = {
  Security: { passed: 5, failed: 3, warnings: 2 },
  Performance: { passed: 6, failed: 2, warnings: 2 },
  SEO: { passed: 7, failed: 1, warnings: 2 },
  "Technical Health": { passed: 8, failed: 1, warnings: 1 },
  Accessibility: { passed: 9, failed: 1, warnings: 0 },
};

function catScore(c: CatCounts | null): number | null {
  if (!c) return null;
  const applicable = c.passed + c.failed + c.warnings;
  return scoreFromCounts({
    passed: c.passed,
    failed: c.failed,
    warnings: c.warnings,
    notApplicable: 0,
    unverified: 0,
    applicable,
    total: applicable,
  });
}

/** Recompute the overall exactly the way the app does (weights + renormalization). */
function overall(cats: CatMap) {
  return overallScore(
    Object.fromEntries(Object.entries(cats).map(([name, c]) => [name, catScore(c)] as const)),
  );
}

/** Apply one fix: a failed check starts passing, or a warning is resolved. */
function applyFix(c: CatCounts, fix: Fix): CatCounts {
  return fix === "fail"
    ? { passed: c.passed + 1, failed: c.failed - 1, warnings: c.warnings }
    : { passed: c.passed + 1, failed: c.failed, warnings: c.warnings - 1 };
}

/** The gain the app would display for this fix, wired exactly like scan.ts. */
function estimate(cats: CatMap, category: string, fix: Fix): number {
  const c = cats[category];
  if (!c) return 0;
  return estimateOverallGain(
    { score: catScore(c), passed: c.passed, failed: c.failed, warnings: c.warnings },
    category,
    fix,
    overall(cats).usedWeight,
  );
}

/** Exact (pre-rounding) overall change: Δcategory × weight ÷ scored weight. */
function exactDelta(cats: CatMap, category: string, fix: Fix): number {
  const c = cats[category];
  if (!c) return 0;
  const before = catScore(c) ?? 0;
  const after = catScore(applyFix(c, fix)) ?? 0;
  return ((after - before) * OVERALL_WEIGHTS[category]) / overall(cats).usedWeight;
}

describe("estimateOverallGain verified against the actual scoring formula", () => {
  test("baseline fixture recomputes to the documented scores and weights", () => {
    expect(catScore(BASE.Security)).toBe(60);
    expect(catScore(BASE.Performance)).toBe(70);
    expect(catScore(BASE.SEO)).toBe(80);
    expect(catScore(BASE["Technical Health"])).toBe(85);
    expect(catScore(BASE.Accessibility)).toBe(90);
    expect(overall(BASE).score).toBe(73);
    expect(overall(BASE).usedWeight).toBeCloseTo(1, 5);
  });

  test("FAILED check: estimate equals the recomputed overall-score change exactly", () => {
    const sec = BASE.Security as CatCounts;
    const before = overall(BASE).score ?? 0;
    const after = overall({ ...BASE, Security: applyFix(sec, "fail") }).score ?? 0;
    // Security 60 → 70 ⇒ Δcategory = 100/10 = 10, Δoverall = 10 × .30 / 1.00 = 3
    expect(catScore(applyFix(sec, "fail"))).toBe(70);
    expect(after - before).toBe(3);
    expect(estimate(BASE, "Security", "fail")).toBe(3);
    expect(exactDelta(BASE, "Security", "fail")).toBeCloseTo(3, 5);
  });

  test("WARNING: estimate is exactly half a failed check and matches the recomputed change within the rounding bound", () => {
    const sec = BASE.Security as CatCounts;
    const before = overall(BASE).score ?? 0;
    const after = overall({ ...BASE, Security: applyFix(sec, "warning") }).score ?? 0;
    // Security 60 → 65 ⇒ exact overall 74.5, which overallScore()'s Math.round
    // turns into a displayed change of 2 — the only source of drift allowed here.
    expect(catScore(applyFix(sec, "warning"))).toBe(65);
    const est = estimate(BASE, "Security", "warning");
    expect(est).toBe(1.5);
    expect(est).toBe(estimate(BASE, "Security", "fail") / 2);
    expect(exactDelta(BASE, "Security", "warning")).toBeCloseTo(1.5, 5);
    expect(Math.abs(after - before - est)).toBeLessThanOrEqual(1);
  });

  test("MULTIPLE findings in one category: per-finding gains add up to the recomputed change", () => {
    const sec = BASE.Security as CatCounts;
    const before = overall(BASE).score ?? 0;

    // Fix both failures: Security 60 → 80 ⇒ Δoverall = 20 × .30 = 6 exactly.
    const twoFails: CatMap = { ...BASE, Security: applyFix(applyFix(sec, "fail"), "fail") };
    expect(catScore(twoFails.Security)).toBe(80);
    expect((overall(twoFails).score ?? 0) - before).toBe(6);
    expect(estimate(BASE, "Security", "fail") * 2).toBe(6);
    // Exact (pre-rounding) deltas are additive too: one fix = 3, two fixes = 6.
    expect(exactDelta(BASE, "Security", "fail")).toBeCloseTo(3, 5);
    expect(exactDelta(BASE, "Security", "fail") * 2).toBeCloseTo(6, 5);

    // Fix one failure AND one warning: Security 60 → 75 ⇒ exact Δ = 4.5,
    // displayed 78 − 73 = 5 after the final round (drift ≤ 1 as documented).
    const both: CatMap = {
      ...BASE,
      Security: applyFix(applyFix(sec, "fail"), "warning"),
    };
    expect(catScore(both.Security)).toBe(75);
    const summed = estimate(BASE, "Security", "fail") + estimate(BASE, "Security", "warning");
    expect(summed).toBe(4.5);
    expect(Math.abs((overall(both).score ?? 0) - before - summed)).toBeLessThanOrEqual(1);
  });

  test("DIFFERENT scored weights: the same fix scales with each category's weight", () => {
    const before = overall(BASE).score ?? 0;
    for (const category of Object.keys(BASE)) {
      const c = BASE[category] as CatCounts;
      const weight = OVERALL_WEIGHTS[category];
      const fixed: CatMap = { ...BASE, [category]: applyFix(c, "fail") };

      const est = estimate(BASE, category, "fail");
      const exact = (10 * weight) / overall(BASE).usedWeight; // Δcategory = 100/10 = 10
      const displayed = (overall(fixed).score ?? 0) - before;

      // Estimate = the formula, to one decimal …
      expect(exactDelta(BASE, category, "fail")).toBeCloseTo(exact, 5);
      expect(Math.abs(est - exact)).toBeLessThanOrEqual(0.051);
      // … and the recomputed, displayed overall never drifts from it by more
      // than the pipeline's own final rounding.
      expect(Math.abs(displayed - est)).toBeLessThanOrEqual(1);
    }
    // The weight scaling itself, spelled out for the two extremes:
    expect(estimate(BASE, "Security", "fail")).toBe(3); // .30
    expect(estimate(BASE, "Technical Health", "fail")).toBe(1); // .10
    expect(estimate(BASE, "Security", "fail")).toBeCloseTo(
      estimate(BASE, "Technical Health", "fail") * 3,
      5,
    );
  });

  test("an UNSCORED category is excluded and the gain renormalizes over the scored weight", () => {
    const cats: CatMap = { ...BASE, Accessibility: null };
    expect(cats.Accessibility).toBeNull();
    expect(catScore(cats.Accessibility)).toBeNull();
    const used = overall(cats).usedWeight;
    expect(used).toBeCloseTo(0.9, 5);
    expect(overall(cats).score).not.toBeNull();

    const est = estimate(cats, "Security", "fail");
    // 10 × .30 ÷ .90 = 3.333… → 3.3 — strictly more than the un-renormalized 3.0,
    // which is what proves the denominator is really the scored weight.
    expect(est).toBe(3.3);
    expect(est).toBeGreaterThan(10 * OVERALL_WEIGHTS.Security);
    expect(exactDelta(cats, "Security", "fail")).toBeCloseTo(10 * 0.3 / 0.9, 4);

    const before = overall(cats).score ?? 0;
    const after = overall({ ...cats, Security: applyFix(cats.Security as CatCounts, "fail") }).score ?? 0;
    expect(Math.abs(after - before - est)).toBeLessThanOrEqual(1);
  });

  test("estimate never drifts from the recomputed overall change beyond the documented rounding bound", () => {
    const before = overall(BASE).score ?? 0;
    for (const category of Object.keys(BASE)) {
      for (const fix of ["fail", "warning"] as const) {
        const c = BASE[category] as CatCounts;
        if (fix === "warning" && c.warnings === 0) continue; // nothing to fix
        const fixed: CatMap = { ...BASE, [category]: applyFix(c, fix) };
        const est = estimate(BASE, category, fix);
        const displayed = (overall(fixed).score ?? 0) - before;
        expect(Math.abs(displayed - est)).toBeLessThanOrEqual(1); // final-round bound
        expect(Math.abs(exactDelta(BASE, category, fix) - est)).toBeLessThanOrEqual(0.051);
        expect(est).toBeGreaterThan(0);
      }
    }
  });

  test("a single-fix estimate never exceeds the gain of fixing every failure in that category", () => {
    const sec = BASE.Security as CatCounts; // 3 failures
    const fullyFixed: CatMap = {
      ...BASE,
      Security: { passed: sec.passed + sec.failed, failed: 0, warnings: sec.warnings },
    };
    const realMax = (overall(fullyFixed).score ?? 0) - (overall(BASE).score ?? 0);
    expect(realMax).toBe(9); // 60 → 90 ⇒ 30 × .30
    expect(estimate(BASE, "Security", "fail") * sec.failed).toBeLessThanOrEqual(realMax);
  });
});
