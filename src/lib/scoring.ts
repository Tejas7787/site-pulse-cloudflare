// ── SitePulse scoring engine ────────────────────────────────────────────────
// Every score is derived only from checks that were actually evaluated.
//
// CATEGORY FORMULA (applies to Performance, SEO, Security, Accessibility,
// Technical Health alike):
//
//   applicable = passed + failed + warnings
//   score      = round(100 × (passed + 0.5 × warnings) ÷ applicable)
//
//   • "Unable to Verify" and "Not Applicable" checks are EXCLUDED from both the
//     numerator and the denominator — they neither reward nor punish.
//   • If applicable === 0 the category has NO score: hasScore=false and the UI
//     must display "—" / "not enough data" instead of 0/100.
//
// OVERALL FORMULA:
//
//   overall = round( Σ(score_c × weight_c for scored categories c)
//                    ÷ Σ(weight_c for scored categories c) )
//
//   Weights: Security .30 · Performance .25 · SEO .25 · Technical Health .10 ·
//            Accessibility .10. Categories without a score are dropped and the
//            remaining weights are renormalized, so incomplete data can never
//            drag a category to 0.

import type { CategoryScore, CheckResult } from "../types/scan";

export const CATEGORY_SCORE_FORMULA =
  "score = round(100 × (passed + 0.5 × warnings) ÷ applicable), where applicable = passed + failed + warnings; checks that are Unable to Verify or Not Applicable are excluded";

export const OVERALL_WEIGHTS: Record<string, number> = {
  Security: 0.3,
  Performance: 0.25,
  SEO: 0.25,
  "Technical Health": 0.1,
  Accessibility: 0.1,
};

export const OVERALL_SCORE_FORMULA =
  "overall = round(Σ(score × weight) ÷ Σ(weight)) over categories that have a score — weights: Security 30%, Performance 25%, SEO 25%, Technical Health 10%, Accessibility 10%; categories with no verified checks are excluded and the remaining weights renormalized";

export interface CheckCounts {
  passed: number;
  failed: number;
  warnings: number;
  /** Not Applicable. */
  notApplicable: number;
  /** Unable to Verify. */
  unverified: number;
  /** passed + failed + warnings — the denominator of the formula. */
  applicable: number;
  total: number;
}

/** Tally every check state. Unknown string values are treated as unverified. */
export function tallyChecks(checks: Record<string, CheckResult>): CheckCounts {
  const counts: CheckCounts = {
    passed: 0,
    failed: 0,
    warnings: 0,
    notApplicable: 0,
    unverified: 0,
    applicable: 0,
    total: 0,
  };
  for (const result of Object.values(checks)) {
    counts.total++;
    if (result === "pass") counts.passed++;
    else if (result === "fail") counts.failed++;
    else if (result === "warn") counts.warnings++;
    else if (result === "na") counts.notApplicable++;
    else counts.unverified++; // "not-checked" or any unexpected value
  }
  counts.applicable = counts.passed + counts.failed + counts.warnings;
  return counts;
}

/** Category score from counts, or null when nothing was verifiable. */
export function scoreFromCounts(counts: CheckCounts): number | null {
  if (counts.applicable === 0) return null;
  return Math.round(
    (100 * (counts.passed + 0.5 * counts.warnings)) / counts.applicable,
  );
}

/**
 * The main factors affecting a category score, derived strictly from check
 * states (failing checks first, then warnings, then what could not be verified).
 */
export function categoryFactors(checks: Record<string, CheckResult>): string[] {
  const groups: Array<[string, string[]]> = [
    ["Failing", []],
    ["Warning", []],
    ["Unable to verify", []],
    ["Not applicable", []],
  ];
  for (const [key, result] of Object.entries(checks)) {
    if (result === "fail") groups[0][1].push(key);
    else if (result === "warn") groups[1][1].push(key);
    else if (result === "na") groups[3][1].push(key);
    else if (result === "not-checked") groups[2][1].push(key);
  }
  return groups
    .filter(([, keys]) => keys.length > 0)
    .map(([label, keys]) => `${label}: ${keys.join(", ")}`);
}

/** Build the stored CategoryScore (counts + score + formula + factors). */
export function scoreCategory(checks: Record<string, CheckResult>): CategoryScore {
  const counts = tallyChecks(checks);
  const score = scoreFromCounts(counts);
  return {
    score: score ?? 0,
    passed: counts.passed,
    failed: counts.failed,
    warnings: counts.warnings,
    notChecked: counts.unverified + counts.notApplicable, // legacy display field
    applicable: counts.applicable,
    unverified: counts.unverified,
    notApplicable: counts.notApplicable,
    hasScore: score !== null,
    formula: CATEGORY_SCORE_FORMULA,
    factors: categoryFactors(checks),
  };
}

/**
 * Weighted overall score over the categories that actually have a score.
 * Returns null when no category is scoreable (report must not show 0/100).
 */
export function overallScore(
  categoryScores: Record<string, number | null>,
): { score: number | null; usedWeight: number; formula: string } {
  let weightSum = 0;
  let weighted = 0;
  for (const [category, score] of Object.entries(categoryScores)) {
    const weight = OVERALL_WEIGHTS[category];
    if (weight === undefined || score === null) continue;
    weightSum += weight;
    weighted += score * weight;
  }
  const score = weightSum === 0 ? null : Math.round(weighted / weightSum);
  return { score, usedWeight: weightSum, formula: OVERALL_SCORE_FORMULA };
}

// ── Rendering-side resolution ───────────────────────────────────────────────
// The report page and the PDF export must ALWAYS show the same numbers, and
// those numbers must always agree with the saved check data and the printed
// methodology. Historical scan documents could carry a saved `score`/`grade`
// (and saved root category scores) that no longer matched their own saved
// per-check counts — e.g. a document showing 67/100 while its category counts
// and stated weights recompute to 64. To make that class of mismatch
// impossible, both renderers derive what they display from the SAME saved
// applicable checks via the SAME functions the scanner uses.

/** Structural subset of a saved category-checks document (see convex/scans.ts). */
export interface StoredCategoryChecks {
  score?: number;
  passed?: number;
  failed?: number;
  warnings?: number;
  /** Legacy display field: unverified + notApplicable at save time. */
  notChecked?: number;
  applicable?: number;
  unverified?: number;
  notApplicable?: number;
  hasScore?: boolean;
}

/** Structural subset of a saved scan document consumed by both renderers. */
export interface StoredScanScores {
  score?: number;
  grade?: string;
  overallScored?: boolean;
  performanceScore?: number;
  seoScore?: number;
  securityScore?: number;
  accessibilityScore?: number;
  technicalHealthScore?: number;
  performanceChecks?: StoredCategoryChecks;
  seoChecks?: StoredCategoryChecks;
  securityChecks?: StoredCategoryChecks;
  accessibilityChecks?: StoredCategoryChecks;
  technicalHealthChecks?: StoredCategoryChecks;
  summary?: { overallScored?: boolean } | null;
}

export interface ResolvedCategoryScore {
  /** Derived score, or null when the category has no verified checks. */
  score: number | null;
  passed: number;
  failed: number;
  warnings: number;
  unverified: number;
  notApplicable: number;
}

export interface ResolvedScanScores {
  /** Per-category derived scores, keyed by the OVERALL_WEIGHTS category names. */
  categories: Record<string, ResolvedCategoryScore | null>;
  /** Weighted, renormalized overall — null when nothing was scoreable. */
  overall: number | null;
  /** Grade of the derived overall — null when there is no overall score. */
  grade: string | null;
  overallScored: boolean;
}

function categoryInputs(scan: StoredScanScores) {
  return [
    { name: "Performance", score: scan.performanceScore, checks: scan.performanceChecks },
    { name: "SEO", score: scan.seoScore, checks: scan.seoChecks },
    { name: "Security", score: scan.securityScore, checks: scan.securityChecks },
    { name: "Accessibility", score: scan.accessibilityScore, checks: scan.accessibilityChecks },
    { name: "Technical Health", score: scan.technicalHealthScore, checks: scan.technicalHealthChecks },
  ];
}

/**
 * Derive what a saved scan must display. Pure, synchronous, no I/O — shared
 * verbatim by src/pages/Report.tsx and src/lib/pdfReport.ts so the two can
 * never disagree.
 *
 * Rules:
 * - A category WITH a saved checks document is re-scored from its own saved
 *   counts via the documented formula (warnings count half; Unable to Verify
 *   and Not Applicable are excluded). The saved `hasScore` flag wins when
 *   present; docs saved before the flag use applicable > 0.
 * - A category WITHOUT a checks document (very old docs) keeps its saved
 *   category score — there is nothing to honestly re-derive from.
 * - The overall score is recomputed with `overallScore()` whenever ANY
 *   category is checks-derived, so it always matches the category data and the
 *   printed weights. Only documents with no saved check data at all keep their
 *   saved overall/grade.
 * - The grade always follows the derived overall via `scoreToGrade` — a saved
 *   grade string is never trusted over the score it describes.
 */
export function resolveScanScores(scan: StoredScanScores): ResolvedScanScores {
  const categories: Record<string, ResolvedCategoryScore | null> = {};
  let anyChecksDerived = false;

  for (const { name, score: storedScore, checks } of categoryInputs(scan)) {
    if (!checks) {
      categories[name] =
        storedScore === undefined
          ? null
          : {
              score: storedScore,
              passed: 0, failed: 0, warnings: 0, unverified: 0, notApplicable: 0,
            };
      continue;
    }
    anyChecksDerived = true;
    const passed = checks.passed ?? 0;
    const failed = checks.failed ?? 0;
    const warnings = checks.warnings ?? 0;
    const notApplicable = checks.notApplicable ?? 0;
    const unverified = checks.unverified ?? checks.notChecked ?? 0;
    const counts: CheckCounts = {
      passed, failed, warnings, notApplicable, unverified,
      applicable: passed + failed + warnings,
      total: passed + failed + warnings + notApplicable + unverified,
    };
    const hasScore = (checks.hasScore ?? true) && counts.applicable > 0;
    const score = hasScore
      ? scoreFromCounts(counts) ?? checks.score ?? storedScore ?? null
      : null;
    categories[name] = { score, passed, failed, warnings, unverified, notApplicable };
  }

  if (anyChecksDerived) {
    const derived = overallScore(
      Object.fromEntries(
        categoryInputs(scan).map(({ name }) => [name, categories[name]?.score ?? null]),
      ),
    );
    return {
      categories,
      overall: derived.score,
      grade: derived.score === null ? null : scoreToGrade(derived.score),
      overallScored: derived.score !== null,
    };
  }

  // No saved check data at all — render the saved overall exactly as stored.
  const savedScored = scan.overallScored ?? scan.summary?.overallScored ?? scan.score !== undefined;
  return {
    categories,
    overall: scan.score ?? null,
    grade:
      scan.grade && scan.grade.length > 0
        ? scan.grade
        : scan.score === undefined
          ? null
          : scoreToGrade(scan.score),
    overallScored: savedScored && scan.score !== undefined,
  };
}

export function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
