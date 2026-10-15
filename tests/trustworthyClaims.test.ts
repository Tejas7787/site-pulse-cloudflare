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
