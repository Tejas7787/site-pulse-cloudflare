// ── GitHub Repair Agent V2 (Phase 5) — pure, deterministic logic ─────────────
// No I/O, no Convex imports, no model: everything here runs on data the server
// already fetched (saved scan findings + GitHub API responses) and is unit
// tested in tests/githubRepair.test.ts.
//
// SAFETY CONTRACT
//  * Repository content and GitHub responses are UNTRUSTED input: every path,
//    branch, repo name and API payload is validated/sanitized before use, and
//    secrets-shaped files (.env*, keys, credentials) are never read.
//  * Fixes are deterministic and drawn from the existing snippet engine
//    (src/lib/recommendations.ts) — no AI call exists anywhere in Phase 5.
//  * Anything that cannot be expressed as a safe, reviewable edit returns an
//    honest `unsupported` result ("manual fix required") — nothing is ever
//    invented to fill the gap, and a file that diverges from the scan is
//    refused rather than "fixed".
//  * Diffs are REAL unified diffs (V2 read the actual file), unlike V1's
//    proposed-snippet previews which never inspected the owner's sources.

import {
  buildSnippet,
  headerFromIssue,
  type RecommendationIssue,
} from "./recommendations";
import type { HostingPlatform } from "./hosting";

/* ── Limits (single source: actions and tests both import these) ───────────── */

/** Largest file (bytes) we will read for a repair proposal. */
export const GH_MAX_FILE_BYTES = 200_000;
/** Git-tree entries accepted per repository (larger trees are refused honestly). */
export const GH_MAX_TREE_ENTRIES = 4_000;
/** Files read from the repository per analysis. */
export const GH_MAX_READS_PER_ANALYSIS = 3;
/** Server-side quota: repository analyses per user per hour. */
export const GH_ANALYZE_LIMIT_PER_HOUR = 30;
/** OAuth state rows live this long (single-use, deleted on redemption). */
export const GH_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
/** A stored repair proposal (and its approval) expires after this. */
export const REPAIR_PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** PR branches are always NEW branches with this prefix — never the default. */
export const PR_BRANCH_PREFIX = "sitepulse/repair-";
export const GITHUB_API_BASE = "https://api.github.com";

/** Panel-level honesty statement for the GitHub Repair section. */
export const GITHUB_REPAIR_NOTICE =
  "Deterministic, read-only analysis: SitePulse reads only the files it needs from the repository you choose, using your own connection. Nothing is written to GitHub — and no pull request can be created — until you explicitly approve that specific proposal, and pull-request creation stays disabled on this deployment until write access is configured and verified. No AI model ran, no score changes, and nothing merges or deploys without your action on GitHub.";

/* ── Input validation (server calls these on every client argument) ────────── */

/** `owner/repo` — GitHub's charset, bounded. */
export function isValidRepoFullName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,140}$/.test(value)
  );
}

/**
 * Branch names: printable, no traversal, no ambiguity tricks. Used verbatim
 * in API paths, so anything outside the conservative charset is refused.
 */
export function isValidBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".")) {
    return false;
  }
  return true;
}

/** Repository paths: relative, printable, no traversal segments. */
export function isValidRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((s) => s.length > 0 && s !== "." && s !== "..");
}

/**
 * Secrets-shaped paths: NEVER read, even though the caller picked the repo.
 * Deliberately over-broad — our supported targets never match, so refusing
 * extra candidates only costs an honest "manual fix required".
 */
export function isSecretRepoPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|der|asc)$/.test(base)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return true;
  if (
    [
      "credentials",
      "credentials.json",
      "service-account.json",
      ".netrc",
      ".npmrc",
      ".htpasswd",
    ].includes(base)
  ) {
    return true;
  }
  return /(^|\/)(\.ssh|\.aws|\.gnupg)\//.test(lower);
}

/** Build outputs and vendored trees — never repair targets. */
const EXCLUDED_DIRS =
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|\.git|\.next|\.nuxt|\.svelte-kit|target)\//i;

/**
 * Same-origin return path for the OAuth round trip (never an open redirect):
 * must start with a single `/` and contain no scheme or protocol-relative form.
 */
export function isValidReturnPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 300 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    // eslint-disable-next-line no-control-regex -- no control characters in redirects
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

/* ── GitHub API responses (untrusted) ──────────────────────────────────────── */

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** True only when GitHub reports push permission for the connected user. */
  permissionsPush: boolean;
}

/** Sanitize a `git/trees/...?recursive=1` payload: valid, non-secret blobs only. */
export function sanitizeTree(json: unknown): { entries: TreeEntry[]; truncated: boolean } {
  const raw = (json as { tree?: unknown; truncated?: unknown } | null)?.tree;
  const truncated = (json as { truncated?: unknown } | null)?.truncated === true;
  if (!Array.isArray(raw)) return { entries: [], truncated: true }; // malformed ⇒ refuse honestly
  const entries: TreeEntry[] = [];
  for (const item of raw) {
    const path = (item as { path?: unknown })?.path;
    const type = (item as { type?: unknown })?.type;
    const size = (item as { size?: unknown })?.size;
    if (typeof path !== "string" || typeof type !== "string") continue;
    if (type !== "blob") continue;
    if (!isValidRepoPath(path) || isSecretRepoPath(path) || EXCLUDED_DIRS.test(path)) continue;
    entries.push({ path, type, ...(typeof size === "number" ? { size } : {}) });
    if (entries.length >= GH_MAX_TREE_ENTRIES) {
      return { entries, truncated: true }; // over budget ⇒ treat as truncated
    }
  }
  return { entries, truncated };
}

/** `/user/repos` payload → validated rows; malformed entries are dropped. */
export function parseRepos(json: unknown): RepoInfo[] {
  if (!Array.isArray(json)) return [];
  const out: RepoInfo[] = [];
  for (const item of json) {
    const o = item as Record<string, unknown>;
    const fullName = o?.full_name;
    const defaultBranch = o?.default_branch;
    if (!isValidRepoFullName(fullName) || typeof defaultBranch !== "string") continue;
    if (!isValidBranchName(defaultBranch)) continue;
    out.push({
      fullName,
      defaultBranch,
      private: o?.private === true,
      permissionsPush: (o?.permissions as { push?: unknown } | undefined)?.push === true,
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** `/repos/.../branches` payload → validated branch names. */
export function parseBranches(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const item of json) {
    const name = (item as { name?: unknown })?.name;
    if (isValidBranchName(name) && !out.includes(name)) out.push(name);
    if (out.length >= 100) break;
  }
  return out;
}

/** Base64-decode a contents-API payload (portable: no Node-only APIs). */
export function decodeBase64Utf8(b64: string): string | null {
  const cleaned = b64.replace(/\s+/g, "");
  if (
    cleaned.length === 0 ||
    cleaned.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)
  ) {
    return null;
  }
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

export type FileContentResult =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "malformed" };

/** `/repos/.../contents/<path>` payload → text, with the size cap enforced. */
export function parseFileContent(json: unknown): FileContentResult {
  const o = json as { content?: unknown; encoding?: unknown; size?: unknown } | null;
  if (!o || typeof o !== "object") return { ok: false, reason: "malformed" };
  if (typeof o.size === "number" && o.size > GH_MAX_FILE_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  if (o.encoding !== "base64" || typeof o.content !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const text = decodeBase64Utf8(o.content);
  if (text === null) return { ok: false, reason: "malformed" };
  if (text.length > GH_MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, text };
}

/* ── Target discovery ──────────────────────────────────────────────────────── */

const HTML_CANDIDATES = /(^|\/)index\.html$/i;
const ROBOTS_CANDIDATES = ["robots.txt", "public/robots.txt", "static/robots.txt"];
const HEADERS_CANDIDATES = ["_headers", "public/_headers", "static/_headers"];

// Build output is generated — never a repair target: editing it would be
// overwritten by the next build, and the fix belongs in a source file.
const BUILD_SEGMENTS = [
  "/dist/",
  "/build/",
  "/out/",
  "/.next/",
  "/node_modules/",
  "/vendor/",
  "/coverage/",
  "/.turbo/",
  "/.cache/",
];
function isBuildOutput(path: string): boolean {
  const p = path.startsWith("/") ? path : `/${path}`;
  return BUILD_SEGMENTS.some((s) => p.includes(s));
}

/** Mirrors SECURITY_HEADER_MESSAGE in recommendations.ts (same as fixProposal). */
const SECURITY_HEADER_MESSAGE = /^missing (.+?) header\.?$/i;

export function isSecurityHeaderIssue(issue: RecommendationIssue): boolean {
  return issue.category === "Security" && SECURITY_HEADER_MESSAGE.test(issue.message.trim());
}

/** Findings V2 can express as a safe, reviewable repository edit. */
export const HEAD_INSERT_MESSAGES = [
  "No title tag found.",
  "No meta description found.",
  "No viewport meta tag.",
  "Missing charset declaration.",
  "No canonical tag found.",
] as const;

export type TargetSelection =
  | { kind: "unsupported"; reason: string }
  /** Fetch this existing file (validated path) before applying the fix. */
  | { kind: "read"; path: string }
  /** Nothing to fetch — the fix creates this file. */
  | { kind: "create"; path: string };

function firstExisting(entries: TreeEntry[], preferred: string[]): string | null {
  for (const candidate of preferred) {
    if (entries.some((e) => e.path === candidate)) return candidate;
  }
  return null;
}

function hasTopLevelDir(entries: TreeEntry[], dir: string): boolean {
  return entries.some((e) => e.path.startsWith(`${dir}/`));
}

/**
 * Map one saved finding to a repository target. Deterministic; returns an
 * honest `unsupported` ("manual fix required") for everything else — including
 * server/hosting-panel fixes that do not live in a repository at all.
 */
export function selectRepairTarget(
  issue: RecommendationIssue,
  platform: HostingPlatform,
  entries: TreeEntry[],
): TargetSelection {
  // 1. Security headers → a _headers file, only when the repository proves it
  //    serves headers that way (the file exists) or the scan observed
  //    Netlify/Vercel (platforms that serve _headers).
  if (isSecurityHeaderIssue(issue)) {
    const existing = firstExisting(entries, HEADERS_CANDIDATES);
    if (existing) return { kind: "read", path: existing };
    if (platform === "netlify" || platform === "vercel") {
      return {
        kind: "create",
        path: hasTopLevelDir(entries, "public") ? "public/_headers" : "_headers",
      };
    }
    return {
      kind: "unsupported",
      reason:
        "This header is configured on the server or hosting platform, and this repository has no _headers file and the scan did not identify Netlify or Vercel. Configure the header in your hosting platform — manual fix required.",
    };
  }

  // 2. robots.txt → real file (create when absent).
  if (/robots\.txt/i.test(issue.message)) {
    const existing = firstExisting(entries, ROBOTS_CANDIDATES);
    if (existing) return { kind: "read", path: existing };
    return {
      kind: "create",
      path: hasTopLevelDir(entries, "public") ? "public/robots.txt" : "robots.txt",
    };
  }

  // 3. Head/doctype edits → the repository's own index.html (never a build copy).
  if (
    (HEAD_INSERT_MESSAGES as readonly string[]).includes(issue.message) ||
    /doctype declaration/i.test(issue.message)
  ) {
    const index = entries
      .filter((e) => HTML_CANDIDATES.test(e.path) && !isBuildOutput(e.path))
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
    if (index) return { kind: "read", path: index.path };
    return {
      kind: "unsupported",
      reason:
        "No source index.html was found in this repository (build outputs like dist/ are excluded), so the page edit has no safe target — manual fix required.",
    };
  }

  // 4. Explicitly unsupported, with honest reasons.
  if (/sitemap\.xml/i.test(issue.message)) {
    return {
      kind: "unsupported",
      reason:
        "A sitemap.xml must list the site's real URLs — generating one without crawling the site would invent them. Manual fix required.",
    };
  }
  return {
    kind: "unsupported",
    reason:
      "This finding's fix lives in server or hosting configuration (or needs page-specific judgment), not in a file this agent can edit safely — manual fix required.",
  };
}

/* ── Deterministic repair application ──────────────────────────────────────── */

export interface RepairPlanOk {
  kind: "ok";
  targetPath: string;
  existed: boolean;
  before: string;
  after: string;
  explanation: string;
}
export type RepairPlan = RepairPlanOk | { kind: "unsupported"; reason: string };

/** Strip V1's leading `<!-- Add … -->` instruction lines before inserting. */
function stripInstructionLines(code: string): string {
  const lines = code.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().startsWith("<!--") && lines[i].includes("-->")) i++;
  return lines.slice(i).join("\n").trimEnd();
}

/** Insert a block on its own line just before a marker line, matching indent. */
function insertBeforeMarker(before: string, marker: RegExp, block: string): string | null {
  const lines = before.split("\n");
  const index = lines.findIndex((l) => marker.test(l));
  if (index === -1) return null;
  const indent = /^[ \t]*/.exec(lines[index])?.[0] ?? "";
  const indented = block
    .split("\n")
    .map((l) => (l.trim().length === 0 ? l : indent + l))
    .join("\n");
  lines.splice(index, 0, indented);
  return lines.join("\n");
}

/** Insert a block right after the <head> opening line. */
function insertAfterHeadOpen(before: string, block: string): string | null {
  const lines = before.split("\n");
  const index = lines.findIndex((l) => /<head(\s[^>]*)?>/i.test(l) && !/<\/head>/i.test(l));
  if (index === -1) return null;
  const indent = (/^[ \t]*/.exec(lines[index])?.[0] ?? "") + "  ";
  const indented = block
    .split("\n")
    .map((l) => (l.trim().length === 0 ? l : indent + l))
    .join("\n");
  lines.splice(index + 1, 0, indented);
  return lines.join("\n");
}

const PLACEHOLDER_NOTE =
  "The inserted snippet keeps its placeholder text (SitePulse does not invent page titles or descriptions) — edit it to your real content before approving.";

/** Divergence guards: never "fix" a file that already has the thing. */
function headInsertGuard(message: string, targetPath: string, before: string): string | null {
  const divergence = (what: string): string =>
    `The repository's ${targetPath} already contains ${what} — the repository and the scan disagree; re-scan or reconcile manually.`;
  if (message === "No viewport meta tag." && /name\s*=\s*["']viewport["']/i.test(before)) {
    return divergence("a viewport meta tag");
  }
  if (message === "Missing charset declaration." && /<meta[^>]+charset/i.test(before)) {
    return divergence("a charset declaration");
  }
  if (message === "No meta description found." && /name\s*=\s*["']description["']/i.test(before)) {
    return divergence("a meta description");
  }
  if (message === "No title tag found." && /<title[\s>]/i.test(before)) {
    return divergence("a <title> tag");
  }
  if (message === "No canonical tag found." && /rel\s*=\s*["']canonical["']/i.test(before)) {
    return divergence("a canonical link tag");
  }
  return null;
}

/**
 * Apply the fix for one finding to the actual file text. Returns an honest
 * `unsupported` when the file diverges from what the scan saw, already
 * contains the fix, or the edit cannot be placed safely.
 */
export function applyRepair(args: {
  issue: RecommendationIssue;
  platform: HostingPlatform;
  scanOrigin: string;
  targetPath: string;
  existed: boolean;
  before: string;
}): RepairPlan {
  const { issue, platform, scanOrigin, targetPath, existed, before } = args;

  // ── Security headers → _headers file ──
  if (isSecurityHeaderIssue(issue)) {
    const header = headerFromIssue(issue);
    if (!header || !header.name || !header.value) {
      return {
        kind: "unsupported",
        reason: "The header directive could not be parsed from this finding — manual fix required.",
      };
    }
    const escaped = header.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`(^|\\n)[ \\t]*${escaped}:`, "i");
    if (existed && namePattern.test(before)) {
      return {
        kind: "unsupported",
        reason: `The repository's ${targetPath} already configures ${header.name} — the repository and the scan disagree; reconcile manually.`,
      };
    }
    const block = `/*\n  ${header.name}: ${header.value}`;
    let base = existed ? before : "";
    if (base.length > 0 && !base.endsWith("\n")) base += "\n";
    const separator = base.length > 0 && !base.endsWith("\n\n") ? "\n" : "";
    const after = `${base}${separator}${block}\n`;
    if (after === before) {
      return { kind: "unsupported", reason: "The edit would not change this file — manual fix required." };
    }
    return {
      kind: "ok",
      targetPath,
      existed,
      before,
      after,
      explanation: existed
        ? `The repository contains ${targetPath}, so the change is written in _headers format and appended as its own /* block with only the missing ${header.name} header. Review the name and value, then approve to request a pull request.`
        : `The scan observed ${
            platform === "unknown" ? "no specific platform" : platform
          } and this repository has no _headers file, so the proposal creates ${targetPath} containing the missing ${header.name} header. If your host does not serve a _headers file, decline and configure the header in your platform instead.`,
    };
  }

  // ── robots.txt ──
  if (/robots\.txt/i.test(issue.message)) {
    const directives = `# Added by SitePulse — review the Sitemap line below.\nUser-agent: *\nAllow: /\nSitemap: ${scanOrigin}/sitemap.xml`;
    if (existed) {
      if (/user-agent\s*:/i.test(before)) {
        return {
          kind: "unsupported",
          reason: `The repository's ${targetPath} already contains crawl directives — merging this safely needs your judgment (manual fix required).`,
        };
      }
      let base = before;
      if (base.length > 0 && !base.endsWith("\n")) base += "\n";
      const separator = base.length > 0 && !base.endsWith("\n\n") ? "\n" : "";
      const after = `${base}${separator}${directives}\n`;
      return {
        kind: "ok",
        targetPath,
        existed,
        before,
        after,
        explanation: `The existing ${targetPath} has no crawl directives, so the proposal appends a standard block. The Sitemap line points at the scanned site's own origin (${scanOrigin}) — adjust it if your sitemap lives elsewhere.`,
      };
    }
    return {
      kind: "ok",
      targetPath,
      existed: false,
      before,
      after: `${directives}\n`,
      explanation: `The repository has no ${targetPath}, so the proposal creates one with standard directives. The Sitemap line points at the scanned site's own origin (${scanOrigin}) — and a sitemap.xml still has to be added manually (see the sitemap finding).`,
    };
  }

  // ── DOCTYPE ──
  if (/doctype declaration/i.test(issue.message)) {
    if (/<!doctype\s+html/i.test(before)) {
      return {
        kind: "unsupported",
        reason: `The repository's ${targetPath} already declares a DOCTYPE — the repository and the scan disagree; re-scan or reconcile manually.`,
      };
    }
    const after = `<!DOCTYPE html>\n${before.replace(/^\uFEFF?(\r?\n)?/, "")}`;
    return {
      kind: "ok",
      targetPath,
      existed,
      before,
      after,
      explanation: `The proposal adds <!DOCTYPE html> as the first line of ${targetPath}.`,
    };
  }

  // ── Head inserts (title / description / viewport / charset / canonical) ──
  const guard = headInsertGuard(issue.message, targetPath, before);
  if (guard) return { kind: "unsupported", reason: guard };

  const snippet = buildSnippet(issue, platform);
  if (!snippet) {
    return {
      kind: "unsupported",
      reason: "The finding's evidence does not support a deterministic snippet — manual fix required.",
    };
  }
  const block = stripInstructionLines(snippet.code);
  if (!block) {
    return { kind: "unsupported", reason: "The snippet for this finding was empty — manual fix required." };
  }
  let after = insertBeforeMarker(before, /<\/head>/i, block);
  if (after === null) after = insertAfterHeadOpen(before, block);
  if (after === null) {
    return {
      kind: "unsupported",
      reason: `${targetPath} has no <head> section to edit safely — manual fix required.`,
    };
  }
  if (after === before) {
    return { kind: "unsupported", reason: "The edit would not change this file — manual fix required." };
  }
  return {
    kind: "ok",
    targetPath,
    existed,
    before,
    after,
    explanation: `The proposal inserts the snippet just before </head> in ${targetPath} (or right after <head> when the file has no closing head tag). ${PLACEHOLDER_NOTE}`,
  };
}

/* ── Real unified diff (prefix/suffix trimmed, one hunk with context) ──────── */

/**
 * Unified diff of `before → after`. Because V2 generated `after` by editing
 * `before`, the change is a single region: trim the common prefix/suffix and
 * emit one hunk with CONTEXT lines — a real diff, unlike V1's additions-only
 * preview (which never read the file). File creation emits the standard
 * `-0,0 +1,N` all-additions hunk.
 */
export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  const header =
    before.length === 0
      ? [`--- a/${path} (file does not exist yet)`, `+++ b/${path}`]
      : [`--- a/${path}`, `+++ b/${path}`];

  if (before.length === 0) {
    const bLines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");
    return [...header, `@@ -0,0 +1,${bLines.length} @@`, ...bLines.map((l) => `+${l}`)].join("\n");
  }

  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const oldLines = a.slice(start, endA + 1);
  const newLines = b.slice(start, endB + 1);
  const ctxBefore = a.slice(Math.max(0, start - context), start);
  const ctxAfter = a.slice(endA + 1, endA + 1 + context);

  const firstLine = start - ctxBefore.length + 1; // 1-based position of first shown line
  const oldCount = ctxBefore.length + oldLines.length + ctxAfter.length;
  const newCount = ctxBefore.length + newLines.length + ctxAfter.length;

  return [
    ...header,
    `@@ -${firstLine},${oldCount} +${firstLine},${newCount} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ].join("\n");
}

/* ── Pull-request text (deterministic; always states the safety rules) ─────── */

export function prTitleFor(findingMessage: string): string {
  const title = `SitePulse repair: ${findingMessage}`.replace(/\s+/g, " ").trim();
  return title.length > 120 ? `${title.slice(0, 117)}…` : title;
}

export function prBodyFor(args: {
  findingMessage: string;
  targetPath: string;
  explanation: string;
  scanUrl: string;
}): string {
  return [
    `### Finding`,
    ``,
    `${args.findingMessage}`,
    ``,
    `### Proposed change`,
    ``,
    `Target file: \`${args.targetPath}\``,
    ``,
    args.explanation,
    ``,
    `---`,
    `_Generated deterministically by SitePulse from the saved scan of ${args.scanUrl}. No AI model wrote this change, no score on the report changes, and nothing merges or deploys: review this diff and merge it yourself on GitHub (or close it)._`,
  ].join("\n");
}

/** Unique-ish suffix for the never-default repair branch. */
export function repairBranchName(now = Date.now(), random = Math.random()): string {
  return `${PR_BRANCH_PREFIX}${now.toString(36)}-${random.toString(36).slice(2, 6)}`;
}
