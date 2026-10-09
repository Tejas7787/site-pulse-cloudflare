// PDF export tests — build PDFs from saved-scan fixtures and verify the
// rendered document: content matches the saved data exactly, pagination works,
// links exist, and sensitive data is absent.

import { describe, expect, test } from "bun:test";
import { buildScanPdf, type PdfScanInput } from "../src/lib/pdfReport";
import { countOccurrences, countUriAnnotations, extractPdfText, flatten, normalize } from "./pdfExtract";
import {
  blocked429Scan,
  legacyScan,
  longUrlScan,
  manyFindingsScan,
  normalScan,
  notFound404Scan,
  sensitiveScan,
  zeroFindingsScan,
} from "./pdfFixtures";

const GENERATED_AT = Date.UTC(2026, 9, 9, 12, 0, 0);

function build(scan: PdfScanInput, opts: Record<string, unknown> = {}) {
  const result = buildScanPdf(scan, { generatedAt: GENERATED_AT, ...opts });
  const text = extractPdfText(result.bytes);
  return { ...result, text, norm: normalize(text), flat: flatten(text) };
}

describe("PDF export — normal scan", () => {
  const scan = normalScan();
  const pdf = build(scan, { reportUrl: "https://app.sitepulse.test/report/abc123", scanId: "abc123" });

  test("produces a valid, multi-purpose branded document", () => {
    expect(pdf.bytes.byteLength).toBeGreaterThan(3000);
    expect(pdf.bytes[0]).toBe(0x25); // "%PDF"
    expect(pdf.pageCount).toBeGreaterThanOrEqual(1);
    expect(pdf.fileName).toBe("sitepulse-report-example.com-2026-10-09.pdf");
    expect(pdf.norm).toContain("SitePulse");
    expect(pdf.norm).toContain("WEBSITE HEALTH REPORT");
    expect(pdf.norm).toContain("Report generated");
    expect(pdf.norm).toContain("Scan performed");
    expect(pdf.text).toContain("SitePulse \u00b7 Website Health Report"); // page furniture (page >= 2) when multipage
  });

  test("renders target details from the saved summary, with clickable links", () => {
    expect(pdf.norm).toContain("REQUESTED URL https://example.com/");
    expect(pdf.flat).toContain(flatten("https://example.com/"));
    expect(pdf.norm).toContain("HTTP 200");
    expect(pdf.norm).toContain("SCAN COMPLETENESS Complete");
    expect(pdf.norm).toContain("HTTP (server-side request)");
    expect(pdf.norm).toContain("text/html; charset=UTF-8 \u00b7 341 ms");
    expect(pdf.norm).toContain("View the interactive report:");
    expect(pdf.norm).toContain("https://app.sitepulse.test/report/abc123");
    expect(countUriAnnotations(pdf.bytes)).toBeGreaterThan(0);
  });

  test("renders overall and category scores with the existing methodology", () => {
    expect(pdf.norm).toContain("OVERALL HEALTH SCORE");
    expect(pdf.norm).toContain("78/100");
    expect(pdf.norm).toContain("GRADE C");
    expect(pdf.norm).toContain("MEDIUM RISK");
    expect(pdf.norm).toContain("Category Scores");
    for (const cat of ["Performance", "SEO", "Security", "Accessibility", "Technical Health"]) {
      expect(pdf.norm).toContain(cat);
    }
    expect(pdf.norm).toContain("30%"); // security weight shown
    expect(pdf.norm).toContain("Weighted sum over categories with a score: Security 30%, Performance 25%, SEO 25%, Technical Health 10%, Accessibility 10%.");
    expect(pdf.norm).toContain("score = round(100 \u00d7 (4 + 0.5\u00d71) \u00f7 6)"); // per-category formula from saved checks
  });

  test("renders the five check-state counts exactly as saved", () => {
    const c = scan.summary!.counts;
    expect(pdf.norm).toContain(`PASSED ${c.passed}`);
    expect(pdf.norm).toContain(`FAILED ${c.failed}`);
    expect(pdf.norm).toContain(`WARNINGS ${c.warnings}`);
    expect(pdf.norm).toContain(`NOT APPLICABLE ${c.notApplicable}`);
    expect(pdf.norm).toContain(`UNABLE TO VERIFY ${c.unverified}`);
    expect(pdf.norm).toContain(`TOTAL CHECKS ${c.total}`);
    expect(pdf.norm).toContain("Unable to Verify and Not Applicable never count as failures");
  });

  test("renders every saved finding with severity, status, evidence, method and URL", () => {
    expect(pdf.norm).toContain(`Findings (${scan.issues.length})`);
    for (const issue of scan.issues) {
      expect(pdf.norm).toContain(issue.message);
      if (issue.evidence) expect(pdf.flat).toContain(flatten(issue.evidence));
    }
    // Confirmed vs potential are distinguished, unverified is never confirmed.
    expect(pdf.norm).toContain("5 CONFIRMED");
    expect(pdf.norm).toContain("2 POTENTIAL");
    expect(pdf.norm).toContain("OF WHICH 1 UNABLE TO VERIFY");
    expect(pdf.text).toContain("UNABLE TO VERIFY"); // trust chip exists
    expect(pdf.norm).toContain("Confirmed = directly observed evidence.");
    expect(pdf.norm).toContain("AFFECTED URL");
    expect(pdf.norm).toContain("EVIDENCE");
    expect(pdf.norm).toContain("Method: HTTP \u00b7 Stage: headers");
    expect(pdf.norm).toContain("WHY IT MATTERS");
    // Fix only where supported: f3 has howToFix === ""
    expect(pdf.norm).toContain("RECOMMENDED FIX");
    const fixCount = countOccurrences(pdf.text, "RECOMMENDED FIX");
    expect(fixCount).toBe(scan.issues.filter((i) => i.howToFix.length > 0).length);
  });

  test("renders a prioritized action plan ordered critical-first", () => {
    expect(pdf.norm).toContain("Prioritized Action Plan");
    expect(pdf.norm).toContain("1. CRITICAL");
    // saved order for this fixture: 1 critical, 2 important, 5 recommended, 7 nice-to-have
    expect(pdf.norm.indexOf("1. CRITICAL")).toBeLessThan(pdf.norm.indexOf("2. IMPORTANT"));
    expect(pdf.norm.indexOf("2. IMPORTANT")).toBeLessThan(pdf.norm.indexOf("5. RECOMMENDED"));
    expect(pdf.norm.indexOf("5. RECOMMENDED")).toBeLessThan(pdf.norm.indexOf("7. NICE TO HAVE"));
    expect(pdf.norm).toContain("Quick wins (low effort, score gain)");
    expect(pdf.norm).toContain("+4 PTS POTENTIAL");
  });

  test("renders methodology, limitations and the security disclaimer", () => {
    expect(pdf.norm).toContain("Methodology, Limitations & Disclaimer");
    expect(pdf.norm).toContain("How this scan works");
    expect(pdf.norm).toContain("Scoring methodology");
    expect(pdf.norm).toContain("Performance basis: HTTP response timing (server-side request)");
    expect(pdf.norm).toContain("No browser engine was available: JavaScript-rendered DOM checks and lab metrics were not performed.");
    expect(pdf.norm).toContain("An HTTP scan cannot prove a website is completely secure.");
    expect(pdf.norm).toContain("IMPORTANT \u2014 SECURITY DISCLAIMER");
    expect(pdf.norm).toContain("an unverified check is never a confirmed failure");
    expect(pdf.norm).toContain("Privacy: this PDF contains no cookies, authentication tokens, API keys, private credentials or request headers");
    expect(pdf.norm).toContain("Scan ID: abc123");
  });
});

describe("PDF export — blocked 429 scan", () => {
  const scan = blocked429Scan();
  const pdf = build(scan);

  test("reports the block honestly and never as failures", () => {
    expect(pdf.norm).toContain("SCAN BLOCKED");
    expect(pdf.norm).toContain("HTTP 429 Too Many Requests \u2014 the target rate-limited the scan request.");
    expect(pdf.norm).toContain("HTTP 429");
    expect(pdf.norm).toContain("SCAN COMPLETENESS Blocked");
    expect(pdf.norm).toContain("PASSED 0");
    expect(pdf.norm).toContain("FAILED 0");
    expect(pdf.norm).toContain("UNABLE TO VERIFY 30");
    expect(pdf.norm).toContain("UNABLE TO VERIFY"); // per-finding trust chip
    expect(pdf.norm).toContain("Scan blocked \u2014 header checks could not be verified");
    expect(pdf.norm).toContain("are reported as Unable to Verify \u2014 never as failures");
    // No fabricated overall score
    expect(pdf.norm).toContain("Not enough verified checks to produce a score \u2014 no data, no score.");
    // score band shows a dash, never a fabricated numeric score
    expect(pdf.norm).toContain("OVERALL HEALTH SCORE \u2014");
    expect(pdf.norm).toContain("cannot prove a website is completely secure");
  });

  test("counts match the saved blocked summary exactly", () => {
    const c = scan.summary!.counts;
    expect(pdf.norm).toContain(`PASSED ${c.passed}`);
    expect(pdf.norm).toContain(`FAILED ${c.failed}`);
    expect(pdf.norm).toContain(`WARNINGS ${c.warnings}`);
    expect(pdf.norm).toContain(`NOT APPLICABLE ${c.notApplicable}`);
    expect(pdf.norm).toContain(`UNABLE TO VERIFY ${c.unverified}`);
    expect(pdf.norm).toContain(`TOTAL CHECKS ${c.total}`);
  });
});

describe("PDF export — partial 404 scan", () => {
  const scan = notFound404Scan();
  const pdf = build(scan);

  test("renders partial completeness and 404 status from saved data", () => {
    expect(pdf.norm).toContain("PARTIAL SCAN");
    expect(pdf.norm).toContain("HTTP 404");
    expect(pdf.norm).toContain("SCAN COMPLETENESS Partial");
    expect(pdf.norm).toContain("Target returned HTTP 404 Not Found");
    expect(pdf.norm).toContain("Meta description could not be verified on an error page");
    expect(pdf.norm).toContain("are marked Unable to Verify");
    const c = scan.summary!.counts;
    expect(pdf.norm).toContain(`PASSED ${c.passed}`);
    expect(pdf.norm).toContain(`FAILED ${c.failed}`);
    expect(pdf.norm).toContain(`UNABLE TO VERIFY ${c.unverified}`);
    expect(pdf.norm).toContain(`NOT APPLICABLE ${c.notApplicable}`);
  });
});

describe("PDF export — long URLs", () => {
  const scan = longUrlScan();
  const pdf = build(scan);

  test("long URLs are fully present (wrapped, never clipped) and linked", () => {
    const raw = new TextDecoder("latin1").decode(pdf.bytes);
    expect(pdf.flat).toContain(flatten(scan.url));
    expect(pdf.flat).toContain(flatten(scan.finalUrl));
    for (const hop of scan.redirectChain ?? []) expect(pdf.flat).toContain(flatten(hop));
    // Link annotation stores the complete URL as one unbroken string
    expect(raw).toContain(scan.finalUrl);
    expect(pdf.norm).toContain("REDIRECT CHAIN");
    expect(pdf.norm).toContain("1. https://very-long-subdomain.example-company.co.uk/old-path/that/is/also/quite/long/indeed/for/a/redirect");
    expect(pdf.norm).toContain("2 redirects");
    expect(countUriAnnotations(pdf.bytes)).toBeGreaterThanOrEqual(3);
  });
});

describe("PDF export — many findings (pagination)", () => {
  const total = 80;
  const scan = manyFindingsScan(total);
  const pdf = build(scan);

  test("spans multiple pages with a footer page number on every page", () => {
    expect(pdf.pageCount).toBeGreaterThan(3);
    expect(countOccurrences(pdf.text, "Page ")).toBe(pdf.pageCount);
    expect(pdf.norm).toContain(`Page 1 of ${pdf.pageCount}`);
    expect(pdf.norm).toContain(`Page ${pdf.pageCount} of ${pdf.pageCount}`);
    // running header on pages >= 2
    expect(pdf.text).toContain("SitePulse \u00b7 Website Health Report");
  });

  test("renders every saved finding exactly once", () => {
    expect(pdf.norm).toContain(`Findings (${total})`);
    const cardNumbers = pdf.text.split("\n").filter((l) => /^#\d+$/.test(l.trim()));
    expect(cardNumbers.length).toBe(total);
    expect(cardNumbers[0]).toBe("#1");
    expect(cardNumbers[total - 1]).toBe(`#${total}`);
    for (const n of [1, 2, 39, 40, 41, 79, 80]) {
      expect(pdf.norm).toContain(`Finding number ${n}: issue token-${n} needs attention`);
      expect(pdf.norm).toContain(`Observed evidence for token-${n} at stage html on https://example.com/.`);
    }
    expect(pdf.norm).not.toContain("token-81");
    // confirmed/potential chips reconcile to the saved issue count
    const confirmed = scan.issues.filter((i) => (i.confirmed ?? true) && i.status !== "unable-to-verify").length;
    expect(pdf.norm).toContain(`${confirmed} CONFIRMED`);
    expect(pdf.norm).toContain(`${total - confirmed} POTENTIAL`);
  });

  test("action plan covers all findings in priority order", () => {
    expect(pdf.norm).toContain(`${total} items drawn from the saved findings`);
    expect(pdf.norm.indexOf("1. CRITICAL")).toBeLessThan(pdf.norm.indexOf("2. IMPORTANT"));
    expect(pdf.norm.indexOf("2. IMPORTANT")).toBeLessThan(pdf.norm.indexOf("3. RECOMMENDED"));
  });
});

describe("PDF export — zero findings", () => {
  const scan = zeroFindingsScan();
  const pdf = build(scan);

  test("renders an explicit no-findings report with counts intact", () => {
    expect(pdf.norm).toContain("Findings (0)");
    expect(pdf.norm).toContain("No findings recorded for this scan.");
    expect(pdf.norm).toContain("No findings were recorded for this scan");
    expect(pdf.norm).toContain("PASSED 34");
    expect(pdf.norm).toContain("FAILED 0");
    expect(pdf.norm).toContain("0 CONFIRMED");
    expect(pdf.norm).toContain("0 POTENTIAL");
    expect(pdf.norm).toContain("96/100");
    expect(pdf.norm).toContain("GRADE A");
    expect(pdf.norm).toContain("cannot prove a website is completely secure");
    expect(pdf.text.split("\n").filter((l) => /^#\d+$/.test(l.trim())).length).toBe(0);
  });
});

describe("PDF export — missing optional data (legacy report)", () => {
  const scan = legacyScan();
  const pdf = build(scan);

  test("renders honest fallbacks instead of inventing data", () => {
    expect(pdf.norm).toContain("SCAN COMPLETENESS Saved before evidence tracking");
    expect(pdf.norm).toContain("legacy weighted formula (saved before evidence tracking)");
    expect(pdf.norm).toContain("CONTENT TYPE \u00b7 DURATION not recorded");
    expect(pdf.norm).toContain("Not recorded \u2014 this finding was saved before evidence tracking was added.");
    expect(pdf.norm).toContain("Method/stage not recorded for this legacy finding.");
    expect(pdf.norm).toContain("Legacy finding without evidence fields");
    expect(pdf.norm).toContain("PASSED 17");
    expect(pdf.norm).toContain("FAILED 8");
    expect(pdf.norm).toContain("UNABLE TO VERIFY 0"); // totalUnverified missing → 0, not invented
    // no redirect-chain section when nothing was saved
    expect(pdf.norm).not.toContain("REDIRECT CHAIN");
    expect(pdf.norm).toContain("cannot prove a website is completely secure");
  });
});

describe("PDF export — sensitive data", () => {
  const scan = sensitiveScan();
  const pdf = build(scan);

  test("never includes cookie identifiers, values, or credentials", () => {
    expect(pdf.flat).not.toContain("session_secret");
    expect(pdf.flat).not.toContain("__csrf");
    expect(pdf.flat).not.toContain("Domain=example.com");
    expect(pdf.flat).not.toContain("sk-live-abc123456789");
    expect(pdf.flat).not.toContain("Bearer sk-live");
    // ...while the finding itself is still present
    expect(pdf.norm).toContain("Cookie is missing security attributes");
    expect(pdf.norm).toContain("Set-Cookie observed on");
    expect(pdf.norm).toContain("[redacted]");
    expect(pdf.norm).toContain("Authorization: [redacted]");
    expect(pdf.norm).toContain("was echoed by the error page.");
  });
});

describe("PDF export — counts always match the saved report", () => {
  for (const [name, make] of [
    ["normal", normalScan],
    ["blocked", blocked429Scan],
    ["partial-404", notFound404Scan],
    ["long-url", longUrlScan],
    ["many-findings", manyFindingsScan],
    ["zero-findings", zeroFindingsScan],
  ] as const) {
    test(`${name}: five-state counts and finding count match the saved document`, () => {
      const scan = make();
      const pdf = build(scan);
      const c = scan.summary!.counts;
      expect(pdf.norm).toContain(`PASSED ${c.passed}`);
      expect(pdf.norm).toContain(`FAILED ${c.failed}`);
      expect(pdf.norm).toContain(`WARNINGS ${c.warnings}`);
      expect(pdf.norm).toContain(`NOT APPLICABLE ${c.notApplicable}`);
      expect(pdf.norm).toContain(`UNABLE TO VERIFY ${c.unverified}`);
      expect(pdf.norm).toContain(`TOTAL CHECKS ${c.total}`);
      expect(pdf.norm).toContain(`Findings (${scan.issues.length})`);
      for (const issue of scan.issues) expect(pdf.norm).toContain(issue.message);
      // chips reconcile
      const confirmed = scan.issues.filter((i) => (i.confirmed ?? true) && i.status !== "unable-to-verify").length;
      expect(pdf.norm).toContain(`${confirmed} CONFIRMED`);
      expect(pdf.norm).toContain(`${scan.issues.length - confirmed} POTENTIAL`);
    });
  }
});

describe("PDF export — determinism & metadata", () => {
  test("same input + same generatedAt produces identical content", () => {
    const a = build(normalScan());
    const b = build(normalScan());
    expect(a.pageCount).toBe(b.pageCount);
    expect(a.fileName).toBe(b.fileName);
    expect(a.text).toBe(b.text);
    // Bytes are identical apart from jsPDF's random per-document /ID salt.
    const stripId = (bytes: Uint8Array) =>
      new TextDecoder("latin1")
        .decode(bytes)
        .replace(/\/ID \[ <[0-9A-F]+> <[0-9A-F]+> \]/, "/ID [ <ID> <ID> ]");
    expect(stripId(a.bytes)).toBe(stripId(b.bytes));
  });

  test("sets document metadata", () => {
    const raw = new TextDecoder("latin1").decode(normalScan2Bytes());
    expect(raw).toContain("SitePulse Website Health Report");
    expect(raw).toContain("/Author (SitePulse)");
    expect(raw).toContain("/Creator (SitePulse)");
  });
});

function normalScan2Bytes(): Uint8Array {
  return buildScanPdf(normalScan(), { generatedAt: GENERATED_AT }).bytes;
}
