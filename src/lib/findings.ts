// ── Finding builder: every finding must be traceable to real evidence ───────
// Rules enforced here:
//  * a finding without concrete evidence can never be marked confirmed/fail
//  * a fix is only offered when the evidence supports one
//  * every finding records method, stage, URL and timestamp

import type {
  DetectionMethod,
  FindingEvidence,
  Issue,
  Priority,
  Severity,
} from "../types/scan";

export const DEFAULT_STAGE_BY_CATEGORY: Record<string, string> = {
  Performance: "fetch",
  SEO: "html",
  Accessibility: "html",
  "Technical Health": "html",
  Security: "headers",
};

export interface FindingInput {
  category: string;
  severity: Severity;
  priority: Priority;
  message: string;
  whyItMatters: string;
  /** Omit or leave empty when the evidence does not support a concrete fix. */
  howToFix?: string;
  evidence?: string;
  evidenceUrl?: string;
  stage?: string;
  method?: DetectionMethod;
  checkKey?: string;
  detectedAt?: number;
  confirmed?: boolean;
  status?: Issue["status"];
}

export function makeFinding(input: FindingInput): Issue {
  const evidence = (input.evidence ?? "").trim();
  const hasEvidence = evidence.length > 0;
  const confirmed = hasEvidence && (input.confirmed ?? true);
  const method: DetectionMethod = input.method ?? "http";
  return {
    category: input.category,
    severity: input.severity,
    priority: input.priority,
    message: input.message,
    whyItMatters: input.whyItMatters,
    howToFix: (input.howToFix ?? "").trim(),
    evidence: hasEvidence ? evidence : "No direct evidence was recorded for this finding.",
    evidenceUrl: input.evidenceUrl,
    stage: input.stage ?? DEFAULT_STAGE_BY_CATEGORY[input.category] ?? "fetch",
    method,
    checkKey: input.checkKey,
    detectedAt: input.detectedAt,
    status: input.status ?? (input.severity === "info" ? "warning" : "fail"),
    confirmed,
  };
}

/** Validation used by tests and as a last line of defence before saving. */
export function findingProblem(issue: Issue): string | null {
  if (!issue.category) return "missing category";
  if (!issue.message) return "missing message";
  if (!issue.evidence || !issue.evidence.trim()) return "missing evidence";
  if (issue.evidence === "No direct evidence was recorded for this finding." && issue.status === "fail") {
    return "cannot fail without evidence";
  }
  if (!issue.method) return "missing detection method";
  if (!issue.stage) return "missing scan stage";
  if (issue.confirmed === true && issue.status === "unable-to-verify") {
    return "cannot be confirmed and unverified at once";
  }
  if (issue.status === "fail" && issue.confirmed !== true) {
    return "a failure must be confirmed by evidence";
  }
  return null;
}
