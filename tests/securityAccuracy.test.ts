// Security accuracy — a missing header is an observed configuration gap.
// These tests lock in that SitePulse never presents "no CSP/HSTS" as a
// confirmed XSS (or SSL-stripping) vulnerability, while still scoring the
// absent control and keeping the evidence and recommendation separate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { findingProblem, makeFinding } from "../src/lib/findings";

const scanSource = readFileSync(
  join(import.meta.dir, "..", "src", "convex", "scan.ts"),
  "utf8",
);

/** The exact call site that emits missing-header findings. */
function headerIssueBlock(): string {
  const start = scanSource.indexOf("for (const { key, header } of headerIssues)");
  const end = scanSource.indexOf("ACCESSIBILITY — evidence-based checks", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return scanSource.slice(start, end);
}

describe("missing security headers", () => {
  test("are hardening recommendations, never confirmed vulnerabilities", () => {
    const block = headerIssueBlock();
    expect(block).toContain('status: "warning"');
    expect(block).toContain("confirmed: false");
    // A missing header must not be recorded as a confirmed failure.
    expect(block).not.toContain('status: "fail"');
    expect(block).not.toContain("confirmed: true");
  });

  test("CSP is no longer treated as a critical finding", () => {
    const block = headerIssueBlock();
    expect(block).not.toContain('header.key === "csp" ? "critical"');
    // CSP and HSTS stay the most consequential headers, at "important".
    expect(block).toContain('header.key === "csp" || header.key === "hsts"');
    expect(block).toContain('"important"');
  });

  test("the CSP text does not claim an XSS vulnerability was found", () => {
    const block = headerIssueBlock();
    expect(scanSource).not.toContain("your site is vulnerable to Cross-Site Scripting");
    expect(block).toContain("did not find an exploitable XSS vulnerability");
    expect(block).toContain("does not prove one exists");
    // and it always states what the finding does *not* mean
    expect(block).toContain("What this does not mean");
  });

  test("the HSTS text does not claim an SSL-stripping vulnerability", () => {
    const block = headerIssueBlock();
    expect(block).toContain("did not test for an active SSL-stripping attack");
    expect(block).toContain("no vulnerability is being claimed");
  });

  test("observed evidence, recommendation and limitation are separate fields", () => {
    const block = headerIssueBlock();
    // evidence = the observation (header absent on this URL/status)
    expect(block).toContain(
      "was not present in the response headers of ${finalUrl} (HTTP ${status}).",
    );
    // recommendation = the fix text, kept in its own argument
    expect(block).toContain("e.fix,");
    // limitation = spelled out in the explanation, not folded into the evidence
    expect(block).toContain("only observed that the header was missing");
  });

  test("the absent control still fails its check, so scoring is unchanged", () => {
    // The measurement keeps reflecting the missing header; only the claim
    // about vulnerability changed.
    expect(scanSource).toContain(
      'securityChecks[`header-${sh.key}`] = present ? "pass" : "fail";',
    );
  });

  test("finding validation stays consistent for these recommendations", () => {
    // Same parameters the scan passes to makeFinding for a missing CSP.
    const issue = makeFinding({
      category: "Security",
      severity: "warning",
      priority: "important",
      message: "Missing Content-Security-Policy header.",
      whyItMatters: "A CSP is the main defence in depth against XSS.",
      howToFix: "Add a Content-Security-Policy header.",
      checkKey: "header-csp",
      stage: "headers",
      status: "warning",
      confirmed: false,
      evidence:
        "Content-Security-Policy was not present in the response headers of https://example.com/ (HTTP 200).",
    });
    expect(issue.confirmed).toBe(false);
    expect(issue.status).toBe("warning");
    expect(issue.severity).toBe("warning");
    expect(findingProblem(issue)).toBeNull();
  });

  test("a real confirmed failure is still possible — nothing was weakened", () => {
    const issue = makeFinding({
      category: "Security",
      severity: "critical",
      priority: "critical",
      message: "The site does not use HTTPS.",
      whyItMatters: "Traffic is readable and tamperable in transit.",
      howToFix: "Serve the site over HTTPS and redirect plain HTTP.",
      checkKey: "https",
      stage: "fetch",
      status: "fail",
      evidence: "Requested http://example.com/ and stayed on http:// (HTTP 200).",
    });
    expect(issue.confirmed).toBe(true);
    expect(issue.status).toBe("fail");
    expect(findingProblem(issue)).toBeNull();
  });
});
