// Phase 4 V1 (Fix Proposals): deterministic proposal generation from real
// finding shapes, reuse of the report's hosting-aware snippets, honest
// labeling (a proposal is a proposed snippet — never a verified before/after
// diff, never invented file contents), allowlisted targets only, stable
// finding identity, and zero effect on scoring. Wiring pins verify the action
// (a) enforces the server-side quota BEFORE any work, (b) fetches the scan
// server-side by id and accepts no client-supplied finding JSON, (c) makes NO
// external calls of any kind (no model, no GitHub, no network, no writes),
// and (d) that the panel is print-hidden, labeled as suggestions, and renders
// the honest per-proposal preview notice.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  FIX_PROPOSAL_LIMIT_PER_HOUR,
  FIX_PROPOSAL_MAX,
  FIX_PREVIEW_NOTICE,
  FIX_PROPOSAL_NOTICE,
  SUPPORTED_TARGET_PATHS,
  buildFixProposals,
  buildProposedDiff,
  isSupportedTargetPath,
  targetPathFor,
  type FixScanInput,
} from "../src/lib/fixProposal";
import {
  buildSnippet,
  canonicalActionable,
  issueKey,
} from "../src/lib/recommendations";
import { resolveScanScores, type StoredScanScores } from "../src/lib/scoring";
import type { Issue } from "../src/types/scan";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

/* ── Real finding shapes (copied from what src/convex/scan.ts stores) ──────── */

/** `Missing ${header.label} header.` with the scanner's real howToFix text. */
const referrerPolicyFinding = (over: Partial<Issue> = {}): Issue => ({
  category: "Security",
  severity: "warning",
  priority: "important",
  message: "Missing Referrer-Policy header.",
  whyItMatters:
    "Without Referrer-Policy, browsers send full URLs as referrer information to other sites, potentially exposing sensitive page paths or query parameters. What this does not mean: nothing was exploited — the scan only observed that the header was missing from this response.",
  howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
  evidence:
    "Referrer-Policy was not present in the response headers of https://example.com/ (HTTP 200).",
  stage: "headers",
  method: "http",
  checkKey: "rp",
  status: "warning",
  confirmed: false,
  ...over,
});

const cspFinding = (over: Partial<Issue> = {}): Issue =>
  referrerPolicyFinding({
    message: "Missing Content-Security-Policy header.",
    howToFix: "Add the header: Content-Security-Policy: default-src 'self'",
    checkKey: "csp",
    ...over,
  });

/** SEO content finding the scan engine records verbatim. */
const titleFinding = (over: Partial<Issue> = {}): Issue => ({
  category: "SEO",
  severity: "warning",
  priority: "recommended",
  message: "No title tag found.",
  whyItMatters: "The page title is the strongest on-page signal for search engines.",
  howToFix: "Add a descriptive title of 30-60 characters inside the <head>.",
  evidence: "The <title> element was missing from the response HTML of https://example.com/.",
  stage: "html",
  method: "http",
  checkKey: "page-title",
  status: "fail",
  confirmed: true,
  ...over,
});

/** No copy-paste fix exists for a status-code finding — must be skipped. */
const http404Finding = (over: Partial<Issue> = {}): Issue => ({
  category: "Technical Health",
  severity: "critical",
  priority: "critical",
  message: "Server returned HTTP 404.",
  whyItMatters: "A 404 means the resource is missing for visitors too.",
  howToFix: "Check that the URL is correct and that the resource exists on the server.",
  evidence: "GET https://example.com/ returned HTTP 404.",
  stage: "fetch",
  method: "http",
  checkKey: "http-status",
  status: "fail",
  confirmed: true,
  ...over,
});

const makeScan = (
  issues: Issue[],
  serverInfo?: FixScanInput["serverInfo"],
): FixScanInput => ({
  url: "https://example.com/",
  issues,
  ...(serverInfo ? { serverInfo } : {}),
});

/** Added lines of a preview, without the three honest file-header lines. */
function addedLines(diff: string): string[] {
  return diff.split("\n").slice(3);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as object)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/* ── Deterministic proposals from real finding shapes ──────────────────────── */

describe("buildFixProposals — deterministic, evidence-grounded", () => {
  test("proposes a copy-paste change for a missing security header finding", () => {
    const result = buildFixProposals(makeScan([referrerPolicyFinding()]));
    expect(result.provider).toBe("deterministic");
    expect(result.proposals).toHaveLength(1);

    const proposal = result.proposals[0];
    const original = referrerPolicyFinding();
    expect(proposal.key).toBe(issueKey(original));
    expect(proposal.message).toBe(original.message);
    expect(proposal.category).toBe("Security");
    expect(proposal.priority).toBe("important");
    expect(proposal.severity).toBe("warning");
    expect(proposal.snippetLabel.length).toBeGreaterThan(0);
    expect(proposal.rationale).toContain(original.evidence!);
    expect(proposal.evidence).toBe(original.evidence);
    // Anchored to the same card the report renders.
    expect(proposal.anchor).toMatch(/^fix-\d+/);
  });

  test("keys are the canonical issueKeys, ordered most urgent first", () => {
    const result = buildFixProposals(
      makeScan([
        titleFinding(),
        referrerPolicyFinding(),
        cspFinding({ priority: "critical", severity: "critical" }),
      ]),
    );
    const canonical = canonicalActionable([
      titleFinding(),
      referrerPolicyFinding(),
      cspFinding({ priority: "critical", severity: "critical" }),
    ]);
    expect(result.proposals.map((p) => p.key)).toEqual(canonical.map(issueKey));
    expect(result.proposals[0].priority).toBe("critical");
    expect(result.actionableCount).toBe(3);
    expect(result.proposedCount).toBe(3);
    expect(result.skippedCount).toBe(0);
  });

  test("skips findings with no copy-paste fix and counts them honestly", () => {
    const result = buildFixProposals(makeScan([http404Finding(), referrerPolicyFinding()]));
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].message).toBe("Missing Referrer-Policy header.");
    expect(result.skippedCount).toBe(1);
    expect(result.summary).toContain("skipped");
    expect(result.summary).toContain("does not support a concrete file change");
  });

  test("no actionable findings → no proposals and an honest summary", () => {
    const result = buildFixProposals(
      makeScan([referrerPolicyFinding({ priority: "nice-to-have" })]),
    );
    expect(result.proposals).toHaveLength(0);
    expect(result.actionableCount).toBe(0);
    expect(result.summary).toContain("no actionable findings");
  });

  test("caps at FIX_PROPOSAL_MAX, most urgent first", () => {
    const issues = [
      cspFinding({ priority: "critical", severity: "critical" }),
      referrerPolicyFinding({ checkKey: "rp-1" }),
      referrerPolicyFinding({ message: "Missing X-Frame-Options header.", howToFix: "Add the header: X-Frame-Options: DENY (or SAMEORIGIN if you need to frame your own content).", checkKey: "xfo" }),
      referrerPolicyFinding({ message: "Missing X-Content-Type-Options header.", howToFix: "Add the header: X-Content-Type-Options: nosniff", checkKey: "xcto" }),
      referrerPolicyFinding({ message: "Missing Strict-Transport-Security header.", howToFix: "Add the header: Strict-Transport-Security: max-age=31536000; includeSubDomains", checkKey: "hsts" }),
      referrerPolicyFinding({ message: "Missing Permissions-Policy header.", howToFix: "Add the header: Permissions-Policy: camera=(), microphone=(), geolocation=()", checkKey: "pp" }),
      referrerPolicyFinding({ message: "Missing X-Permitted-Cross-Domain-Policies header.", howToFix: "Add the header: X-Permitted-Cross-Domain-Policies: none", checkKey: "xpcdp" }),
      titleFinding(),
      titleFinding({ message: "No meta description found.", checkKey: "meta-description" }),
      titleFinding({ message: "No viewport meta tag.", checkKey: "viewport" }),
    ];
    const result = buildFixProposals(makeScan(issues));
    expect(result.proposals).toHaveLength(FIX_PROPOSAL_MAX);
    expect(result.cappedCount).toBe(issues.length - FIX_PROPOSAL_MAX);
    expect(result.proposals[0].message).toBe("Missing Content-Security-Policy header.");
  });
});

/* ── Hosting-specific snippet reuse ────────────────────────────────────────── */

describe("hosting-specific snippets — reuse of the report's engine", () => {
  const cases: Array<{
    server: string | undefined;
    platformLabel: RegExp;
    targetPath: string;
    expectedLine: RegExp;
  }> = [
    { server: "nginx/1.24.0", platformLabel: /Nginx/, targetPath: "nginx.conf", expectedLine: /add_header Referrer-Policy/ },
    { server: "Apache/2.4.57 (Debian)", platformLabel: /Apache/, targetPath: ".htaccess", expectedLine: /Header always set Referrer-Policy/ },
    { server: "Microsoft-IIS/10.0", platformLabel: /IIS/, targetPath: "web.config", expectedLine: /customHeaders/ },
    { server: "Vercel", platformLabel: /Vercel/, targetPath: "public/_headers", expectedLine: /Referrer-Policy: strict-origin-when-cross-origin/ },
    { server: "Netlify", platformLabel: /Netlify/, targetPath: "public/_headers", expectedLine: /Referrer-Policy: strict-origin-when-cross-origin/ },
    { server: "cloudflare", platformLabel: /Cloudflare/, targetPath: "hosting-control-panel", expectedLine: /Referrer-Policy: strict-origin-when-cross-origin/ },
  ];

  for (const { server, platformLabel, targetPath, expectedLine } of cases) {
    test(`platform "${server}" → ${targetPath}, snippet reused verbatim`, () => {
      const scan = makeScan([referrerPolicyFinding()], { server, technology: [] });
      const result = buildFixProposals(scan);
      const proposal = result.proposals[0];
      expect(result.platformLabel).toMatch(platformLabel);
      expect(proposal.targetPath).toBe(targetPath);
      expect(proposal.diff).toMatch(expectedLine);

      // Reuse, not rewrite: the added lines are exactly buildSnippet's code.
      const snippet = buildSnippet(referrerPolicyFinding(), result.platform);
      expect(snippet).not.toBeNull();
      expect(addedLines(proposal.diff)).toEqual(
        snippet!.code.split("\n").map((line) => `+${line}`),
      );
    });
  }

  test("unknown platform → neutral target that states its assumption", () => {
    const result = buildFixProposals(makeScan([referrerPolicyFinding()]));
    expect(result.platform).toBe("unknown");
    const proposal = result.proposals[0];
    expect(proposal.targetPath).toBe("server-configuration");
    expect(proposal.assumption).toBeTruthy();
    expect(proposal.assumption!).toMatch(/could not identify your hosting platform/);
    expect(proposal.rationale).toContain("named no specific platform");
  });

  test("targetPathFor maps site-root files and page markup correctly", () => {
    const robots = titleFinding({ message: "No robots.txt file found." });
    const sitemap = titleFinding({ message: "No sitemap.xml found." });
    expect(targetPathFor(robots, "unknown").path).toBe("robots.txt");
    expect(targetPathFor(sitemap, "unknown").path).toBe("sitemap.xml");
    expect(targetPathFor(titleFinding(), "nginx").path).toBe("index.html");
    expect(targetPathFor(referrerPolicyFinding(), "openresty").path).toBe("nginx.conf");
    expect(targetPathFor(referrerPolicyFinding(), "litespeed").path).toBe(".htaccess");
  });
});

/* ── Honest labeling ───────────────────────────────────────────────────────── */

describe("honest labeling — never a verified diff, never invented contents", () => {
  test("every preview is a proposed snippet of additions only", () => {
    const result = buildFixProposals(
      makeScan([referrerPolicyFinding(), titleFinding()], { server: "nginx/1.24.0", technology: [] }),
    );
    for (const proposal of result.proposals) {
      expect(proposal.previewKind).toBe("proposed-snippet");
      expect(proposal.previewNotice).toBe(FIX_PREVIEW_NOTICE);
      expect(proposal.previewNotice).toMatch(/not a verified before\/after diff/);
      const lines = proposal.diff.split("\n");
      expect(lines[0]).toContain("current contents not inspected");
      expect(lines[1]).toContain("proposed additions only");
      expect(lines[2]).toMatch(/^@@ /);
      // Additions only: no fabricated "-" or context lines, ever.
      expect(addedLines(proposal.diff).every((line) => line.startsWith("+"))).toBe(true);
    }
    expect(result.notice).toBe(FIX_PROPOSAL_NOTICE);
    expect(result.notice).toContain("never read your source files");
    expect(result.notice).toContain("No AI model ran");
  });

  test("a finding without recorded evidence is labeled as such in its rationale", () => {
    const legacy = titleFinding({ evidence: undefined, confirmed: false, status: "warning" });
    const result = buildFixProposals(makeScan([legacy]));
    const proposal = result.proposals[0];
    expect(proposal.evidence).toBeUndefined();
    expect(proposal.rationale).toContain("records no direct evidence");
  });

  test("buildProposedDiff never emits removed or context lines", () => {
    const diff = buildProposedDiff("robots.txt", "User-agent: *\nAllow: /");
    const lines = diff.split("\n");
    expect(lines).toHaveLength(5);
    expect(addedLines(diff)).toEqual(["+User-agent: *", "+Allow: /"]);
    expect(lines.slice(3).every((line) => line.startsWith("+"))).toBe(true);
  });
});

/* ── Targets are allowlisted ───────────────────────────────────────────────── */

describe("target validation — allowlisted paths only", () => {
  test("accepts every supported target", () => {
    for (const path of SUPPORTED_TARGET_PATHS) {
      expect(isSupportedTargetPath(path)).toBe(true);
    }
  });

  test("rejects unsupported/hostile paths", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "../../etc/passwd",
      "package.json",
      ".env",
      "",
      "index.html/../../secrets",
    ]) {
      expect(isSupportedTargetPath(path)).toBe(false);
    }
  });

  test("every generated proposal uses an allowlisted target", () => {
    const result = buildFixProposals(
      makeScan([referrerPolicyFinding(), titleFinding(), cspFinding({ priority: "critical", severity: "critical" })]),
    );
    for (const proposal of result.proposals) {
      expect(isSupportedTargetPath(proposal.targetPath)).toBe(true);
    }
  });
});

/* ── Stable identity and untouched scoring ─────────────────────────────────── */

describe("identity stability and scoring integrity", () => {
  test("identical findings collapse to one proposal (same key as the report)", () => {
    const result = buildFixProposals(makeScan([referrerPolicyFinding(), referrerPolicyFinding()]));
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].key).toBe(issueKey(referrerPolicyFinding()));
  });

  test("buildFixProposals never mutates the scan and never changes scores", () => {
    const scan: StoredScanInputs = {
      url: "https://example.com/",
      issues: [referrerPolicyFinding(), titleFinding()],
      performanceScore: 70,
      seoScore: 60,
      securityScore: 40,
      accessibilityScore: 80,
      technicalHealthScore: 65,
      performanceChecks: { score: 70, passed: 3, failed: 1, warnings: 0, notChecked: 0 },
      seoChecks: { score: 60, passed: 3, failed: 2, warnings: 1, notChecked: 0 },
      securityChecks: { score: 40, passed: 1, failed: 3, warnings: 0, notChecked: 0 },
      accessibilityChecks: { score: 80, passed: 4, failed: 1, warnings: 0, notChecked: 0 },
      technicalHealthChecks: { score: 65, passed: 3, failed: 1, warnings: 0, notChecked: 0 },
    };
    const before = resolveScanScores(scan);
    const snapshot = JSON.stringify(scan);
    deepFreeze(scan);
    const result = buildFixProposals(scan);
    expect(result.proposals.length).toBeGreaterThan(0);
    expect(JSON.stringify(scan)).toBe(snapshot);
    expect(resolveScanScores(scan)).toEqual(before);
  });

  test("proposals carry no score fields — nothing here can move a number", () => {
    const result = buildFixProposals(makeScan([referrerPolicyFinding()]));
    for (const proposal of result.proposals) {
      expect(Object.keys(proposal).some((field) => /score|gain/i.test(field))).toBe(false);
    }
  });
});

/* ── Wiring pins: action, quota, panel (source-level) ──────────────────────── */

describe("wiring — proposeFixes action and FixProposalPanel (source pins)", () => {
  const actionSource = read("src/convex/aiAssistant.ts");
  const proposeBlock = actionSource.slice(actionSource.indexOf("export const proposeFixes"));

  test("quota runs BEFORE the scan fetch, and the scan is fetched by id", () => {
    expect(proposeBlock.length).toBeGreaterThan(0);
    const quotaAt = proposeBlock.indexOf("internal.rateLimit.consumeProposalQuota");
    const fetchAt = proposeBlock.indexOf("api.scans.getScan");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(quotaAt);
    expect(proposeBlock).toContain('v.id("scans")');
  });

  test("the action accepts no client-supplied finding JSON", () => {
    const argsBlock = proposeBlock.slice(0, proposeBlock.indexOf("handler:"));
    expect(argsBlock).not.toMatch(/issues|scanData|findings/);
    expect(argsBlock).toMatch(/scanId:\s*v\.id\("scans"\)/);
  });

  test("the action makes no external calls (no model, no GitHub, no network)", () => {
    expect(proposeBlock).not.toMatch(/fetch\(|axios|vly\.ai|github|octokit|pull request/i);
  });

  test("the quota uses its own key and the lib's limit constants", () => {
    const rateSource = read("src/convex/rateLimit.ts");
    expect(rateSource).toContain("fix-proposal:${visitor}");
    expect(rateSource).toContain("FIX_PROPOSAL_LIMIT_PER_HOUR");
    expect(rateSource).toContain("FIX_PROPOSAL_WINDOW_MS");
    expect(FIX_PROPOSAL_LIMIT_PER_HOUR).toBe(10);
  });

  test("the panel is print-hidden, labeled suggestions-only, and shows the notice", () => {
    const panel = read("src/components/FixProposalPanel.tsx");
    expect(panel).toContain("print:hidden");
    expect(panel).toContain("Deterministic · Suggestions only");
    expect(panel).toContain("Proposed snippets · not verified diffs");
    expect(panel).toContain("{proposal.previewNotice}");
    // Phase 5: the GitHub Repair section renders as its own component inside
    // this print-hidden panel. The panel itself still never talks to GitHub:
    // no octokit, no credentials, no client-side API calls — all GitHub I/O
    // lives in Convex server functions.
    expect(panel).toContain("<GitHubRepair");
    expect(panel).not.toContain("octokit");
    expect(panel).not.toMatch(/access_token|client_secret|Authorization:/i);
    const gh = read("src/components/GitHubRepair.tsx");
    expect(gh).not.toContain("octokit");
    expect(gh).not.toMatch(/access_token|client_secret/);
  });

  test("the panel is mounted next to the Website Doctor inside a print:hidden wrapper", () => {
    const report = read("src/pages/Report.tsx");
    const start = report.indexOf("AI Website Doctor");
    const panelAt = report.indexOf("<FixProposalPanel");
    expect(start).toBeGreaterThan(-1);
    expect(panelAt).toBeGreaterThan(start);
    expect(report.slice(start, panelAt)).toContain("print:hidden");
  });
});

/** FixScanInput with StoredScanScores fields (the real action input shape). */
type StoredScanInputs = FixScanInput & StoredScanScores;
