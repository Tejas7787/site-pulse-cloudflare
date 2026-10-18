// ── AI Website Doctor — deterministic, evidence-grounded diagnosis ──────────
// Pure module (no I/O, no Convex imports): turns a saved scan into a
// plain-language diagnosis — what each top finding means, why it likely
// happened, what it costs and what to do — using ONLY data already saved on
// the document (message, whyItMatters, howToFix, evidence, stage) plus the
// existing scoring/recommendation helpers. Shared verbatim by the Convex
// action (src/convex/aiAssistant.ts → explainFindings), the report panel
// (src/components/WebsiteDoctor.tsx) and the unit tests.
//
// V1 runs entirely WITHOUT a model: `provider` is always "deterministic" and
// callers must label the output accordingly — never "AI-generated". When
// model credits are verified, a model pass may be layered in front of this
// engine; it must NOT change any number computed here (score gains always
// come from honestQuickWinGains, never from model prose).

import {
  honestQuickWinGains,
  resolveScanScores,
  scoreToGrade,
  type StoredScanScores,
} from "./scoring";

/**
 * Server-side diagnosis quota (Phase 3 V1): 10 per visitor per hour.
 * Defined here — a pure module both the browser and the Convex runtime can
 * import — and enforced in convex/rateLimit.ts (consumeAiQuota), so the
 * limit the UI states and the limit the server applies cannot drift.
 */
export const DIAGNOSIS_LIMIT_PER_HOUR = 10;
/** Length of the diagnosis window. */
export const DIAGNOSIS_WINDOW_MS = 60 * 60 * 1000; // 1 hour
import {
  anchorsFor,
  canonicalActionable,
  issueKey,
  type RecommendationIssue,
} from "./recommendations";

/** How many of the most urgent findings receive the full four-part treatment. */
export const DOCTOR_MAX_FINDINGS = 8;

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  important: "Important",
  recommended: "Recommended",
};

/** The diagnosis's view of one finding — strictly derived, never invented. */
export interface DoctorFinding {
  /** Stable identity (same scheme as FixRecommendations cards). */
  key: string;
  /** Anchor of the matching FixRecommendations card, when there is one. */
  anchor?: string;
  category: string;
  severity: string;
  priority: string;
  message: string;
  /** Simple-language meaning — the report's own whyItMatters text. */
  plainLanguage: string;
  /** Likely root cause: rule-based, evidence-backed, honestly generic. */
  likelyCause: string;
  /** Honest impact sentence incl. re-derived score gain. */
  impactText: string;
  /** Estimated overall-score gain, re-derived from this document's counts. */
  scoreGain: number;
  /** Concrete fix steps from howToFix; empty when the report has none. */
  fixSteps: string[];
  /** Observed evidence, verbatim, when the scan recorded any. */
  evidence?: string;
}

export interface DoctorDiagnosis {
  /** Always "deterministic" in V1 — display this, do not claim model output. */
  provider: "deterministic";
  url: string;
  /** Derived overall (resolveScanScores) or the saved score; null if unscored. */
  score: number | null;
  grade: string;
  summary: string;
  counts: { critical: number; important: number; recommended: number; actionable: number };
  findings: DoctorFinding[];
}

/** Structural input: every field optional except url/issues (saved scan docs). */
export type DoctorScanInput = StoredScanScores & {
  url: string;
  issues: Array<RecommendationIssue & { stage?: string }>;
  quickWins?: Array<{ category: string; message: string }>;
};

/* ── Likely-cause rules ───────────────────────────────────────────────────── */
// Matched against the finding's own message text. Every consequence is
// phrased as the typical/likely mechanism behind that exact observation —
// nothing here asserts facts about the site beyond what the scan saved.

interface CauseRule {
  test: RegExp;
  cause: string;
}

const CAUSE_RULES: CauseRule[] = [
  {
    test: /content-security-policy|\bcsp\b/i,
    cause: "The server never sends a Content-Security-Policy header — the default for most servers and hosting platforms unless a policy is configured explicitly.",
  },
  {
    test: /strict-transport-security|\bhsts\b/i,
    cause: "The host does not send a Strict-Transport-Security header, so browsers are never told to force HTTPS — common when HTTPS was added after the site first shipped.",
  },
  {
    test: /x-frame-options|clickjack/i,
    cause: "The response omits X-Frame-Options, so browsers do not refuse being embedded in other sites — this header is simply not part of the current server configuration.",
  },
  {
    test: /x-content-type-options|referrer-policy|permissions-policy|x-permitted-cross-domain/i,
    cause: "A standard hardening header is absent from the response — these are off by default and stay off until someone enables them in the server or CDN configuration.",
  },
  {
    test: /certificate|\bssl\b|\btls\b/i,
    cause: "The TLS certificate presented for this host failed the check (expired, expiring, or not presented) — certificates usually lapse when auto-renewal is not configured on the current hosting.",
  },
  {
    test: /\bcookie\b/i,
    cause: "A cookie was set without one or more of its security attributes (Secure, HttpOnly, SameSite) — the framework or endpoint default, unless it is hardened explicitly.",
  },
  {
    test: /mixed content|\bhttp:\/\//i,
    cause: "A resource is loaded over plain http:// from a page served over https:// — the asset URL was written or generated without the https scheme.",
  },
  {
    test: /\bviewport\b/i,
    cause: "The page head contains no viewport meta tag, which happens when the template was built without responsive layout in mind.",
  },
  {
    test: /meta description/i,
    cause: "The document head has no meta description — the page template simply does not render one.",
  },
  {
    test: /\bpage title\b|\b<title\b|title tag/i,
    cause: "The document's title element is missing or empty — the page template never sets one for this URL.",
  },
  {
    test: /\balt text\b|\balt attribute\b|without alt/i,
    cause: "Images in the markup have no alt attributes — typical when content is written directly or imported without accessibility checks.",
  },
  {
    test: /\bh1\b|heading structure|heading hierarchy/i,
    cause: "The heading structure does not follow a single hierarchy — content was assembled without keeping one top-level heading per page.",
  },
  {
    test: /\bgzip\b|\bbrotli\b|compress/i,
    cause: "The server answered without content compression — compression is off by default until it is enabled for the site or its assets.",
  },
  {
    test: /\bredirect\b/i,
    cause: "The URL chain contains a redirect hop, usually left over from a domain, protocol or path migration that was never removed.",
  },
  {
    test: /\b[45]\d\d\b|status code/i,
    cause: "The origin returned a non-success status for this URL, meaning the resource is missing or erroring on the server.",
  },
];

/** Likely cause for one finding — rule, then evidence, then honest generic. */
export function likelyCauseFor(
  issue: RecommendationIssue & { stage?: string },
): string {
  const rule = CAUSE_RULES.find((r) => r.test.test(issue.message));
  if (rule) return rule.cause;
  if (issue.evidence && issue.stage) {
    return `The ${issue.stage} check failed against the observed response — recorded evidence: "${issue.evidence}".`;
  }
  if (issue.evidence) {
    return `Recorded evidence from the scan: "${issue.evidence}".`;
  }
  return `This ${issue.category} check failed against the observed response; the saved report does not record a more specific cause.`;
}

/** howToFix → steps: newline-separated first, then long single blobs by sentence. */
export function fixStepsFrom(howToFix: string): string[] {
  const trimmed = howToFix.trim();
  if (!trimmed) return [];
  const byLine = trimmed
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  if (byLine[0].length <= 240) return byLine;
  return byLine[0]
    .split(/(?<=\.)\s+(?=[A-Z0-9`*])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Honest impact sentence for one finding, driven only by re-derived gains. */
export function impactTextFor(priority: string, scoreGain: number): string {
  const label = PRIORITY_LABELS[priority] ?? "Recommended";
  if (scoreGain > 0) {
    return `${label}: fixing this is estimated to be worth about +${scoreGain} overall score points — re-derived from this report's own check counts and the published weights, not estimated by a model.`;
  }
  return `${label}: no direct effect on the numeric score (no verified check behind it to improve, or the finding is not score-bearing) — worth fixing as a correctness or best-practice matter.`;
}

/* ── Diagnosis assembly ───────────────────────────────────────────────────── */

/**
 * Build the full diagnosis for a saved scan. Pure and synchronous.
 *
 * Guarantees:
 * - ordering, dedup and "actionable only" come from canonicalActionable —
 *   the exact list FixRecommendations renders, so anchors always resolve;
 * - score gains come from honestQuickWinGains on THIS document's counts;
 * - no monitoring/incident context, no invented issues, no changed scores.
 */
export function buildDiagnosis(scan: DoctorScanInput): DoctorDiagnosis {
  const resolved = resolveScanScores(scan);
  const score = resolved.overall ?? scan.score ?? null;
  const grade = resolved.grade ?? (score !== null ? scoreToGrade(score) : "—");

  const actionable = canonicalActionable(scan.issues);
  const anchors = anchorsFor(actionable);
  const findings = actionable.slice(0, DOCTOR_MAX_FINDINGS);

  // One honest gain per finding, aligned index-for-index (same helper the
  // Quick Wins row uses).
  const gains = honestQuickWinGains(scan, findings);

  const counts = {
    critical: actionable.filter((i) => i.priority === "critical").length,
    important: actionable.filter((i) => i.priority === "important").length,
    recommended: actionable.filter((i) => i.priority === "recommended").length,
    actionable: actionable.length,
  };

  const url = scan.url;
  let summary: string;
  if (counts.actionable === 0) {
    summary = `Your report for ${url} scores ${
      score ?? "—"
    }/100 (grade ${grade}) and has no urgent findings — nothing needs fixing right now. Minor polish items remain under "Other Findings" in this report.`;
  } else {
    summary =
      `Your report for ${url} scores ${score ?? "—"}/100 (grade ${grade}). ` +
      `${counts.critical} critical, ${counts.important} important and ${counts.recommended} recommended findings are worth acting on; ` +
      `the ${findings.length} most urgent are explained below. ` +
      `Every explanation comes only from this report's saved evidence and check results — no issue is invented, and this diagnosis does not change any score.`;
  }

  return {
    provider: "deterministic",
    url,
    score,
    grade,
    summary,
    counts,
    findings: findings.map((issue, index) => ({
      key: issueKey(issue),
      ...(anchors.get(issueKey(issue)) ? { anchor: anchors.get(issueKey(issue))! } : {}),
      category: issue.category,
      severity: issue.severity,
      priority: issue.priority,
      message: issue.message,
      plainLanguage: issue.whyItMatters,
      likelyCause: likelyCauseFor(issue),
      impactText: impactTextFor(issue.priority, gains[index] ?? 0),
      scoreGain: gains[index] ?? 0,
      fixSteps: fixStepsFrom(issue.howToFix),
      ...(issue.evidence ? { evidence: issue.evidence } : {}),
    })),
  };
}
