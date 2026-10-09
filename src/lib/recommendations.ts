/**
 * Recommendation consolidation + hosting-aware fix snippets.
 *
 * Two problems live here:
 *
 * 1. The same advice used to be rendered several times per report — as a
 *    "Fix These First" card, again in "Fix Recommendations", again under
 *    "Quick Wins" and once more in "All Recommendations". `dedupeIssues` and
 *    `splitRecommendations` give every finding exactly one canonical slot so
 *    the page can link to it instead of repeating it.
 *
 * 2. Fix snippets used to assume Nginx (with a stray Apache variant) for every
 *    server header. Snippets are now chosen from the platform the scan
 *    actually observed, and fall back to platform-neutral steps that state the
 *    assumption instead of inventing a server.
 */

import type { Priority, Severity } from "../types/scan";
import {
  detectHostingPlatform,
  headerSyntaxFor,
  HOSTING_LABELS,
  type HostingEvidence,
  type HostingPlatform,
} from "./hosting";

/* ── Issue shape (structural: works with saved Convex docs) ────────────── */

export interface RecommendationIssue {
  category: string;
  severity: Severity;
  priority: Priority;
  message: string;
  whyItMatters: string;
  howToFix: string;
  checkKey?: string;
  evidence?: string;
  status?: "fail" | "warning" | "unable-to-verify";
  confirmed?: boolean;
}

const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  important: 1,
  recommended: 2,
  "nice-to-have": 3,
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Normalised message text, used for message-only matching (quick wins). */
export function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Stable identity for a finding, used to collapse repeated advice.
 *
 * The check key alone is NOT enough: the scan engine reuses keys across
 * mutually exclusive branches (`http-status` covers a dangling redirect, a
 * 404, a 500 and other 4xx/5xx; `ssl-valid` covers expired, expiring and
 * unverifiable). Two findings that share a key but describe different
 * observations or different remediations are different findings, so the
 * message, the remediation and the evidence all take part in the identity.
 * Only genuinely identical advice ever collapses.
 */
export function issueKey(issue: RecommendationIssue): string {
  const checkKey = issue.checkKey?.trim() || "-";
  return [
    issue.category,
    checkKey,
    normalizeMessage(issue.message),
    normalizeMessage(issue.howToFix),
    normalizeMessage(issue.evidence ?? ""),
  ].join("|");
}

/**
 * Find the canonical issue behind a derived summary row (quick wins store
 * only a category and a message).
 */
export function matchIssueByMessage<T extends RecommendationIssue>(
  issues: T[],
  message: string,
): T | undefined {
  const target = normalizeMessage(message);
  return issues.find((issue) => normalizeMessage(issue.message) === target);
}

/**
 * Remove repeated advice, keeping the strongest instance of each finding.
 * Order of first appearance is preserved so reports stay stable.
 */
export function dedupeIssues<T extends RecommendationIssue>(issues: T[]): T[] {
  const best = new Map<string, T>();
  for (const issue of issues) {
    const key = issueKey(issue);
    const current = best.get(key);
    if (!current) {
      best.set(key, issue);
      continue;
    }
    const beatsCurrent =
      PRIORITY_RANK[issue.priority] < PRIORITY_RANK[current.priority] ||
      (issue.priority === current.priority &&
        SEVERITY_RANK[issue.severity] < SEVERITY_RANK[current.severity]);
    if (beatsCurrent) best.set(key, issue);
  }
  return [...best.values()];
}

export interface SplitRecommendations<T> {
  /** Critical / important / recommended — the fixes worth doing now. */
  actionable: T[];
  /** Nice-to-have and info — context, not urgent work. */
  informational: T[];
}

export function splitRecommendations<T extends RecommendationIssue>(
  issues: T[],
): SplitRecommendations<T> {
  const actionable: T[] = [];
  const informational: T[] = [];
  for (const issue of dedupeIssues(issues)) {
    if (
      issue.priority === "critical" ||
      issue.priority === "important" ||
      issue.priority === "recommended"
    ) {
      actionable.push(issue);
    } else {
      informational.push(issue);
    }
  }
  return { actionable, informational };
}

/**
 * The single canonical list the report renders: deduplicated, actionable
 * only, sorted by priority then severity. Summary rows and detailed cards
 * both derive from it, so an anchor computed here is valid everywhere.
 */
export function canonicalActionable<T extends RecommendationIssue>(issues: T[]): T[] {
  return sortRecommendations(splitRecommendations(issues).actionable);
}

/** issueKey → anchor, for the given canonical list. */
export function anchorsFor(issues: RecommendationIssue[]): Map<string, string> {
  return new Map(issues.map((issue, index) => [issueKey(issue), anchorFor(issue, index)]));
}

/** Sort by priority, then severity — the order the report renders in. */
export function sortRecommendations<T extends RecommendationIssue>(issues: T[]): T[] {
  return [...issues].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

/** Anchor a summary row can link to, so advice is written out only once. */
export function anchorFor(issue: RecommendationIssue, index: number): string {
  const base = (issue.checkKey || issue.message)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `fix-${index + 1}${base ? `-${base}` : ""}`;
}

/* ── Hosting-aware snippets ────────────────────────────────────────────── */

export interface FixSnippet {
  /** Short label shown on the copy button, e.g. "Nginx server block". */
  label: string;
  code: string;
  /** Set when the platform was not identified — shown as a stated assumption. */
  assumption?: string;
}

/** Fixes that are plain HTML/config and need no server identification. */
const STATIC_SNIPPETS: Record<string, FixSnippet | undefined> = {
  "No title tag found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<title>Your Page Title Here — 30-60 characters</title>`,
  },
  "No meta description found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<meta name="description" content="A compelling 120-160 character description of this page that entices users to click from search results.">`,
  },
  "No H1 tag found.": {
    label: "HTML",
    code: `<!-- Add exactly one <h1> per page, inside <body> -->\n<h1>Your Main Page Heading</h1>`,
  },
  "No canonical tag found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<link rel="canonical" href="https://yourdomain.com/this-page">`,
  },
  "No robots.txt file found.": {
    label: "robots.txt",
    code: `# Create at your site root: https://yourdomain.com/robots.txt\nUser-agent: *\nAllow: /\nSitemap: https://yourdomain.com/sitemap.xml`,
  },
  "No sitemap.xml found.": {
    label: "sitemap.xml",
    code: `<!-- Create at your site root: https://yourdomain.com/sitemap.xml -->\n<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://yourdomain.com/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>`,
  },
  "No viewport meta tag.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
  },
  "Missing charset declaration.": {
    label: "HTML",
    code: `<!-- Add as the first tag inside <head> -->\n<meta charset="utf-8">`,
  },
  "Missing DOCTYPE declaration.": {
    label: "HTML",
    code: `<!-- Add as the very first line of your HTML file -->\n<!DOCTYPE html>`,
  },
  "The <html> tag is missing a lang attribute.": {
    label: "HTML",
    code: `<!-- Change your <html> tag -->\n<html lang="en">`,
  },
  "form input(s) may be missing associated labels.": {
    label: "HTML",
    code: `<!-- Pair each input with a label -->\n<label for="email">Email address</label>\n<input id="email" type="email" name="email">`,
  },
};

const STATIC_MESSAGES = Object.keys(STATIC_SNIPPETS);

function cleanHeaderValue(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^[:\s]+/, "")
    // A how-to-fix sentence continues after the value ("… includeSubDomains.
    // Start with a short max-age") or after a parenthetical ("DENY (or
    // SAMEORIGIN …)"); the header value stops there.
    .split(/\.\s/)[0]
    .split(/\s+\(/)[0]
    .trim();
  // Only unwrap a *fully* quoted value — a policy value ending in
  // 'unsafe-inline' must keep its trailing quote.
  const quoted = /^["']([\s\S]*)["']$/.exec(cleaned);
  return (quoted ? quoted[1] : cleaned).replace(/[.,]$/, "").trim();
}

/** Pull `Header-Name: value` out of a how-to-fix sentence (last resort). */
function parseHeaderDirective(howToFix: string): { name: string; value: string } | null {
  const match = /([A-Za-z][A-Za-z-]{2,}):\s*([^\n]+?)(?:\s*\(|\s*$)/.exec(howToFix);
  if (!match) return null;
  const name = match[1].trim();
  const value = cleanHeaderValue(match[2]);
  if (!name || !value || /\s/.test(name)) return null;
  return { name, value };
}

const NEUTRAL_ASSUMPTION =
  "Assumption: the scan could not identify your hosting platform from the response, so no specific server software is assumed — apply this wherever your responses are produced (origin server, reverse proxy, CDN or host control panel).";

function headerSnippet(
  header: { name: string; value: string },
  platform: HostingPlatform,
): FixSnippet {
  const { name, value } = header;
  const platformLabel = HOSTING_LABELS[platform];
  switch (headerSyntaxFor(platform)) {
    case "nginx":
      return {
        label: `${platformLabel} server block`,
        code: `# ${platformLabel} — inside the server { } or location { } block:\nadd_header ${name} "${value}" always;`,
      };
    case "apache":
      return {
        label: `${platformLabel} .htaccess`,
        code: `# ${platformLabel} — in .htaccess or the VirtualHost config:\nHeader always set ${name} "${value}"`,
      };
    case "iis":
      return {
        label: `${platformLabel} web.config`,
        code: `<!-- ${platformLabel} — inside <system.webServer> -->\n<httpProtocol>\n  <customHeaders>\n    <add headerName="${name}" value="${value}" />\n  </customHeaders>\n</httpProtocol>`,
      };
    case "panel":
      return {
        label: `${platformLabel} settings`,
        code: `# ${platformLabel}: add a response header for this site in the dashboard\n# (Cloudflare: Security → Security Headers · Vercel/Netlify: a _headers file)\n#\n# Header name:  ${name}\n# Header value: ${value}\n\n# Equivalent _headers file (Vercel / Netlify):\n/*\n  ${name}: ${value}`,
      };
    default:
      return {
        label: "Generic response header",
        code: `# Add this response header on the server (or CDN) that serves your site:\n#\n#   ${name}: ${value}\n#\n# Nginx:            add_header ${name} "${value}" always;\n# Apache/LiteSpeed: Header always set ${name} "${value}"\n# IIS:              <add headerName="${name}" value="${value}" />\n#\n# Only one of these applies to you — the scan could not tell which.`,
        assumption: NEUTRAL_ASSUMPTION,
      };
  }
}

const SECURITY_HEADER_MESSAGE = /^missing (.+?) header\.?$/i;
const KNOWN_HEADER_NAMES =
  /(Content-Security-Policy|Strict-Transport-Security|X-Content-Type-Options|X-Frame-Options|Referrer-Policy|Permissions-Policy|X-Permitted-Cross-Domain-Policies)\s*:\s*([^\n]+)/i;

/**
 * Resolve the header a finding asks for: its name comes from the finding
 * message ("Missing Referrer-Policy header."), its value from the directive
 * inside the how-to-fix text.
 */
function headerFromIssue(issue: RecommendationIssue): { name: string; value: string } | null {
  const named = SECURITY_HEADER_MESSAGE.exec(issue.message.trim());
  const nameGuess = named
    ? named[1].replace(/\s*\([^)]*\)\s*$/, "").trim() // "HSTS (legacy name)" → "HSTS"
    : "";
  if (nameGuess) {
    const escaped = nameGuess.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new RegExp(`${escaped}\\s*:\\s*([^\\n]+)`, "i").exec(issue.howToFix);
    if (exact) {
      return { name: nameGuess, value: cleanHeaderValue(exact[1]) };
    }
  }
  const known = KNOWN_HEADER_NAMES.exec(issue.howToFix);
  if (known) return { name: known[1].trim(), value: cleanHeaderValue(known[2]) };
  return parseHeaderDirective(issue.howToFix);
}

/**
 * The snippet for a finding, or null when the finding is not a copy-paste
 * fix. Platform-specific steps are only produced when the scan observed
 * evidence naming that platform.
 */
export function buildSnippet(
  issue: RecommendationIssue,
  platform: HostingPlatform = "unknown",
): FixSnippet | null {
  const staticSnippet =
    STATIC_SNIPPETS[issue.message] ??
    STATIC_MESSAGES.map((key) =>
      issue.message.includes(key) || issue.howToFix.includes(key) ? STATIC_SNIPPETS[key] : undefined,
    ).find(Boolean);
  if (staticSnippet) return staticSnippet;

  // Security headers: build from the header directive the scan recommends.
  if (issue.category === "Security" && SECURITY_HEADER_MESSAGE.test(issue.message.trim())) {
    const header = headerFromIssue(issue);
    if (header) return headerSnippet(header, platform);
  }

  return null;
}

/** Hosting platform inferred from the evidence stored with a scan. */
export function platformFromScan(evidence: HostingEvidence): HostingPlatform {
  return detectHostingPlatform(evidence);
}
