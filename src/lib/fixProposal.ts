// ── Fix Proposals (Phase 4, V1) — deterministic, evidence-grounded ──────────
// Pure module (no I/O, no Convex imports): turns a saved scan into structured
// fix proposals — finding identity, a concrete target file, a clearly-labeled
// proposed change and a readable diff preview — using ONLY data already saved
// on the document (message, howToFix, evidence) plus the existing
// hosting-aware snippet engine in src/lib/recommendations.ts.
//
// HONESTY CONTRACT (hard rules, tested in tests/fixProposal.test.ts):
//  * SitePulse only ever read the target's public HTTP response — never the
//    site owner's source files. A proposal's "before" side is therefore ALWAYS
//    unknown, so every preview is labeled a proposed snippet / illustrative
//    patch (previewKind: "proposed-snippet"), and the diff body contains only
//    proposed addition ("+") lines plus file headers that state the original
//    contents were not inspected. No "-" or context lines are ever emitted:
//    that would fabricate the current contents of a file we never read.
//  * A proposal exists ONLY when buildSnippet returns a concrete snippet for
//    the finding. Findings whose evidence does not support a copy-paste fix
//    are skipped and counted — never patched with invented content.
//  * This module never changes scores, never invents issues, and never runs a
//    model. `provider` is always "deterministic" and callers must label the
//    output as suggestions only.
//  * V1 makes no GitHub/API/file-system calls and writes nothing anywhere:
//    proposals are computed on demand and returned to the report page.

import { HOSTING_LABELS, type HostingEvidence, type HostingPlatform } from "./hosting";
import {
  anchorsFor,
  buildSnippet,
  canonicalActionable,
  issueKey,
  platformFromScan,
  type RecommendationIssue,
} from "./recommendations";

/* ── Limits & quota constants (single source: browser and Convex both import) ─ */

/** Proposals shown per report — the most urgent findings first. */
export const FIX_PROPOSAL_MAX = 8;
/** Server-side quota: proposals allowed per visitor per window. */
export const FIX_PROPOSAL_LIMIT_PER_HOUR = 10;
/** Length of the proposal window. */
export const FIX_PROPOSAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/* ── Honest labeling ───────────────────────────────────────────────────────── */

/** Panel-level statement rendered once above the proposal list. */
export const FIX_PROPOSAL_NOTICE =
  "Suggestions only — every proposal is generated deterministically from this report's saved findings and fix snippets. No AI model ran, SitePulse never read your source files, and nothing was applied to your site, any repository or any hosting account. Review each change against your actual files before applying it, then re-scan to confirm.";

/** Per-proposal statement rendered above each diff preview. */
export const FIX_PREVIEW_NOTICE =
  "Proposed snippet, not a verified before/after diff: SitePulse read only this site's public HTTP response, so the current contents of the target file are unknown. Every line below is a proposed addition — nothing was removed, because nothing was inspected.";

/* ── Targets ───────────────────────────────────────────────────────────────── */

interface TargetSpec {
  /** Stable, allowlisted token shown to the user and enforced by validation. */
  path: string;
  /** Human description of where the change is applied. */
  label: string;
}

const TARGETS = {
  html: {
    path: "index.html",
    label: "The page's own HTML (inside <head> or <body>, depending on the element)",
  },
  robots: { path: "robots.txt", label: "A robots.txt file served from the site root" },
  sitemap: { path: "sitemap.xml", label: "A sitemap.xml file served from the site root" },
  nginx: { path: "nginx.conf", label: "Your Nginx server or location block" },
  apache: { path: ".htaccess", label: "Your .htaccess or VirtualHost configuration" },
  iis: { path: "web.config", label: "Your IIS web.config (inside <system.webServer>)" },
  headersFile: {
    path: "public/_headers",
    label: "A _headers file at the site root (Netlify/Vercel style)",
  },
  panel: {
    path: "hosting-control-panel",
    label: "Your hosting control panel or CDN settings (where responses are configured)",
  },
  serverConfig: {
    path: "server-configuration",
    label:
      "Wherever this site's responses are produced (origin server, reverse proxy, CDN or host control panel)",
  },
} as const satisfies Record<string, TargetSpec>;

/** Every target path V1 can propose. Anything else is rejected as unsupported. */
export const SUPPORTED_TARGET_PATHS: readonly string[] = Object.values(TARGETS).map(
  (t) => t.path,
);

/** True only for the allowlisted targets above — rejects arbitrary paths. */
export function isSupportedTargetPath(path: string): boolean {
  return SUPPORTED_TARGET_PATHS.includes(path);
}

/**
 * Mirrors SECURITY_HEADER_MESSAGE in src/lib/recommendations.ts — the exact
 * condition under which buildSnippet produces a header snippet
 * (`Missing Referrer-Policy header.`). Kept in sync by tests.
 */
const SECURITY_HEADER_MESSAGE = /^missing (.+?) header\.?$/i;

/** Which file a finding's snippet belongs in, given the platform the scan observed. */
export function targetPathFor(issue: RecommendationIssue, platform: HostingPlatform): TargetSpec {
  if (/robots\.txt/i.test(issue.message)) return TARGETS.robots;
  if (/sitemap\.xml/i.test(issue.message)) return TARGETS.sitemap;
  if (issue.category === "Security" && SECURITY_HEADER_MESSAGE.test(issue.message.trim())) {
    switch (platform) {
      case "nginx":
      case "openresty":
        return TARGETS.nginx;
      case "apache":
      case "litespeed":
        return TARGETS.apache;
      case "iis":
        return TARGETS.iis;
      case "vercel":
      case "netlify":
        // These platforms serve a _headers file directly.
        return TARGETS.headersFile;
      case "cloudflare":
        // Cloudflare responses are configured in its dashboard; the panel
        // snippet also includes the equivalent _headers form.
        return TARGETS.panel;
      default:
        return TARGETS.serverConfig;
    }
  }
  // Everything else with a copy-paste snippet in V1 is a page-content edit
  // (title, meta description, viewport, H1, canonical, lang, labels…).
  return TARGETS.html;
}

/* ── Diff preview ──────────────────────────────────────────────────────────── */

/**
 * Unified-diff-formatted preview of a proposed change.
 *
 * Additions only: the original file was never inspected, so no "-" or context
 * lines are ever emitted (they would fabricate the current contents). The
 * file headers state that explicitly. See FIX_PREVIEW_NOTICE for the
 * user-facing label the panel renders above this block.
 */
export function buildProposedDiff(targetPath: string, code: string): string {
  const additions = code
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [
    `--- a/${targetPath} (current contents not inspected)`,
    `+++ b/${targetPath} (proposed additions only)`,
    "@@ proposed additions — no original lines are shown, because SitePulse did not read this file @@",
    additions,
  ].join("\n");
}

/* ── Proposal ──────────────────────────────────────────────────────────────── */

/** Always "proposed-snippet" in V1 — never a verified before/after diff. */
export type FixPreviewKind = "proposed-snippet";

export interface FixProposal {
  /** Stable identity (issueKey — the same scheme the report and Doctor use). */
  key: string;
  /** Anchor of the matching FixRecommendations card, when there is one. */
  anchor?: string;
  category: string;
  severity: string;
  priority: string;
  message: string;
  /** Allowlisted target token — see SUPPORTED_TARGET_PATHS. */
  targetPath: string;
  /** Where the change is applied, in the owner's terms. */
  targetLabel: string;
  /** Human label of the snippet source, e.g. "Nginx server block". */
  snippetLabel: string;
  /** Unified-diff preview: proposed additions only. */
  diff: string;
  /** Always "proposed-snippet" in V1. */
  previewKind: FixPreviewKind;
  /** Honest statement rendered above the diff (see FIX_PREVIEW_NOTICE). */
  previewNotice: string;
  /** Why this file, why this change — derived only from saved evidence. */
  rationale: string;
  /** Set when the platform was not identified (carried from the snippet). */
  assumption?: string;
  /** Observed evidence, verbatim, when the scan recorded any. */
  evidence?: string;
}

/** Structural input: only fields the stored scan document actually has. */
export interface FixScanInput {
  url: string;
  issues: Array<RecommendationIssue & { stage?: string }>;
  serverInfo?: HostingEvidence;
}

export interface FixProposalResult {
  /** Always "deterministic" in V1 — display this, never claim a model ran. */
  provider: "deterministic";
  url: string;
  /** Platform inferred from the saved response evidence ("unknown" when unnamed). */
  platform: HostingPlatform;
  platformLabel: string;
  proposals: FixProposal[];
  /** Canonical actionable findings considered (same list the report renders). */
  actionableCount: number;
  /** Actionable findings that got a proposal. */
  proposedCount: number;
  /** Processed findings with no copy-paste fix — nothing invented for them. */
  skippedCount: number;
  /** Actionable findings beyond FIX_PROPOSAL_MAX that were not processed. */
  cappedCount: number;
  /** One-sentence honest summary of the counts above. */
  summary: string;
  /** Panel-level honesty statement (FIX_PROPOSAL_NOTICE). */
  notice: string;
}

/* ── Rationale ─────────────────────────────────────────────────────────────── */

/** Why this file, for this finding, on this platform — evidence only, no invention. */
function rationaleFor(
  issue: RecommendationIssue,
  target: TargetSpec,
  platform: HostingPlatform,
): string {
  const observed = issue.evidence?.trim()
    ? `The scan recorded this evidence: "${issue.evidence.trim()}"`
    : "The saved report records no direct evidence for this finding";

  let placement: string;
  switch (target.path) {
    case TARGETS.nginx.path:
      placement = `The scan's response named ${HOSTING_LABELS[platform]}, so the snippet is written in Nginx syntax.`;
      break;
    case TARGETS.apache.path:
      placement = `The scan's response named ${HOSTING_LABELS[platform]}, so the snippet is written in Apache syntax.`;
      break;
    case TARGETS.iis.path:
      placement = `The scan's response named ${HOSTING_LABELS[platform]}, so the snippet is written in IIS web.config syntax.`;
      break;
    case TARGETS.panel.path:
      placement = `The scan's response named ${HOSTING_LABELS[platform]}, which configures response headers in its dashboard — an equivalent _headers snippet is included as a fallback.`;
      break;
    case TARGETS.headersFile.path:
      placement = `The scan's response named ${HOSTING_LABELS[platform]}, which serves this site's responses from a _headers file.`;
      break;
    case TARGETS.robots.path:
    case TARGETS.sitemap.path:
      placement = `A ${target.path} file is served from the site root, so the snippet is the file's full proposed content.`;
      break;
    case TARGETS.serverConfig.path:
      placement =
        "The response named no specific platform, so the snippet stays platform-neutral and states its assumption instead of guessing a server.";
      break;
    default:
      placement =
        "This finding is about the page's own markup, so the change belongs in the page's HTML.";
      break;
  }

  return `${observed}. ${placement} Apply it wherever ${target.label.toLowerCase()} is managed, then re-scan to confirm the finding clears.`;
}

/* ── Assembly ──────────────────────────────────────────────────────────────── */

/**
 * Build the fix proposals for a saved scan. Pure and synchronous.
 *
 * Guarantees:
 * - the candidate list is canonicalActionable — deduplicated, actionable-only,
 *   sorted by priority then severity (exactly what the report renders), so
 *   every proposal's key and anchor resolve to a real recommendation card;
 * - a proposal appears only where buildSnippet returns a concrete snippet —
 *   the finding's own evidence supports the change;
 * - no score is read, recomputed or changed; no document is mutated.
 */
export function buildFixProposals(scan: FixScanInput): FixProposalResult {
  const platform = platformFromScan(scan.serverInfo ?? {});
  const actionable = canonicalActionable(scan.issues);
  const anchors = anchorsFor(actionable);

  const proposals: FixProposal[] = [];
  let skippedCount = 0;
  let index = 0;
  for (; index < actionable.length && proposals.length < FIX_PROPOSAL_MAX; index++) {
    const issue = actionable[index];
    const snippet = buildSnippet(issue, platform);
    if (!snippet) {
      // Honest skip: this finding has no copy-paste fix (its evidence does
      // not support one). Nothing is invented in its place.
      skippedCount += 1;
      continue;
    }
    const target = targetPathFor(issue, platform);
    const key = issueKey(issue);
    const anchor = anchors.get(key);
    proposals.push({
      key,
      ...(anchor ? { anchor } : {}),
      category: issue.category,
      severity: issue.severity,
      priority: issue.priority,
      message: issue.message,
      targetPath: target.path,
      targetLabel: target.label,
      snippetLabel: snippet.label,
      diff: buildProposedDiff(target.path, snippet.code),
      previewKind: "proposed-snippet",
      previewNotice: FIX_PREVIEW_NOTICE,
      rationale: rationaleFor(issue, target, platform),
      ...(snippet.assumption ? { assumption: snippet.assumption } : {}),
      ...(issue.evidence?.trim() ? { evidence: issue.evidence.trim() } : {}),
    });
  }
  const cappedCount = Math.max(actionable.length - index, 0);

  let summary: string;
  if (actionable.length === 0) {
    summary =
      "This report has no actionable findings, so there is nothing to propose. Minor polish items remain under \"Other Findings\".";
  } else if (proposals.length === 0) {
    summary = `None of the ${actionable.length} actionable findings on this report has a copy-paste fix its evidence supports, so no proposal is shown — and none is invented. Follow the written guidance in Fix Recommendations below instead.`;
  } else {
    const parts = [
      `${proposals.length} of ${actionable.length} actionable findings ${proposals.length === 1 ? "has" : "have"} a copy-paste proposal`,
    ];
    if (skippedCount > 0) {
      parts.push(
        `${skippedCount} ${skippedCount === 1 ? "was" : "were"} skipped because its evidence does not support a concrete file change`,
      );
    }
    if (cappedCount > 0) {
      parts.push(`${cappedCount} more ${cappedCount === 1 ? "is" : "are"} beyond the ${FIX_PROPOSAL_MAX}-proposal cap for this view`);
    }
    summary = `${parts.join("; ")}. Proposals are ordered most urgent first and change no score on this report.`;
  }

  return {
    provider: "deterministic",
    url: scan.url,
    platform,
    platformLabel: HOSTING_LABELS[platform],
    proposals,
    actionableCount: actionable.length,
    proposedCount: proposals.length,
    skippedCount,
    cappedCount,
    summary,
    notice: FIX_PROPOSAL_NOTICE,
  };
}
