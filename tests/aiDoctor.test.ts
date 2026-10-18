// Phase 3 (AI Website Doctor V1): the diagnosis engine must be deterministic
// and evidence-grounded — it reuses the report's canonical recommendation
// list, re-derives every score gain from the document's own counts, invents
// nothing, and never touches scoring formulas. The wiring tests pin that the
// action (a) enforces the server-side 10/hour quota BEFORE any work,
// (b) fetches the scan server-side by id, (c) makes NO external AI call in
// V1, and (d) that the panel never claims AI analysis ran when it did not.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  DIAGNOSIS_LIMIT_PER_HOUR,
  DIAGNOSIS_WINDOW_MS,
  DOCTOR_MAX_FINDINGS,
  buildDiagnosis,
  fixStepsFrom,
  impactTextFor,
  likelyCauseFor,
  type DoctorScanInput,
} from "../src/lib/aiDoctor";
import { anchorsFor, canonicalActionable } from "../src/lib/recommendations";
import { honestQuickWinGains } from "../src/lib/scoring";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

type TestIssue = DoctorScanInput["issues"][number];

const issue = (over: Partial<TestIssue> = {}): TestIssue => ({
  category: "Security",
  severity: "critical",
  priority: "critical",
  message: "Content-Security-Policy header missing",
  whyItMatters: "Without CSP, browsers cannot block injected scripts.",
  howToFix: "Add a Content-Security-Policy header.\nStart with report-only mode.",
  checkKey: "csp",
  evidence: "response did not include content-security-policy",
  status: "fail",
  ...over,
});

const makeScan = (issues: TestIssue[]): DoctorScanInput => ({
  url: "https://example.com/",
  score: 61,
  grade: "D",
  performanceChecks: { score: 70, passed: 3, failed: 1, warnings: 0, notChecked: 0, hasScore: true },
  seoChecks: { score: 55, passed: 2, failed: 2, warnings: 1, notChecked: 0, hasScore: true },
  securityChecks: { score: 40, passed: 1, failed: 3, warnings: 0, notChecked: 0, hasScore: true },
  accessibilityChecks: { score: 80, passed: 4, failed: 1, warnings: 0, notChecked: 0, hasScore: true },
  technicalHealthChecks: { score: 65, passed: 3, failed: 1, warnings: 0, notChecked: 0, hasScore: true },
  issues,
  quickWins: [],
});

describe("buildDiagnosis — deterministic, prioritized, capped", () => {
  test("explains only canonical actionable findings, most urgent first", () => {
    const scan = makeScan([
      issue({ message: "Nice to have thing", priority: "nice-to-have", checkKey: "n1" }),
      issue({ message: "Important finding", severity: "warning", priority: "important", checkKey: "i1" }),
      issue({ message: "Critical finding", checkKey: "c1" }),
      issue({ message: "Recommended finding", severity: "info", priority: "recommended", checkKey: "r1" }),
    ]);
    const diag = buildDiagnosis(scan);
    expect(diag.provider).toBe("deterministic");
    const messages = diag.findings.map((f) => f.message);
    expect(messages).not.toContain("Nice to have thing");
    expect(messages[0]).toBe("Critical finding");
    expect(messages[1]).toBe("Important finding");
    expect(messages[2]).toBe("Recommended finding");
    expect(diag.counts).toEqual({ critical: 1, important: 1, recommended: 1, actionable: 3 });
    expect(diag.summary).toContain("does not change any score");
  });

  test("caps the full treatment at DOCTOR_MAX_FINDINGS while counting all actionable", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      issue({ message: `Finding number ${i}`, checkKey: `k${i}` }),
    );
    const diag = buildDiagnosis(makeScan(many));
    expect(diag.findings.length).toBe(DOCTOR_MAX_FINDINGS);
    expect(diag.counts.actionable).toBe(12);
  });

  test("a report with no urgent findings diagnoses nothing, honestly", () => {
    const scan = makeScan([issue({ priority: "nice-to-have", checkKey: "n2" })]);
    const diag = buildDiagnosis(scan);
    expect(diag.findings).toEqual([]);
    expect(diag.counts.actionable).toBe(0);
    expect(diag.summary).toContain("no urgent findings");
  });
});

describe("buildDiagnosis — honest numbers and grounding", () => {
  test("score gains are exactly honestQuickWinGains of the same document", () => {
    const scan = makeScan([
      issue({ message: "First finding", checkKey: "f1" }),
      issue({ message: "Second finding", severity: "warning", priority: "important", checkKey: "f2" }),
    ]);
    const diag = buildDiagnosis(scan);
    const expected = honestQuickWinGains(scan, canonicalActionable(scan.issues));
    expect(diag.findings.length).toBe(expected.length);
    diag.findings.forEach((finding, index) => {
      expect(finding.scoreGain).toBe(expected[index]);
    });
  });

  test("impact text distinguishes score-bearing fixes from best-practice fixes", () => {
    expect(impactTextFor("critical", 4.2)).toContain("+4.2 overall score points");
    expect(impactTextFor("important", 0)).toContain("no direct effect on the numeric score");
  });

  test("causes are rule-based, evidence-backed, or honestly generic — never invented", () => {
    // Rule match on the message.
    expect(likelyCauseFor(issue({}))).toContain("Content-Security-Policy");
    // No rule → stage + verbatim recorded evidence.
    const unknown = issue({
      message: "Something never seen before",
      checkKey: "odd",
      stage: "html",
      evidence: 'alt="" missing on 3 images',
    });
    const cause = likelyCauseFor(unknown);
    expect(cause).toContain('alt="" missing on 3 images');
    expect(cause).toContain("html");
    // No rule, no evidence → explicit honesty about the missing detail.
    const bare = issue({ message: "Totally unknown check", checkKey: "x2", evidence: undefined, stage: undefined });
    expect(likelyCauseFor(bare)).toContain("does not record a more specific cause");
  });

  test("plain language and fixes come from the report's own saved text", () => {
    const scan = makeScan([issue({})]);
    const diag = buildDiagnosis(scan);
    expect(diag.findings[0].plainLanguage).toBe("Without CSP, browsers cannot block injected scripts.");
    expect(diag.findings[0].evidence).toBe("response did not include content-security-policy");
  });

  test("fix steps split howToFix; an empty howToFix yields no invented instructions", () => {
    expect(fixStepsFrom("Step one.\nStep two.")).toEqual(["Step one.", "Step two."]);
    expect(fixStepsFrom("")).toEqual([]);
    expect(fixStepsFrom("   ")).toEqual([]);
    const long = "First instruction here for the fix. ".repeat(10).trim();
    expect(long.length).toBeGreaterThan(240);
    expect(fixStepsFrom(long).length).toBeGreaterThan(1);
    const diag = buildDiagnosis(makeScan([issue({ howToFix: "" })]));
    expect(diag.findings[0].fixSteps).toEqual([]);
  });

  test("every finding anchors to its FixRecommendations card", () => {
    const scan = makeScan([
      issue({ message: "First finding", checkKey: "a1" }),
      issue({ message: "Second finding", severity: "warning", priority: "important", checkKey: "a2" }),
    ]);
    const diag = buildDiagnosis(scan);
    const anchors = anchorsFor(canonicalActionable(scan.issues));
    expect(diag.findings.length).toBeGreaterThan(0);
    for (const finding of diag.findings) {
      expect(finding.anchor).toBe(anchors.get(finding.key));
      expect(finding.anchor).toBeTruthy();
    }
  });
});

describe("Website Doctor wiring (source-pinned)", () => {
  test("panel mounts immediately after Fix These First, before FixRecommendations, screen-only", () => {
    const report = read("src/pages/Report.tsx");
    const fixFirst = report.indexOf('id="fix-these-first"');
    const doctor = report.indexOf("<WebsiteDoctor");
    const fixRec = report.indexOf("<FixRecommendations issues=");
    expect(fixFirst).toBeGreaterThan(-1);
    expect(doctor).toBeGreaterThan(fixFirst);
    expect(fixRec).toBeGreaterThan(doctor);
    // The mount sits inside a print:hidden wrapper — never in the PDF/print.
    expect(report.slice(doctor - 260, doctor)).toContain('className="print:hidden"');
    // Per-visitor quota identity travels with the request.
    expect(report).toContain("getVisitorId()");
  });

  test("action enforces quota first, fetches the scan server-side, and makes no external AI call", () => {
    const assistant = read("src/convex/aiAssistant.ts");
    const start = assistant.indexOf("export const explainFindings");
    expect(start).toBeGreaterThan(-1);
    const block = assistant.slice(start);
    expect(block).toContain("internal.rateLimit.consumeAiQuota");
    expect(block).toContain("api.scans.getScan");
    // Quota is consumed BEFORE any work happens.
    expect(block.indexOf("consumeAiQuota")).toBeLessThan(block.indexOf("api.scans.getScan"));
    // V1 is fallback-first: the handler body must contain no model/gateway call.
    expect(block).toContain("buildDiagnosis(scan)");
    expect(block).toContain('aiStatus: "unavailable"');
    expect(block).toContain("aiReason");
    for (const forbidden of [
      "vly.ai.completion",
      "vly-integrations",
      "createVlyIntegrations",
      "api.resend.com",
      "fetch(",
    ]) {
      expect(block).not.toContain(forbidden);
    }
  });

  test("the quota is 10 diagnoses per hour under the ai: namespace", () => {
    // Single source of truth for the limit: the pure shared module.
    expect(DIAGNOSIS_LIMIT_PER_HOUR).toBe(10);
    expect(DIAGNOSIS_WINDOW_MS).toBe(60 * 60 * 1000);
    const rateLimit = read("src/convex/rateLimit.ts");
    expect(rateLimit).toContain("AI_DIAGNOSIS_LIMIT = DIAGNOSIS_LIMIT_PER_HOUR");
    expect(rateLimit).toContain("AI_DIAGNOSIS_WINDOW_MS = DIAGNOSIS_WINDOW_MS");
    expect(rateLimit).toContain("export const consumeAiQuota");
    expect(rateLimit).toContain("key: `ai:${visitor}`");
    // Reuses the shared quota machinery — the retention cron covers these keys.
    expect(rateLimit).toContain("consumeQuota(ctx, {");
  });

  test("the panel reports an honest evidence-based status and never claims AI ran", () => {
    const doctor = read("src/components/WebsiteDoctor.tsx");
    expect(doctor).toContain("useAction(api.aiAssistant.explainFindings)");
    expect(doctor).toContain("Evidence-based · AI not enabled");
    expect(doctor).toContain("result.aiReason");
    expect(doctor).toContain("quotaExceeded");
    expect(doctor).toContain("print:hidden");
    // No AI-generated claim anywhere in the component.
    expect(doctor).not.toContain("AI-generated");
    // Server-side limit is surfaced to the user, sourced from the same pure
    // constant the server enforces (lib/aiDoctor → rateLimit → panel).
    expect(doctor).toContain('from "../lib/aiDoctor"');
    expect(doctor).toContain("DIAGNOSIS_LIMIT_PER_HOUR");
    expect(doctor).toContain("times per visitor per hour");
  });
});
