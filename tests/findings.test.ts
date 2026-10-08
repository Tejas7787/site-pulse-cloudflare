import { describe, expect, test } from "bun:test";
import { findingProblem, makeFinding } from "../src/lib/findings";

describe("makeFinding — no evidence, no confirmed failure", () => {
  test("finding with evidence is confirmed and carries method/stage/time/url", () => {
    const issue = makeFinding({
      category: "Security",
      severity: "critical",
      priority: "critical",
      message: "Missing Content-Security-Policy header.",
      whyItMatters: "Weakens XSS defences.",
      howToFix: "Add a CSP header.",
      evidence: "Content-Security-Policy was not present in the response headers of https://a.test/ (HTTP 200).",
      evidenceUrl: "https://a.test/",
      stage: "headers",
      checkKey: "header-csp",
      detectedAt: 1_700_000_000_000,
    });
    expect(issue.confirmed).toBe(true);
    expect(issue.status).toBe("fail");
    expect(issue.method).toBe("http");
    expect(issue.stage).toBe("headers");
    expect(issue.detectedAt).toBe(1_700_000_000_000);
    expect(findingProblem(issue)).toBeNull();
  });

  test("REGRESSION: a finding with no evidence can never be confirmed", () => {
    const issue = makeFinding({
      category: "SEO",
      severity: "critical",
      priority: "critical",
      message: "Something looks wrong.",
      whyItMatters: "Because.",
      evidence: "   ",
    });
    expect(issue.confirmed).toBe(false);
    expect(issue.evidence).toContain("No direct evidence");
    expect(findingProblem(issue)).toBe("cannot fail without evidence");
  });

  test("fix is optional and empty when evidence does not support one", () => {
    const issue = makeFinding({
      category: "Security",
      severity: "info",
      priority: "nice-to-have",
      message: "Could not verify SSL certificate.",
      whyItMatters: "No conclusion drawn.",
      evidence: "TLS handshake failed: timeout",
      status: "unable-to-verify",
      confirmed: false,
    });
    expect(issue.howToFix).toBe("");
    expect(findingProblem(issue)).toBeNull();
  });

  test("stage defaults from the category when not provided", () => {
    const issue = makeFinding({
      category: "Accessibility",
      severity: "warning",
      priority: "recommended",
      message: "2 images missing alt text.",
      whyItMatters: "Screen readers need alt text.",
      evidence: "2 <img> elements have no alt attribute.",
    });
    expect(issue.stage).toBe("html");
  });
});

describe("findingProblem — validation", () => {
  test("detects a failure that is not confirmed", () => {
    const problem = findingProblem({
      category: "Security",
      severity: "critical",
      priority: "critical",
      message: "m",
      whyItMatters: "w",
      howToFix: "",
      evidence: "observed",
      method: "http",
      stage: "headers",
      status: "fail",
      confirmed: false,
    });
    expect(problem).toBe("a failure must be confirmed by evidence");
  });

  test("detects confirmed + unable-to-verify contradiction", () => {
    const problem = findingProblem({
      category: "Security",
      severity: "warning",
      priority: "important",
      message: "m",
      whyItMatters: "w",
      howToFix: "",
      evidence: "observed",
      method: "http",
      stage: "headers",
      status: "unable-to-verify",
      confirmed: true,
    });
    expect(problem).toBe("cannot be confirmed and unverified at once");
  });

  test("detects missing method", () => {
    const problem = findingProblem({
      category: "Security",
      severity: "warning",
      priority: "important",
      message: "m",
      whyItMatters: "w",
      howToFix: "",
      evidence: "observed",
      stage: "headers",
      status: "warning",
    });
    expect(problem).toBe("missing detection method");
  });

  test("detects missing evidence entirely", () => {
    const problem = findingProblem({
      category: "SEO",
      severity: "warning",
      priority: "recommended",
      message: "m",
      whyItMatters: "w",
      howToFix: "",
      method: "http",
      stage: "html",
      status: "warning",
    });
    expect(problem).toBe("missing evidence");
  });
});
