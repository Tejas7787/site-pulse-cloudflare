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
