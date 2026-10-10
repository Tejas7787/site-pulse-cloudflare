// Fixtures for the PDF export tests — shaped exactly like saved scan documents
// returned by `scans.getScan` (structural subset consumed by buildScanPdf).

import type { PdfFinding, PdfScanInput, PdfSummary } from "../src/lib/pdfReport";

const SCANNED_AT = Date.UTC(2026, 9, 9, 14, 32, 5); // fixed for deterministic output

function finding(over: Partial<PdfFinding> & Pick<PdfFinding, "message">): PdfFinding {
  return {
    category: "Security",
    severity: "critical",
    priority: "critical",
    message: over.message,
    whyItMatters: over.whyItMatters ?? "Explains the risk this configuration exposes.",
    howToFix: over.howToFix ?? "Apply the recommended header or configuration change.",
    ...over,
  };
}

function summary(over: Partial<PdfSummary> = {}): PdfSummary {
  return {
    completeness: "complete",
    limitations: [
      "No browser engine was available: JavaScript-rendered DOM checks and lab metrics were not performed.",
      "Checks cover publicly accessible responses only.",
    ],
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    redirects: 0,
    redirectChain: [],
    contentType: "text/html; charset=UTF-8",
    durationMs: 341,
    method: "http",
    browserChecks: "No browser engine in this environment — browser checks are marked Unable to Verify, never guessed.",
    blocked: false,
    notHtml: false,
    incomplete: false,
    counts: { passed: 23, failed: 6, warnings: 5, notApplicable: 0, unverified: 2, total: 36 },
    categoryFormula: "score = round(100 × (passed + 0.5×warnings) ÷ applicable), excluding Unable to Verify and Not Applicable.",
    overallFormula: "Weighted sum over categories with a score: Security 30%, Performance 25%, SEO 25%, Technical Health 10%, Accessibility 10%.",
    performanceBasis: "HTTP response timing (server-side request) — not a browser lab test.",
    overallScored: true,
    ...over,
  };
}

function base(over: Partial<PdfScanInput> = {}): PdfScanInput {
  return {
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    redirects: 0,
    redirectChain: [],
    responseTime: 341,
    pageSizeFormatted: "48.2 KB",
    // Saved scores are self-consistent with the saved check counts below via
    // the documented formula (e.g. Performance: (4 + 0.5×1) ÷ 6 → 75), and the
    // saved overall 74 is exactly Security 67×.30 + Performance 75×.25 +
    // SEO 72×.25 + Technical Health 75×.10 + Accessibility 92×.10.
    score: 74,
    grade: "C",
    riskLevel: "medium",
    betterThanPercent: 62,
    performanceScore: 75,
    seoScore: 72,
    securityScore: 67,
    accessibilityScore: 92,
    technicalHealthScore: 75,
    performanceChecks: { score: 75, passed: 4, failed: 1, warnings: 1, notChecked: 0, applicable: 6, unverified: 0, notApplicable: 0, hasScore: true, formula: "score = round(100 × (4 + 0.5×1) ÷ 6)", factors: ["Response time 341ms"] },
    seoChecks: { score: 72, passed: 6, failed: 2, warnings: 1, notChecked: 1, applicable: 9, unverified: 1, notApplicable: 0, hasScore: true },
    securityChecks: { score: 67, passed: 5, failed: 2, warnings: 2, notChecked: 1, applicable: 9, unverified: 1, notApplicable: 0, hasScore: true, factors: ["Missing Content-Security-Policy", "HSTS present"] },
    accessibilityChecks: { score: 92, passed: 5, failed: 0, warnings: 1, notChecked: 0, applicable: 6, unverified: 0, notApplicable: 0, hasScore: true },
    technicalHealthChecks: { score: 75, passed: 3, failed: 1, warnings: 0, notChecked: 0, applicable: 4, unverified: 0, notApplicable: 0, hasScore: true },
    issues: [],
    quickWins: [
      { category: "SEO", message: "Add a meta description to the home page", potentialGain: 4, priority: "important" },
      { category: "Security", message: "Enable HSTS on the apex domain", potentialGain: 3, priority: "recommended" },
    ],
    totalChecksCompleted: 36,
    totalPassed: 23,
    totalFailed: 6,
    totalWarnings: 5,
    totalUnverified: 2,
    totalNotApplicable: 0,
    overallScored: true,
    summary: summary(),
    scannedAt: SCANNED_AT,
    ...over,
  } as PdfScanInput;
}

/** Normal, complete scan with a mix of confirmed / potential / unverified findings. */
export function normalScan(): PdfScanInput {
  return base({
    issues: [
      finding({
        message: "Content-Security-Policy header is missing",
        category: "Security", severity: "critical", priority: "critical",
        evidence: "Response header Content-Security-Policy was not present on https://example.com/ (stage: headers).",
        evidenceUrl: "https://example.com/", method: "http", stage: "headers", checkKey: "csp", detectedAt: SCANNED_AT, confirmed: true, status: "fail",
      }),
      finding({
        message: "Strict-Transport-Security max-age is too short",
        category: "Security", severity: "warning", priority: "important",
        whyItMatters: "A short max-age allows SSL stripping between visits.",
        evidence: "Strict-Transport-Security: max-age=300",
        evidenceUrl: "https://example.com/", method: "http", stage: "headers", checkKey: "hsts", detectedAt: SCANNED_AT, confirmed: true, status: "warning",
      }),
      finding({
        message: "Meta description is missing",
        category: "SEO", severity: "warning", priority: "recommended",
        evidence: "<meta name=\"description\"> not found in the document head.",
        evidenceUrl: "https://example.com/", method: "http", stage: "html", checkKey: "meta-description", detectedAt: SCANNED_AT, confirmed: true, status: "fail",
        howToFix: "",
      }),
      finding({
        message: "Images without alt text detected",
        category: "Accessibility", severity: "warning", priority: "important",
        evidence: "3 of 12 <img> elements have no alt attribute.",
        evidenceUrl: "https://example.com/", method: "http", stage: "html", checkKey: "img-alt", detectedAt: SCANNED_AT, confirmed: true, status: "fail",
      }),
      finding({
        message: "Server may leak framework version",
        category: "Technical Health", severity: "info", priority: "nice-to-have",
        whyItMatters: "Version banners help attackers pick known exploits.",
        evidence: "Server header observed: nginx/1.24.0",
        evidenceUrl: "https://example.com/", method: "http", stage: "headers", checkKey: "server-banner", detectedAt: SCANNED_AT, confirmed: true, status: "warning",
      }),
      finding({
        message: "Mixed content may be present on the home page",
        category: "Security", severity: "warning", priority: "important",
        whyItMatters: "Inferred from an http:// script reference in the HTML; not fetched in this scan.",
        evidence: "HTML contains script src=\"http://cdn.example.net/app.js\".",
        evidenceUrl: "https://example.com/", method: "http", stage: "html", checkKey: "mixed-content", detectedAt: SCANNED_AT, confirmed: false, status: "warning",
        howToFix: "Serve the script over https:// or use a protocol-relative URL.",
      }),
      finding({
        message: "JavaScript-rendered heading structure could not be checked",
        category: "Accessibility", severity: "info", priority: "recommended",
        whyItMatters: "Client-rendered headings were not observed by the HTTP scan.",
        evidence: "No browser engine available for this scan.",
        method: "browser", stage: "html", checkKey: "heading-structure", detectedAt: SCANNED_AT, confirmed: false, status: "unable-to-verify",
        howToFix: "",
      }),
    ],
    topIssues: [],
  });
}

/** Blocked scan: HTTP 429, everything content-derived is Unable to Verify. */
export function blocked429Scan(): PdfScanInput {
  return base({
    url: "https://rate-limited.example.org/",
    finalUrl: "https://rate-limited.example.org/",
    status: 429,
    score: 0,
    grade: "",
    riskLevel: undefined,
    betterThanPercent: undefined,
    performanceScore: 0, seoScore: 0, securityScore: 0, accessibilityScore: 0, technicalHealthScore: 0,
    performanceChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 3, hasScore: false },
    seoChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 9, hasScore: false },
    securityChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 8, hasScore: false },
    accessibilityChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 6, hasScore: false },
    technicalHealthChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 4, hasScore: false },
    quickWins: [],
    totalChecksCompleted: 30, totalPassed: 0, totalFailed: 0, totalWarnings: 0, totalUnverified: 30, totalNotApplicable: 0,
    overallScored: false,
    summary: summary({
      completeness: "blocked",
      blocked: true,
      blockReason: "HTTP 429 Too Many Requests — the target rate-limited the scan request.",
      requestedUrl: "https://rate-limited.example.org/",
      finalUrl: "https://rate-limited.example.org/",
      status: 429,
      contentType: "text/html",
      counts: { passed: 0, failed: 0, warnings: 0, notApplicable: 0, unverified: 30, total: 30 },
      limitations: [
        "The scan was blocked (HTTP 429): content, header and cookie checks could not be verified.",
        "No browser engine was available for this scan.",
      ],
    }),
    issues: [
      finding({
        message: "Scan blocked — header checks could not be verified",
        category: "Security", severity: "info", priority: "recommended",
        whyItMatters: "A blocked scan produces no evidence; nothing here is a confirmed failure.",
        evidence: "HTTP 429 Too Many Requests returned for the scan request.",
        evidenceUrl: "https://rate-limited.example.org/", method: "http", stage: "fetch", checkKey: "headers-present", detectedAt: SCANNED_AT, confirmed: false, status: "unable-to-verify",
        howToFix: "",
      }),
    ],
    topIssues: [],
  });
}

/** Partial scan: 404 response, page content checks unverified. */
export function notFound404Scan(): PdfScanInput {
  return base({
    url: "https://example.com/missing-page",
    finalUrl: "https://example.com/missing-page",
    status: 404,
    // Partial scan: content-derived categories (SEO, accessibility) have no
    // verified checks and are excluded; overall 41 = (50×.25 + 40×.30 + 20×.10)
    // ÷ (.25 + .30 + .10) over the three remaining categories.
    score: 41,
    grade: "F",
    overallScored: true,
    performanceScore: 50,
    seoScore: 0,
    securityScore: 40,
    accessibilityScore: 0,
    technicalHealthScore: 20,
    performanceChecks: { score: 50, passed: 1, failed: 1, warnings: 0, notChecked: 1, unverified: 1, hasScore: true },
    seoChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 12, unverified: 12, hasScore: false },
    securityChecks: { score: 40, passed: 2, failed: 3, warnings: 0, notChecked: 1, unverified: 1, hasScore: true },
    accessibilityChecks: { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 6, unverified: 6, hasScore: false },
    technicalHealthChecks: { score: 20, passed: 1, failed: 4, warnings: 0, notChecked: 0, hasScore: true },
    summary: summary({
      completeness: "partial",
      requestedUrl: "https://example.com/missing-page",
      finalUrl: "https://example.com/missing-page",
      status: 404,
      counts: { passed: 4, failed: 8, warnings: 0, notApplicable: 4, unverified: 20, total: 36 },
      limitations: [
        "The target returned HTTP 404: page-content checks (SEO, accessibility) are marked Unable to Verify.",
      ],
    }),
    totalChecksCompleted: 12, totalPassed: 4, totalFailed: 8, totalWarnings: 0, totalUnverified: 20, totalNotApplicable: 4,
    issues: [
      finding({
        message: "Target returned HTTP 404 Not Found",
        category: "Technical Health", severity: "critical", priority: "critical",
        evidence: "Final response status was 404 for https://example.com/missing-page.",
        evidenceUrl: "https://example.com/missing-page", method: "http", stage: "fetch", checkKey: "http-status", detectedAt: SCANNED_AT, confirmed: true, status: "fail",
      }),
      finding({
        message: "Meta description could not be verified on an error page",
        category: "SEO", severity: "info", priority: "recommended",
        evidence: "HTTP 404 body is a soft-error page; content checks skipped.",
        method: "http", stage: "html", checkKey: "meta-description", detectedAt: SCANNED_AT, confirmed: false, status: "unable-to-verify",
        howToFix: "",
      }),
    ],
    topIssues: [],
  });
}

/** Very long URLs and a multi-hop redirect chain. */
export function longUrlScan(): PdfScanInput {
  const q = Array.from({ length: 40 }, (_, i) => `param${i}=value${i}abcdef`).join("&");
  const requested = `https://very-long-subdomain.example-company.co.uk/landing/section/subsection/page?campaign=spring-launch-2026&utm_source=newsletter&utm_medium=email&${q}`;
  const hop1 = "https://very-long-subdomain.example-company.co.uk/old-path/that/is/also/quite/long/indeed/for/a/redirect";
  const hop2 = `https://example-company.co.uk/forward/again/with/query?next=${encodeURIComponent(requested)}`;
  const finalUrl = `https://www.example-company.co.uk/new-home?ref=redirect-chain&${q}`;
  return base({
    url: requested,
    finalUrl,
    redirects: 2,
    redirectChain: [hop1, hop2],
    summary: summary({
      requestedUrl: requested,
      finalUrl,
      status: 200,
      redirects: 2,
      redirectChain: [hop1, hop2],
    }),
    issues: [
      finding({
        message: "Redirect chain is longer than recommended",
        category: "Technical Health", severity: "warning", priority: "recommended",
        evidence: `Chain: ${requested} -> ${hop1} -> ${hop2} -> ${finalUrl}`,
        evidenceUrl: finalUrl, method: "http", stage: "fetch", checkKey: "redirects", detectedAt: SCANNED_AT, confirmed: true, status: "warning",
      }),
    ],
    topIssues: [],
  });
}

/** Many findings → multi-page document. */
export function manyFindingsScan(n = 80): PdfScanInput {
  const issues: PdfFinding[] = Array.from({ length: n }, (_, i) =>
    finding({
      message: `Finding number ${i + 1}: issue token-${i + 1} needs attention`,
      category: ["Security", "SEO", "Accessibility", "Performance", "Technical Health"][i % 5],
      severity: (["critical", "warning", "info"] as const)[i % 3],
      priority: (["critical", "important", "recommended", "nice-to-have"] as const)[i % 4],
      evidence: `Observed evidence for token-${i + 1} at stage html on https://example.com/.`,
      evidenceUrl: "https://example.com/",
      method: "http" as const,
      stage: "html",
      checkKey: `check-${i + 1}`,
      detectedAt: SCANNED_AT,
      confirmed: i % 7 !== 3,
      status: i % 11 === 5 ? ("unable-to-verify" as const) : ("fail" as const),
      whyItMatters: `Token-${i + 1} affects user-visible quality and score.`,
      howToFix: i % 2 === 0 ? `Fix for token-${i + 1}: update the configuration flagged above.` : "",
    }),
  );
  return base({ issues, topIssues: [], quickWins: [] });
}

/** Zero findings (a perfect scan: every saved check passed). */
export function zeroFindingsScan(): PdfScanInput {
  return base({
    score: 100,
    grade: "A",
    riskLevel: "low",
    betterThanPercent: 94,
    performanceScore: 100, seoScore: 100, securityScore: 100,
    accessibilityScore: 100, technicalHealthScore: 100,
    performanceChecks: { score: 100, passed: 6, failed: 0, warnings: 0, notChecked: 0, applicable: 6, unverified: 0, notApplicable: 0, hasScore: true },
    seoChecks: { score: 100, passed: 9, failed: 0, warnings: 0, notChecked: 0, applicable: 9, unverified: 0, notApplicable: 0, hasScore: true },
    securityChecks: { score: 100, passed: 8, failed: 0, warnings: 0, notChecked: 0, applicable: 8, unverified: 0, notApplicable: 0, hasScore: true },
    accessibilityChecks: { score: 100, passed: 6, failed: 0, warnings: 0, notChecked: 0, applicable: 6, unverified: 0, notApplicable: 0, hasScore: true },
    technicalHealthChecks: { score: 100, passed: 5, failed: 0, warnings: 0, notChecked: 0, applicable: 5, unverified: 0, notApplicable: 0, hasScore: true },
    issues: [],
    topIssues: [],
    quickWins: [],
    totalChecksCompleted: 34, totalPassed: 34, totalFailed: 0, totalWarnings: 0, totalUnverified: 0, totalNotApplicable: 0,
    summary: summary({
      counts: { passed: 34, failed: 0, warnings: 0, notApplicable: 0, unverified: 0, total: 34 },
    }),
  });
}

/** Legacy report saved before evidence tracking: no summary, no evidence, sparse checks. */
export function legacyScan(): PdfScanInput {
  return base({
    url: "http://legacy.example.net/",
    finalUrl: "http://legacy.example.net/",
    status: 200,
    score: 71,
    grade: "C",
    summary: undefined,
    overallScored: undefined,
    performanceChecks: { score: 70, passed: 3, failed: 1, warnings: 1, notChecked: 1 },
    seoChecks: { score: 65, passed: 4, failed: 2, warnings: 1, notChecked: 2 },
    securityChecks: { score: 60, passed: 3, failed: 3, warnings: 1, notChecked: 2 },
    accessibilityChecks: { score: 80, passed: 4, failed: 1, warnings: 0, notChecked: 1 },
    technicalHealthChecks: { score: 75, passed: 3, failed: 1, warnings: 0, notChecked: 1 },
    redirectChain: undefined,
    quickWins: undefined,
    totalChecksCompleted: 30, totalPassed: 17, totalFailed: 8, totalWarnings: 3,
    totalUnverified: undefined, totalNotApplicable: undefined,
    issues: [
      {
        category: "Security",
        severity: "critical",
        priority: "critical",
        message: "Legacy finding without evidence fields",
        whyItMatters: "Saved before evidence tracking was added.",
        howToFix: "Re-run a scan to collect evidence for this finding.",
      },
    ],
    topIssues: undefined,
  });
}

/**
 * Regression fixture for the PDF/report score mismatch: the saved overall
 * score and grade (67 / C) disagree with what the document's own saved check
 * counts recompute to under the printed weights (64 / D). Both renderers must
 * show the derived 64 and never the stale saved 67.
 */
export function staleOverallScan(): PdfScanInput {
  return base({
    score: 67,
    grade: "C",
    performanceScore: 67,
    seoScore: 41,
    securityScore: 79,
    accessibilityScore: 67,
    technicalHealthScore: 67,
    performanceChecks: { score: 67, passed: 2, failed: 1, warnings: 0, notChecked: 0, unverified: 0, notApplicable: 0, hasScore: true },
    seoChecks: { score: 41, passed: 7, failed: 10, warnings: 0, notChecked: 0, unverified: 0, notApplicable: 0, hasScore: true },
    securityChecks: { score: 79, passed: 11, failed: 3, warnings: 0, notChecked: 0, unverified: 0, notApplicable: 0, hasScore: true },
    accessibilityChecks: { score: 67, passed: 2, failed: 1, warnings: 0, notChecked: 0, unverified: 0, notApplicable: 0, hasScore: true },
    technicalHealthChecks: { score: 67, passed: 2, failed: 1, warnings: 0, notChecked: 0, unverified: 0, notApplicable: 0, hasScore: true },
    totalChecksCompleted: 37, totalPassed: 24, totalFailed: 16, totalWarnings: 0, totalUnverified: 0, totalNotApplicable: 0,
    summary: summary({
      counts: { passed: 24, failed: 16, warnings: 0, notApplicable: 0, unverified: 2, total: 42 },
    }),
    issues: [],
    topIssues: [],
    quickWins: [],
  });
}

/** Cookie inventory + credential-looking evidence — must be redacted in the PDF. */
export function sensitiveScan(): PdfScanInput {
  return base({
    url: "https://app.example.com/",
    finalUrl: "https://app.example.com/",
    summary: summary({
      requestedUrl: "https://app.example.com/",
      finalUrl: "https://app.example.com/",
    }),
    cookies: [
      { name: "session_secret", domain: "example.com" },
      { name: "__csrf", domain: null },
    ],
    issues: [
      finding({
        message: "Cookie is missing security attributes",
        category: "Security", severity: "warning", priority: "important",
        evidence: 'Set-Cookie observed on https://app.example.com: "session_secret" has no Secure attribute (first-party cookie, Domain=example.com).',
        evidenceUrl: "https://app.example.com/", method: "http", stage: "cookies", checkKey: "cookie-flags", detectedAt: SCANNED_AT, confirmed: true, status: "warning",
      }),
      finding({
        message: "Request evidence contained an authorization value",
        category: "Security", severity: "info", priority: "nice-to-have",
        evidence: "Authorization: Bearer sk-live-abc123456789 was echoed by the error page.",
        evidenceUrl: "https://app.example.com/", method: "http", stage: "headers", checkKey: "auth-echo", detectedAt: SCANNED_AT, confirmed: true, status: "fail",
      }),
    ],
    topIssues: [],
  });
}
