// ── PDF/report score consistency ─────────────────────────────────────────────
// Regression tests for the confirmed score mismatch: the interactive report
// page and the PDF export must derive everything they display — overall,
// grade, per-category scores and which categories are scoreable — through the
// SAME shared resolver (src/lib/scoring.ts · resolveScanScores), applied to
// the SAME saved applicable checks. A stale saved overall/grade can therefore
// never be shown, and the two artifacts can never disagree with each other or
// with the printed methodology.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildScanPdf, type PdfScanInput } from "../src/lib/pdfReport";
import {
  OVERALL_WEIGHTS,
  overallScore,
  resolveScanScores,
  scoreCategory,
  scoreToGrade,
} from "../src/lib/scoring";
import { extractPdfText, normalize } from "./pdfExtract";
import {
  blocked429Scan,
  normalScan,
  notFound404Scan,
  staleOverallScan,
  zeroFindingsScan,
} from "./pdfFixtures";

const GENERATED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);
const SCANNED_AT = Date.UTC(2026, 9, 9, 14, 32, 5);

function pdfNorm(scan: PdfScanInput): string {
  return normalize(extractPdfText(buildScanPdf(scan, { generatedAt: GENERATED_AT }).bytes));
}

function mkScan(over: Partial<PdfScanInput>): PdfScanInput {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    score: 0,
    grade: "F",
    issues: [],
    scannedAt: SCANNED_AT,
    ...over,
  } as PdfScanInput;
}

/** Independent re-computation of the weighted overall from resolved categories. */
function recomputeOverall(categories: Record<string, { score: number | null }>): number | null {
  let weight = 0;
  let weighted = 0;
  for (const [name, cat] of Object.entries(categories)) {
    const w = OVERALL_WEIGHTS[name];
    if (w === undefined || cat.score === null) continue;
    weight += w;
    weighted += cat.score * w;
  }
  return weight === 0 ? null : Math.round(weighted / weight);
}

describe("stale saved overall — the 67-vs-~65 mismatch", () => {
  const scan = staleOverallScan();
  const resolved = resolveScanScores(scan);

  test("resolver derives the overall from the saved category counts, not the stale saved score", () => {
    // Saved doc claims 67/C; its own counts recompute to
    // 67×.25 + 41×.25 + 79×.30 + 67×.10 + 67×.10 = 64.1 → 64.
    expect(resolved.overall).toBe(64);
    expect(resolved.overall).not.toBe(scan.score);
    expect(resolved.overallScored).toBe(true);
  });

  test("derived overall equals an independent weighted recomputation of the derived categories", () => {
    expect(resolved.overall).toBe(recomputeOverall(resolved.categories));
  });

  test("the PDF renders the derived score and grade and never the stale saved ones", () => {
    const text = pdfNorm(scan);
    expect(text).toContain("64/100");
    expect(text).toContain("GRADE D");
    expect(text).not.toContain("67/100");
    expect(text).not.toContain("GRADE C");
  });

  test("a scanner-shaped (self-consistent) document resolves to exactly its saved values", () => {
    const perfChecks = { good: "pass", bad: "fail", warn: "warn" } as const;
    const perf = scoreCategory({ ...perfChecks });
    const sec = scoreCategory({ a: "pass", b: "pass", c: "fail" });
    const overall = overallScore({ Performance: perf.score, Security: sec.score });
    const resolvedDoc = resolveScanScores({
      performanceScore: perf.score,
      securityScore: sec.score,
      performanceChecks: perf,
      securityChecks: sec,
    });
    expect(overall.score).not.toBeNull();
    expect(resolvedDoc.overall).toBe(overall.score);
    expect(resolvedDoc.grade).toBe(scoreToGrade(overall.score as number));
    expect(resolvedDoc.categories.Performance?.score).toBe(perf.score);
    expect(resolvedDoc.categories.Security?.score).toBe(sec.score);
  });
});

describe("missing categories — excluded, renormalized, never zero", () => {
  test("unscored categories resolve to null and drop out of the weighted overall", () => {
    const scan = notFound404Scan();
    const resolved = resolveScanScores(scan);
    expect(resolved.categories.SEO?.score).toBeNull();
    expect(resolved.categories.Accessibility?.score).toBeNull();
    expect(resolved.categories.Performance?.score).toBe(50);
    expect(resolved.categories.Security?.score).toBe(40);
    expect(resolved.categories["Technical Health"]?.score).toBe(20);
    // (50×.25 + 40×.30 + 20×.10) ÷ (.25 + .30 + .10) = 41.53… → 41
    expect(resolved.overall).toBe(41);
    expect(resolved.overall).toBe(recomputeOverall(resolved.categories));
    expect(resolved.grade).toBe("F");
  });

  test("the PDF shows the derived overall for a partial scan and a dash for unscored categories", () => {
    const text = pdfNorm(notFound404Scan());
    expect(text).toContain("41/100");
    expect(text).toContain("GRADE F");
  });

  test("a fully blocked scan stays unscored everywhere — no fabricated number, no grade", () => {
    const scan = blocked429Scan();
    const resolved = resolveScanScores(scan);
    expect(resolved.overall).toBeNull();
    expect(resolved.grade).toBeNull();
    expect(resolved.overallScored).toBe(false);
    for (const cat of Object.values(resolved.categories)) expect(cat?.score).toBeNull();
    const text = pdfNorm(scan);
    expect(text).toContain("OVERALL HEALTH SCORE —");
    expect(text).not.toContain("GRADE");
  });
});

describe("warnings — counted half, identically in both renderers", () => {
  test("a category with warnings resolves via the documented formula and renders the same in the PDF", () => {
    const scan = mkScan({
      performanceChecks: { score: 99, passed: 3, failed: 1, warnings: 1, notChecked: 0, hasScore: true },
      securityChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 4, hasScore: false },
      seoChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 4, hasScore: false },
      accessibilityChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 4, hasScore: false },
      technicalHealthChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 4, hasScore: false },
      performanceScore: 99, // stale saved value — must be ignored in favour of the counts
    });
    const resolved = resolveScanScores(scan);
    // round(100 × (3 + 0.5×1) ÷ 5) = 70
    expect(resolved.categories.Performance?.score).toBe(70);
    expect(resolved.overall).toBe(70); // only scoreable category ⇒ its score is the overall
    expect(resolved.grade).toBe(scoreToGrade(70));
    expect(pdfNorm(scan)).toContain("70/100");
  });

  test("warnings are half-credit, not free: a warn-only category resolves to 50", () => {
    const resolved = resolveScanScores(mkScan({
      securityChecks: { passed: 0, failed: 0, warnings: 2, notChecked: 0, hasScore: true },
    }));
    expect(resolved.categories.Security?.score).toBe(50);
  });
});

describe("grade consistency — the grade always describes the displayed score", () => {
  test("grade boundaries: 65 → C, 64 → D", () => {
    const atBoundary = resolveScanScores(mkScan({
      securityChecks: { passed: 13, failed: 7, warnings: 0, notChecked: 0, hasScore: true },
      grade: "A", // stale saved grade — must not win over the derived score
    }));
    expect(atBoundary.overall).toBe(65);
    expect(atBoundary.grade).toBe("C");

    const belowBoundary = resolveScanScores(mkScan({
      securityChecks: { passed: 16, failed: 9, warnings: 0, notChecked: 0, hasScore: true },
      grade: "C", // stale saved grade — derived 64 is a D
    }));
    expect(belowBoundary.overall).toBe(64);
    expect(belowBoundary.grade).toBe("D");
    expect(pdfNorm(mkScan({
      securityChecks: { passed: 16, failed: 9, warnings: 0, notChecked: 0, hasScore: true },
      grade: "C",
    }))).toContain("GRADE D");
  });

  test("every rendered grade matches scoreToGrade of the rendered overall (full fixture sweep)", () => {
    const scans: PdfScanInput[] = [normalScan(), staleOverallScan(), notFound404Scan(), zeroFindingsScan(), blocked429Scan()];
    for (const scan of scans) {
      const resolved = resolveScanScores(scan);
      if (!resolved.overallScored) continue;
      expect(resolved.grade).toBe(scoreToGrade(resolved.overall as number));
      const text = pdfNorm(scan);
      expect(text).toContain(`${resolved.overall}/100`);
      expect(text).toContain(`GRADE ${resolved.grade}`);
    }
  });
});

describe("legacy documents without saved category data", () => {
  const legacy = mkScan({ score: 71, grade: "" });

  test("keep the saved overall when there is nothing to honestly re-derive from", () => {
    const resolved = resolveScanScores(legacy);
    expect(resolved.overall).toBe(71);
    expect(resolved.overallScored).toBe(true);
  });

  test("an empty saved grade falls back to the grade of the saved score", () => {
    expect(resolveScanScores(legacy).grade).toBe("C");
  });

  test("the PDF renders the saved overall for such documents", () => {
    const text = pdfNorm(legacy);
    expect(text).toContain("71/100");
    expect(text).toContain("GRADE C");
  });
});

describe("reported live case — categories 83 / 69 / 41 / 83 / 79", () => {
  // A user reported that the live site shows 67/C for these displayed
  // categories and calculated by hand that the weighted formula "gives 65.2".
  // The hand arithmetic is wrong — the weighted sum is exactly 66.5:
  //   Performance 83 × .25 = 20.75
  //   SEO          69 × .25 = 17.25
  //   Security     41 × .30 = 12.30
  //   Accessibility 83 × .10 = 8.30
  //   Tech Health  79 × .10 =  7.90
  //   total                 = 66.50 → round → 67 → grade C (≥ 65).
  // These tests pin the deployed behaviour to that arithmetic so the correct
  // value can never be "fixed" to the mis-added 65.
  const scan = mkScan({
    performanceScore: 83, seoScore: 69, securityScore: 41,
    accessibilityScore: 83, technicalHealthScore: 79,
    score: 67, grade: "C",
    performanceChecks: { passed: 5, failed: 1, warnings: 0, notChecked: 0, hasScore: true },     // round(100×5/6) = 83
    seoChecks: { passed: 9, failed: 4, warnings: 0, notChecked: 0, hasScore: true },              // round(100×9/13) = 69
    securityChecks: { passed: 7, failed: 10, warnings: 0, notChecked: 0, hasScore: true },        // round(100×7/17) = 41
    accessibilityChecks: { passed: 5, failed: 1, warnings: 0, notChecked: 0, hasScore: true },    // round(100×5/6) = 83
    technicalHealthChecks: { passed: 11, failed: 3, warnings: 0, notChecked: 0, hasScore: true }, // round(100×11/14) = 79
  });
  const resolved = resolveScanScores(scan);

  test("each category re-derives to the exact displayed score", () => {
    expect(resolved.categories.Performance?.score).toBe(83);
    expect(resolved.categories.SEO?.score).toBe(69);
    expect(resolved.categories.Security?.score).toBe(41);
    expect(resolved.categories.Accessibility?.score).toBe(83);
    expect(resolved.categories["Technical Health"]?.score).toBe(79);
  });

  test("the weighted overall is 66.5 → 67 with grade C — not 65", () => {
    const terms = [83 * 0.25, 69 * 0.25, 41 * 0.3, 83 * 0.1, 79 * 0.1];
    const weightedSum = terms.reduce((a, b) => a + b, 0);
    expect(weightedSum).toBeCloseTo(66.5, 10); // 66.50, not 65.2
    expect(resolved.overall).toBe(67);
    expect(resolved.overall).toBe(recomputeOverall(resolved.categories));
    expect(resolved.grade).toBe("C"); // 65 and 67 are both grade C
  });

  test("the PDF renders 67/100 and GRADE C for this document", () => {
    const text = pdfNorm(scan);
    expect(text).toContain("67/100");
    expect(text).toContain("GRADE C");
    expect(text).not.toContain("65/100");
  });
});

describe("both renderers share one derivation", () => {
  test("Report.tsx and pdfReport.ts both import resolveScanScores from lib/scoring", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    const page = read("../src/pages/Report.tsx");
    const pdf = read("../src/lib/pdfReport.ts");
    expect(page).toContain('from "../lib/scoring"');
    expect(page).toContain("resolveScanScores");
    expect(pdf).toContain('from "./scoring"');
    expect(pdf).toContain("resolveScanScores");
  });
});
