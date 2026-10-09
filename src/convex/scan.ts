"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Issue, Priority, Severity, CheckResult, CategoryScore, QuickWin, SSLInfo, CookieInfo, MixedContent, ServerInfo, SiteIdentity, ScanSummary } from "../types/scan";
import { scoreCategory, overallScore, CATEGORY_SCORE_FORMULA } from "../lib/scoring";
import { fetchTarget, detectBlock, isHtmlResponse } from "../lib/fetchTarget";
import { makeFinding, type FindingInput } from "../lib/findings";
import { detectSitePages } from "../lib/siteIdentity";
import tls from "node:tls";

// ── Helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── SSRF Protection ──────────────────────────────────────────────────

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".localhost") || h === "[::1]" ||
    h === "0.0.0.0" || h === "127.0.0.0" || h === "127.0.0.1" || h === "loopback"
  ) return true;
  if (
    h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan") ||
    h.endsWith(".home") || h.endsWith(".corp") || h.endsWith(".intranet") ||
    h.endsWith(".localdomain") || h.endsWith(".private") ||
    h === "metadata.google.internal" || h === "169.254.169.254"
  ) return true;
  const ip4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip4Match) {
    const [, a, b] = ip4Match.map(Number);
    if (
      a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) ||
      a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) || (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && +ip4Match[3] === 100) ||
      (a === 203 && b === 0 && +ip4Match[3] === 113) || a >= 224
    ) return true;
  }
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

async function isUrlSafe(urlStr: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(urlStr); } catch { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname;
  if (isPrivateHost(hostname)) return false;
  try {
    const dns = await import("node:dns");
    const addrs = await new Promise<string[]>((resolve, reject) => {
      dns.resolve4(hostname, (err: Error | null, addresses: string[]) => {
        if (err) {
          dns.resolve6(hostname, (err2: Error | null, a6: string[]) => {
            if (err2) reject(err2); else resolve(a6);
          });
        } else { resolve(addresses); }
      });
    });
    for (const addr of addrs) { if (isPrivateHost(addr)) return false; }
  } catch { /* DNS lookup failed — proceed */ }
  return true;
}

// ── Issue Builder ────────────────────────────────────────────────────

// ── Priority Assignment ──────────────────────────────────────────────

// Priorities are assigned where each finding is created (the call site knows
// the evidence); severityForPriority maps a priority onto a severity.
function severityForPriority(p: Priority): Severity {
  if (p === "critical") return "critical";
  if (p === "important") return "warning";
  return "info";
}

// ── Main Scan ────────────────────────────────────────────────────────

export const scanWebsite = action({
  args: { url: v.string(), visitorId: v.optional(v.string()) },
  handler: async (ctx, { url, visitorId }) => {
    // 0. Quota — checked before anything is sent to the target site, so a
    //    rejected visitor can never generate traffic against someone else's
    //    server. See src/convex/rateLimit.ts for the window and the limit.
    const quota = await ctx.runMutation(internal.rateLimit.consumeScanQuota, {
      visitorId,
    });
    if (!quota.allowed) {
      const minutes = Math.max(1, Math.ceil(quota.retryAfterMs / 60_000));
      throw new Error(
        `You've reached the scan limit (${quota.limit} scans per hour on the free tier). Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }

    // 1. Validate & normalize
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;
    let parsedUrl: URL;
    try { parsedUrl = new URL(normalizedUrl); } catch {
      throw new Error("Invalid URL. Please enter a valid website address.");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }
    if (!(await isUrlSafe(parsedUrl.href))) {
      throw new Error("This URL points to a private or restricted address and cannot be scanned.");
    }

    // 2. Tracking
    const issues: Issue[] = [];
    const performanceChecks: Record<string, CheckResult> = {};
    const seoChecks: Record<string, CheckResult> = {};
    const securityChecks: Record<string, CheckResult> = {};
    const accessibilityChecks: Record<string, CheckResult> = {};
    const technicalHealthChecks: Record<string, CheckResult> = {};

    const scannedAtMs = Date.now();
    let evidenceUrl = parsedUrl.href;
    // Every finding carries evidence: by default the message itself IS the
    // observation; pass `meta` to attach the exact evidence, stage, method,
    // check key or a "potential risk" (confirmed: false) marker.
    const addIssue = (
      cat: string, sev: Severity, pri: Priority, msg: string, why: string, fix: string,
      meta?: Partial<FindingInput>,
    ) => {
      issues.push(makeFinding({
        category: cat,
        severity: sev,
        priority: pri,
        message: msg,
        whyItMatters: why,
        howToFix: fix,
        evidence: msg,
        evidenceUrl,
        detectedAt: scannedAtMs,
        ...meta,
      }));
    };

    // 3. Controlled fetch — records requested URL, redirect chain, final URL,
    // status, response headers, content type and request duration.
    const outcome = await fetchTarget(parsedUrl.href, {
      maxRedirects: 10,
      timeoutMs: 12_000,
      maxBytes: 5 * 1024 * 1024,
      assertSafe: async (candidate) => {
        if (!(await isUrlSafe(candidate))) {
          throw new Error("Redirect target is a private or restricted address.");
        }
      },
    });
    if (!outcome.ok) throw new Error(outcome.message);

    const target = outcome.fetch;
    const status = target.status;
    const finalUrl = target.finalUrl;
    const responseTime = target.durationMs;
    const redirectChain = target.chain.map((hop) => hop.url);
    evidenceUrl = finalUrl;

    // 4. Inspect the FINAL response body (never assume the first URL served
    // the page) and decide what can actually be verified.
    const pageSize = target.bytes;
    const pageContent = target.body;
    const headers = target.headers;
    const headerSnapshot = target.headerSnapshot;

    const html = pageContent.toLowerCase();
    const hasHtml = html.includes("<html") || html.includes("<!doctype");

    // ── HTML attribute helpers ──────────────────────────────────────────
    // Real-world (especially minified) HTML writes attribute values WITHOUT
    // quotes: <html lang=en>, <meta name=viewport …>. Quoted-only regexes
    // mis-read those pages and emit false "missing attribute" findings, so
    // every attribute parser below accepts quoted and unquoted values.
    const attr = (name: string) =>
      `(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`;
    const attrLit = (name: string, value: string) =>
      `(?<![\\w-])${name}\\s*=\\s*(?:"${value}"|'${value}'|${value}(?=[\\s>/]))`;
    const grab = (m: RegExpMatchArray | null | undefined): string | undefined =>
      m ? (m[1] ?? m[2] ?? m[3])?.trim() || undefined : undefined;

    // ── Scan completeness: blocks, non-HTML, incomplete responses ────────
    const block = detectBlock(status, headerSnapshot, pageContent);
    const hardBlock = block !== null && block.kind !== "not-found";
    const notFound = block?.kind === "not-found";
    const notHtml = !isHtmlResponse(target.contentType, pageContent);
    const incomplete = target.truncated;
    // HTML-derived checks only run on a complete, successful HTML response.
    // Anything else is recorded as "Unable to Verify", never as a failure.
    const contentUsable = !hardBlock && !notHtml && !incomplete && status >= 200 && status < 400;

    const limitations: string[] = [];
    if (hardBlock && block) {
      limitations.push(`The scan was blocked: ${block.reason} Evidence: ${block.evidence}. Checks that depend on the page content or on the application's own response headers were marked "Unable to Verify" and are NOT reported as failures.`);
    }
    if (notFound) {
      limitations.push("The URL returned HTTP 404 (page not found). Content checks describe an error page, so only fetch-level checks were evaluated.");
    } else if (status >= 400 && !hardBlock) {
      limitations.push(`The final response was HTTP ${status}. Content checks were not run; only fetch-level checks were evaluated.`);
    } else if (status >= 300 && status < 400) {
      limitations.push(`The redirect chain ended on a redirect response (HTTP ${status}) instead of a final page, so content checks were not run.`);
    }
    if (notHtml) {
      limitations.push(`The final response is not an HTML document (content-type: ${target.contentType ?? "unknown"}). Content checks were not run.`);
    }
    if (incomplete) {
      limitations.push("The response body was incomplete when it arrived, so content checks were marked \"Unable to Verify\".");
    }

    // ══════════════════════════════════════════════════════════════════
    // PERFORMANCE SCORING (weighted)
    // ══════════════════════════════════════════════════════════════════

    // Response time: <500ms=100, 500-1000=80, 1000-2000=60, 2000-4000=40, >4000=20
    let rtScore: number;
    if (responseTime <= 500) rtScore = 100;
    else if (responseTime <= 1000) rtScore = 80;
    else if (responseTime <= 2000) rtScore = 60;
    else if (responseTime <= 4000) rtScore = 40;
    else rtScore = 20;

    if (rtScore >= 80) performanceChecks["response-time"] = "pass";
    else if (rtScore >= 60) performanceChecks["response-time"] = "warn";
    else performanceChecks["response-time"] = "fail";

    if (rtScore < 80) {
      const pri = rtScore < 40 ? "critical" : "recommended";
      addIssue("Performance", severityForPriority(pri), pri,
        `Response time is ${responseTime}ms.`,
        rtScore < 40
          ? "Slow load times frustrate visitors and hurt search rankings. Google uses page speed as a ranking factor, and users often leave sites that take more than 3 seconds to load."
          : "A faster response time improves user experience and can boost your search engine rankings.",
        rtScore < 40
          ? "Enable server-side caching (Redis, Memcached), use a CDN like Cloudflare, optimize database queries, and consider upgrading your hosting plan."
          : "Review server response times, enable gzip/brotli compression, and reduce server-side processing.",
        {
          checkKey: "response-time",
          stage: "fetch",
          evidence: `Single HTTP GET to ${finalUrl} completed in ${responseTime}ms (${redirectChain.length} redirect hop(s)). This is server response timing — not full page-load performance.`,
        },
      );
    }

    // Page size: <100KB=100, 100-500KB=80, 500KB-1MB=60, >1MB=40
    let psScore: number;
    if (pageSize <= 100 * 1024) psScore = 100;
    else if (pageSize <= 500 * 1024) psScore = 80;
    else if (pageSize <= 1024 * 1024) psScore = 60;
    else psScore = 40;

    if (psScore >= 80) performanceChecks["page-size"] = "pass";
    else if (psScore >= 60) performanceChecks["page-size"] = "warn";
    else performanceChecks["page-size"] = "fail";

    if (psScore < 80) {
      const pri = psScore < 60 ? "important" : "recommended";
      addIssue("Performance", severityForPriority(pri), pri,
        `Page HTML is ${formatBytes(pageSize)}.`,
        psScore < 60
          ? "Large HTML files slow down initial page rendering. Users on mobile connections will wait longer, and search engines may deprioritize slow pages."
          : "Reducing page size improves load times, especially on mobile networks.",
        "Minify HTML, remove unnecessary comments and whitespace, reduce inline styles and scripts, and move large content to external files.",
        {
          checkKey: "page-size",
          stage: "html",
          evidence: `The final HTML document is ${formatBytes(pageSize)} (${pageSize} bytes).`,
        },
      );
    }

    // Image count
    const imgMatches = html.match(/<img[\s>]/g);
    const imageCount = imgMatches ? imgMatches.length : 0;
    performanceChecks["image-count"] = imageCount > 0 ? "pass" : "na";

    // External resources
    const scriptMatches = html.match(/<script[\s>]/g);
    const styleMatches = html.match(/<style[\s>]/g);
    const linkStylesheetMatches = html.match(new RegExp(`(?<![\\w-])rel\\s*=\\s*(?:"stylesheet"|'stylesheet'|stylesheet(?=[\\s>/]))`, "gi"));
    const scriptCount = scriptMatches ? scriptMatches.length : 0;
    const styleCount = (styleMatches ? styleMatches.length : 0) + (linkStylesheetMatches ? linkStylesheetMatches.length : 0);
    const totalResources = scriptCount + styleCount;
    if (totalResources <= 10) performanceChecks["external-resources"] = "pass";
    else if (totalResources <= 20) performanceChecks["external-resources"] = "warn";
    else performanceChecks["external-resources"] = "fail";

    if (totalResources > 20) {
      addIssue("Performance", "warning", "recommended",
        `Too many external resources (${totalResources} scripts/stylesheets).`,
        "Each external resource requires a separate HTTP request, which adds to total load time. Too many scripts also block page rendering.",
        "Combine and minify CSS/JS files, remove unused code, load non-critical scripts asynchronously, and use a bundler like Vite or webpack.",
        { checkKey: "external-resources", stage: "html", evidence: `${scriptCount} <script> and ${styleCount} stylesheet/style blocks observed in the final HTML (total ${totalResources}).` },
      );
    } else if (totalResources > 10) {
      addIssue("Performance", "info", "nice-to-have",
        `${totalResources} external resources detected.`,
        "While not excessive, reducing external resources can further improve page load speed.",
        "Audit your scripts and stylesheets for unused code and remove or consolidate where possible.",
        { checkKey: "external-resources", stage: "html", evidence: `${scriptCount} <script> and ${styleCount} stylesheet/style blocks observed in the final HTML (total ${totalResources}).` },
      );
    }

    // Redirects
    if (redirectChain.length === 0) {
      performanceChecks["redirects"] = "pass";
    } else if (redirectChain.length <= 2) {
      performanceChecks["redirects"] = "warn";
      addIssue("Performance", "info", "nice-to-have",
        `Page redirects ${redirectChain.length} time(s).`,
        "Each redirect adds a full round-trip delay before the browser receives content.",
        "Link directly to the final URL. If you must redirect, aim for a single redirect at most.",
        { checkKey: "redirects", stage: "fetch", evidence: `${redirectChain.length} redirect(s) observed: ${[...redirectChain, finalUrl].join(" → ")}` },
      );
    } else {
      performanceChecks["redirects"] = "fail";
      addIssue("Performance", "warning", "recommended",
        `Too many redirects (${redirectChain.length}).`,
        "Multiple redirects create a chain of server delays. Each redirect adds 100-300ms of latency.",
        "Point users directly to the final URL. Audit your redirect rules and eliminate unnecessary hops.",
        { checkKey: "redirects", stage: "fetch", evidence: `${redirectChain.length} redirects observed: ${[...redirectChain, finalUrl].join(" → ")}` },
      );
    }

    // HTTP status (performance component)
    if (status >= 200 && status < 300) {
      performanceChecks["http-status"] = "pass";
    } else if (status >= 300 && status < 400) {
      performanceChecks["http-status"] = "warn";
    } else {
      performanceChecks["http-status"] = "fail";
    }

    // ══════════════════════════════════════════════════════════════════
    // SEO SCORING (weighted)
    // ══════════════════════════════════════════════════════════════════

    const titleMatch = pageContent.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || undefined;
    const titleLength = title?.length ?? 0;

    // Title: exists+30-60=100, exists+wrong length=70, missing=0
    let titleScore: number;
    if (title && titleLength >= 30 && titleLength <= 60) titleScore = 100;
    else if (title && titleLength > 0) titleScore = 70;
    else titleScore = 0;

    if (titleScore === 100) seoChecks["title"] = "pass";
    else if (titleScore > 0) seoChecks["title"] = "warn";
    else seoChecks["title"] = "fail";

    if (titleScore < 100) {
      const pri = titleScore === 0 ? "important" : "recommended";
      addIssue("SEO", severityForPriority(pri), pri,
        title ? `Title tag is ${titleLength} characters.` : "No title tag found.",
        title
          ? "Your title appears in search results and browser tabs. The wrong length means it may be truncated or not fully utilized for SEO."
          : "The title tag is one of the most important SEO elements. Search engines use it to understand what the page is about, and it's the first thing users see in search results.",
        title
          ? `Adjust your title to 30–60 characters. Current: "${title.slice(0, 50)}${title.length > 50 ? "…" : ""}"`
          : "Add a <title> tag inside your <head> that accurately describes the page in 30–60 characters.",
        {
          checkKey: "title",
          stage: "html",
          evidence: title
            ? `Observed <title> in the final HTML: "${title}" (${titleLength} characters).`
            : "No <title> element found in the final HTML document.",
        },
      );
    }

    const descMatch =
      pageContent.match(new RegExp(`<meta\\s[^>]*${attrLit("name", "description")}[^>]*${attr("content")}`, "i")) ||
      pageContent.match(new RegExp(`<meta\\s[^>]*${attr("content")}[^>]*${attrLit("name", "description")}`, "i"));
    const description = grab(descMatch);
    const descriptionLength = description?.length ?? 0;

    // Meta description: exists+120-160=100, exists+wrong=60, missing=0
    let descScore: number;
    if (description && descriptionLength >= 120 && descriptionLength <= 160) descScore = 100;
    else if (description && descriptionLength > 0) descScore = 60;
    else descScore = 0;

    if (descScore === 100) seoChecks["meta-description"] = "pass";
    else if (descScore > 0) seoChecks["meta-description"] = "warn";
    else seoChecks["meta-description"] = "fail";

    if (descScore < 100) {
      const pri = descScore === 0 ? "important" : "recommended";
      addIssue("SEO", severityForPriority(pri), pri,
        description ? `Meta description is ${descriptionLength} characters.` : "No meta description found.",
        description
          ? "Search engines display 150–160 characters in results. A description that's too short or too long won't be fully shown, reducing click-through rates."
          : "The meta description appears under your title in search results. Without one, Google generates its own snippet, which may not represent your content well.",
        description
          ? "Adjust your meta description to 120–160 characters for optimal display in search results."
          : 'Add <meta name="description" content="Your compelling 120–160 character description"> inside your <head>.',
        {
          checkKey: "meta-description",
          stage: "html",
          evidence: description
            ? `Observed meta description (${descriptionLength} characters): "${description.slice(0, 100)}${descriptionLength > 100 ? "…" : ""}"`
            : 'No <meta name="description"> found in the final HTML document.',
        },
      );
    }

    const h1Matches = html.match(/<h1[\s>]/g);
    const h1Count = h1Matches ? h1Matches.length : 0;

    // H1: exactly 1=100, multiple=50, missing=0
    let h1Score: number;
    if (h1Count === 1) h1Score = 100;
    else if (h1Count > 1) h1Score = 50;
    else h1Score = 0;

    if (h1Score === 100) seoChecks["h1-tag"] = "pass";
    else if (h1Score > 0) seoChecks["h1-tag"] = "warn";
    else seoChecks["h1-tag"] = "fail";

    if (h1Score < 100) {
      const pri = h1Score === 0 ? "important" : "recommended";
      addIssue("SEO", severityForPriority(pri), pri,
        h1Count === 0 ? "No H1 tag found." : `Found ${h1Count} H1 tags.`,
        h1Count === 0
          ? "The H1 tag tells search engines the main topic of the page. Without it, search engines may struggle to understand your content hierarchy."
          : "Multiple H1 tags confuse search engines about the primary topic of the page. Each page should have exactly one H1.",
        h1Count === 0
          ? 'Add exactly one <h1> tag that clearly describes the page content.'
          : "Keep only the most important heading as H1 and convert the others to H2 or H3.",
        { checkKey: "h1-tag", stage: "html", evidence: `${h1Count} <h1> element(s) found in the final HTML document.` },
      );
    }

    const headingMatches = html.match(/<h[1-6][\s>]/g);
    const headingCount = headingMatches ? headingMatches.length : 0;

    // Heading hierarchy: proper H1→H2=100, minor issues=70, no structure=30
    let headingScore: number;
    if (h1Count >= 1 && headingCount >= 3) headingScore = 100;
    else if (h1Count >= 1 && headingCount >= 2) headingScore = 70;
    else if (h1Count >= 1) headingScore = 70;
    else if (headingCount > 0) headingScore = 30;
    else headingScore = 30;

    if (headingScore >= 70) seoChecks["heading-structure"] = "pass";
    else seoChecks["heading-structure"] = "warn";

    if (headingScore < 70) {
      addIssue("SEO", "info", "nice-to-have",
        "Heading hierarchy could be improved.",
        "Proper heading structure (H1 → H2 → H3) helps search engines understand content hierarchy and improves accessibility for screen readers.",
        "Use H2 tags for main sections and H3 tags for subsections within each section.",
      );
    }

    // Canonical: present=100, missing=50
    const canonicalMatch =
      pageContent.match(new RegExp(`<link\\s[^>]*${attrLit("rel", "canonical")}[^>]*${attr("href")}`, "i")) ||
      pageContent.match(new RegExp(`<link\\s[^>]*${attr("href")}[^>]*${attrLit("rel", "canonical")}`, "i"));
    const canonicalUrl = grab(canonicalMatch);
    seoChecks["canonical-tag"] = canonicalUrl ? "pass" : "warn";

    if (!canonicalUrl) {
      addIssue("SEO", "info", "recommended",
        "No canonical tag found.",
        "Without a canonical tag, search engines may index duplicate versions of the same page (with/without www, trailing slashes, etc.), diluting your SEO authority.",
        'Add <link rel="canonical" href="https://yourdomain.com/page"> inside your <head> to point to the preferred version of the page.',
        { checkKey: "canonical-tag", stage: "html", evidence: "No <link rel=\"canonical\"> element found in the final HTML document." },
      );
    }

    // Robots meta
    const robotsMetaMatch = html.match(new RegExp(`<meta\\s[^>]*${attrLit("name", "robots")}[^>]*${attr("content")}`, "i"));
    const robotsMetaContent = (grab(robotsMetaMatch) || "").toLowerCase();
    const hasRobotsMeta = robotsMetaContent.length > 0;
    if (!hasRobotsMeta || !robotsMetaContent.includes("noindex")) {
      seoChecks["robots-meta"] = "pass";
    } else {
      seoChecks["robots-meta"] = "fail";
      addIssue("SEO", "critical", "critical",
        'Page has a "noindex" robots meta tag.',
        "The noindex directive tells search engines to exclude this page from search results. If this is unintentional, your page will be invisible to anyone searching for it.",
        'Remove the noindex directive from your robots meta tag, or change it to <meta name="robots" content="index, follow">.',
        { checkKey: "robots-meta", stage: "html", evidence: `Observed <meta name="robots" content="${robotsMetaContent}"> in the final HTML document.` },
      );
    }

    // Sitemap & robots.txt
    // Probe origin: use the FINAL URL's origin — if the site redirected to a
    // different host/scheme, robots.txt belongs there, not at the old origin.
    const origin = new URL(finalUrl).origin;
    let robotsTxtAvailable: boolean | null = null;
    let sitemapXmlAvailable: boolean | null = null;

    try {
      const robotsResp = await fetch(`${origin}/robots.txt`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(5_000) });
      if (robotsResp.status === 200) {
        robotsTxtAvailable = true;
        seoChecks["robots-txt"] = "pass";
      } else if (robotsResp.status === 403 || robotsResp.status === 429 || robotsResp.status >= 500) {
        // The probe itself was refused → Unable to Verify, not a failure.
        robotsTxtAvailable = null;
        seoChecks["robots-txt"] = "not-checked";
      } else {
        robotsTxtAvailable = false;
        seoChecks["robots-txt"] = "warn";
        addIssue("SEO", "info", "nice-to-have",
          "No robots.txt file found.",
          "A robots.txt file helps search engines understand which pages to crawl. While not strictly required, it's considered best practice.",
          'Create a robots.txt file at your site root (e.g., https://yourdomain.com/robots.txt) with basic crawl directives.',
          { checkKey: "robots-txt", stage: "origin-probe", evidence: `GET ${origin}/robots.txt returned HTTP ${robotsResp.status}.` },
        );
      }
    } catch {
      robotsTxtAvailable = null;
      seoChecks["robots-txt"] = "not-checked";
    }

    try {
      const sitemapResp = await fetch(`${origin}/sitemap.xml`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(5_000) });
      if (sitemapResp.status === 200) {
        sitemapXmlAvailable = true;
        seoChecks["sitemap-xml"] = "pass";
      } else if (sitemapResp.status === 403 || sitemapResp.status === 429 || sitemapResp.status >= 500) {
        sitemapXmlAvailable = null;
        seoChecks["sitemap-xml"] = "not-checked";
      } else {
        sitemapXmlAvailable = false;
        seoChecks["sitemap-xml"] = "warn";
        addIssue("SEO", "info", "nice-to-have",
          "No sitemap.xml found.",
          "A sitemap helps search engines discover all your pages, especially for large sites or pages not well-linked internally.",
          'Generate a sitemap.xml and submit it to Google Search Console and Bing Webmaster Tools.',
          { checkKey: "sitemap-xml", stage: "origin-probe", evidence: `GET ${origin}/sitemap.xml returned HTTP ${sitemapResp.status}.` },
        );
      }
    } catch {
      sitemapXmlAvailable = null;
      seoChecks["sitemap-xml"] = "not-checked";
    }

    // ══════════════════════════════════════════════════════════════════
    // SECURITY SCORING (points-based)
    // ══════════════════════════════════════════════════════════════════

    // HTTPS: +20
    const isHttps = finalUrl.startsWith("https://");
    securityChecks["https"] = isHttps ? "pass" : "fail";
    if (!isHttps) {
      addIssue("Security", "critical", "critical",
        "Website does not use HTTPS.",
        "Without HTTPS, all data between your server and visitors is transmitted in plain text. Login credentials, personal data, and cookies can be intercepted by attackers. Modern browsers warn users about non-HTTPS sites.",
        "Install a free SSL certificate from Let's Encrypt, configure your web server to redirect HTTP to HTTPS, and update all internal links to use HTTPS.",
        { checkKey: "https", stage: "fetch", evidence: `The final URL ${finalUrl} uses plain http://.` },
      );
    }

    // HTTP→HTTPS redirect — only evaluated when an HTTP URL was actually
    // requested. Requesting HTTPS does not prove HTTP upgrades, so that case
    // is Not Applicable instead of an evidence-free "pass".
    if (parsedUrl.protocol === "http:") {
      const upgraded = finalUrl.startsWith("https://");
      securityChecks["http-to-https-redirect"] = upgraded ? "pass" : "fail";
      if (!upgraded) {
        addIssue("Security", "warning", "important",
          "HTTP requests are not upgraded to HTTPS.",
          "Without an HTTP→HTTPS redirect, visitors who reach the plain-HTTP version of your site stay on an unencrypted connection.",
          "Configure your server to 301-redirect all http:// requests to https://.",
          {
            checkKey: "http-to-https-redirect",
            stage: "fetch",
            evidence: `Requested ${parsedUrl.href} and ended at ${finalUrl} with HTTP ${status} — no upgrade to HTTPS observed.`,
          },
        );
      }
    } else {
      securityChecks["http-to-https-redirect"] = "na";
    }

    // Security headers — inspected on the FINAL response's headers only.
    const securityHeaderDefs = [
      { name: "Content-Security-Policy", key: "csp", label: "Content-Security-Policy", points: 20 },
      { name: "Strict-Transport-Security", key: "hsts", label: "Strict-Transport-Security (HSTS)", points: 15 },
      { name: "X-Content-Type-Options", key: "xcto", label: "X-Content-Type-Options", points: 15 },
      { name: "X-Frame-Options", key: "xfo", label: "X-Frame-Options", points: 15 },
      { name: "Referrer-Policy", key: "rp", label: "Referrer-Policy", points: 15 },
      { name: "Permissions-Policy", key: "pp", label: "Permissions-Policy", points: 10 },
      { name: "X-Permitted-Cross-Domain-Policies", key: "xpcdp", label: "X-Permitted-Cross-Domain-Policies", points: 10 },
    ];

    // Helper: check if a security header is declared via <meta http-equiv> in the HTML.
    // Per the HTML spec, ONLY Content-Security-Policy is valid via <meta http-equiv>.
    // All other security headers MUST be delivered as HTTP response headers.
    // Browser support: CSP meta-equiv works in all modern browsers (with minor
    // limitations like no frame-ancestors/report-uri). No other security header
    // has a valid meta-equiv equivalent.
    function hasMetaEquivCSP(): boolean {
      return new RegExp(`<meta\\s[^>]*${attrLit("http-equiv", "content-security-policy")}[^>]*>`, "i").test(pageContent);
    }

    const headerIssues: Array<{ key: string; header: typeof securityHeaderDefs[0] }> = [];
    for (const sh of securityHeaderDefs) {
      // Only CSP has a valid <meta http-equiv> fallback per the HTML spec.
      // All other security headers must be delivered as actual HTTP response headers.
      const isHttpHeaderPresent = !!headers.get(sh.name);
      const isMetaFallback = sh.key === "csp" && hasMetaEquivCSP();
      const present = isHttpHeaderPresent || isMetaFallback;
      securityChecks[`header-${sh.key}`] = present ? "pass" : "fail";
      if (!present) {
        headerIssues.push({ key: `header-${sh.key}`, header: sh });
      }
    }

    // Emit findings for missing headers. A missing header is an *observed
    // configuration gap*, never a demonstrated vulnerability: each finding is
    // reported as a hardening recommendation (confirmed: false,
    // status: "warning") so the report lists it under "Potential risk"\    // instead of claiming a confirmed XSS / SSL-stripping / clickjacking bug.
    // The check itself still fails, so the Security score keeps reflecting the
    // absent control — only the claim changes, not the measurement.
    for (const { key, header } of headerIssues) {
      // Severity review: no missing header is critical on its own. CSP and
      // HSTS matter most, so they stay "important"; the rest are lower.
      const pri: Priority =
        header.key === "csp" || header.key === "hsts"
          ? "important"
          : header.key === "xfo" || header.key === "xcto"
            ? "recommended"
            : "nice-to-have";

      const explanations: Record<string, { why: string; fix: string }> = {
        csp: {
          why: "A Content-Security-Policy tells the browser which script and resource origins are allowed. It is the main defence in depth against cross-site scripting (XSS): if an injection bug exists anywhere on the site, a CSP stops many payloads from running. This scan observed that the header is absent — it did not find an exploitable XSS vulnerability, and an absent header on its own does not prove one exists.",
          fix: 'Add a Content-Security-Policy header. Start with a basic policy: Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'.',
        },
        hsts: {
          why: "Strict-Transport-Security tells browsers to always use HTTPS for your site, protecting first-time visitors from SSL stripping on an unencrypted connection. This scan observed that the header is absent — it did not test for an active SSL-stripping attack, so no vulnerability is being claimed here.",
          fix: 'Add the header: Strict-Transport-Security: max-age=31536000; includeSubDomains. Start with a short max-age and increase over time.',
        },
        xcto: {
          why: "Without this header, browsers may MIME-sniff responses and execute content as a different type than declared, potentially enabling code execution attacks.",
          fix: "Add the header: X-Content-Type-Options: nosniff",
        },
        xfo: {
          why: "Without X-Frame-Options, attackers can embed your page in an invisible iframe and trick users into clicking things they didn't intend (clickjacking).",
          fix: "Add the header: X-Frame-Options: DENY (or SAMEORIGIN if you need to frame your own content).",
        },
        rp: {
          why: "Without Referrer-Policy, browsers send full URLs as referrer information to other sites, potentially exposing sensitive page paths or query parameters.",
          fix: 'Add the header: Referrer-Policy: strict-origin-when-cross-origin',
        },
        pp: {
          why: "Without Permissions-Policy, the browser grants default access to features like camera, microphone, and geolocation that your site may not need.",
          fix: 'Add the header: Permissions-Policy: camera=(), microphone=(), geolocation=()',
        },
        xpcdp: {
          why: "Without this header, Flash and PDF objects on your site may load cross-domain content without restrictions.",
          fix: "Add the header: X-Permitted-Cross-Domain-Policies: none",
        },
      };

      const e = explanations[header.key] || { why: "This security header helps protect your site.", fix: `Add the ${header.label} header to your server configuration.` };
      addIssue("Security", severityForPriority(pri), pri,
        `Missing ${header.label} header.`,
        `${e.why} What this does not mean: nothing was exploited — the scan only observed that the header was missing from this response.`,
        e.fix,
        {
          checkKey: key,
          stage: "headers",
          // Hardening recommendation, not a confirmed vulnerability.
          status: "warning",
          confirmed: false,
          evidence: `${header.label} was not present in the response headers of ${finalUrl} (HTTP ${status}).`,
        },
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // ACCESSIBILITY — evidence-based checks only. The category score comes
    // from the shared applicable-only formula below, so one failing check can
    // no longer zero the whole category (the old per-image point deduction).
    // Evidence source: static final HTML. A browser-rendered DOM is NOT
    // available in this environment — see summary.browserChecks.
    // ══════════════════════════════════════════════════════════════════

    const imgNoAlt = html.match(/<img\s(?![^>]*(?<![\w-])alt\s*=)[^>]*>/g);
    const imagesWithoutAlt = imgNoAlt ? imgNoAlt.length : 0;
    if (imageCount === 0) {
      accessibilityChecks["image-alt"] = "na"; // page has no images to evaluate
    } else if (imagesWithoutAlt === 0) {
      accessibilityChecks["image-alt"] = "pass";
    } else {
      accessibilityChecks["image-alt"] = "fail";
      addIssue("Accessibility",
        imagesWithoutAlt > 3 ? "critical" : "warning",
        imagesWithoutAlt > 3 ? "important" : "recommended",
        `${imagesWithoutAlt} of ${imageCount} image(s) are missing alt text.`,
        "Screen readers cannot describe images without alt text, making your site unusable for visually impaired visitors. Search engines also use alt text to understand image content.",
        'Add descriptive alt attributes to each image: <img src="photo.jpg" alt="Description of the image">',
        {
          checkKey: "image-alt",
          stage: "html",
          evidence: `${imagesWithoutAlt} of ${imageCount} <img> elements in the final HTML have no alt attribute.`,
        },
      );
    }

    const hasLanguage = !!grab(pageContent.match(new RegExp(`<html\\s+[^>]*${attr("lang")}`, "i")));
    if (hasLanguage) {
      accessibilityChecks["html-lang"] = "pass";
    } else {
      accessibilityChecks["html-lang"] = "fail";
      addIssue("Accessibility", "warning", "recommended",
        'The <html> tag is missing a lang attribute.',
        "Screen readers use the lang attribute to select the correct pronunciation. Without it, visually impaired users hear content read in the wrong language.",
        'Add the lang attribute to your HTML tag: <html lang="en">',
        {
          checkKey: "html-lang",
          stage: "html",
          evidence: "The <html> tag in the final HTML document has no lang attribute.",
        },
      );
    }

    const inputMatches = html.match(/<input\s+[^>]*(?:type=["'](?:text|email|password|search|tel|url|number)["'])?[^>]*>/gi) || [];
    const labelMatches = html.match(/<label[\s>]/gi) || [];
    const labelForMatches = html.match(new RegExp(`(?<![\\w-])for\\s*=\\s*(?:"[^"]+"|'[^']+'|[^\\s>]+)`, "gi")) || [];
    const hasFormLabels = labelMatches.length > 0 || labelForMatches.length > 0;
    const inputsWithoutLabels = inputMatches.length > 0 && !hasFormLabels ? inputMatches.length : 0;

    if (inputMatches.length === 0) {
      accessibilityChecks["form-labels"] = "na"; // no form inputs on this page
    } else if (inputsWithoutLabels === 0) {
      accessibilityChecks["form-labels"] = "pass";
    } else {
      accessibilityChecks["form-labels"] = "warn";
      addIssue("Accessibility", "warning", "recommended",
        `${inputsWithoutLabels} form input(s) may be missing associated labels.`,
        "Without labels, screen readers cannot tell users what each form field is for. This makes forms unusable for visually impaired visitors.",
        'Associate each input with a label: <label for="email">Email</label> <input id="email" type="email">',
        {
          checkKey: "form-labels",
          stage: "html",
          // Heuristic: aria-label/aria-labelledby cannot be fully evaluated
          // without a browser, so this stays a potential risk, not a failure.
          confirmed: false,
          evidence: `${inputsWithoutLabels} of ${inputMatches.length} <input> elements have no <label> or for= association anywhere in the final HTML (aria-label/aria-labelledby not evaluated — no browser engine).`,
        },
      );
    }

    // No derived "overall" check: it would double-count the same evidence.
    // The category score is computed from the checks above by the formula.

    // ══════════════════════════════════════════════════════════════════
    // TECHNICAL SCORING (points-based)
    // ══════════════════════════════════════════════════════════════════

    // (No per-item point system here: status is derived from observed values;
    // the category score is computed later by the shared formula.)

    // Valid HTML structure: 30 points
    const hasDoctype = pageContent.toLowerCase().includes("<!doctype");
    const hasCharset =
      new RegExp(`<meta\\s[^>]*${attr("charset")}`, "i").test(pageContent) ||
      new RegExp(`<meta\\s[^>]*${attrLit("http-equiv", "content-type")}`, "i").test(pageContent);
    if (hasDoctype && hasCharset) {
      technicalHealthChecks["html-structure"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["html-structure"] = "not-checked";
    } else {
      technicalHealthChecks["html-structure"] = "warn";
      addIssue("Technical Health", "info", "nice-to-have",
        !hasDoctype ? "Missing DOCTYPE declaration." : "Missing charset declaration.",
        !hasDoctype
          ? "Without a DOCTYPE, browsers render the page in quirks mode, which can cause inconsistent layouts across browsers."
          : "Without a charset declaration, text may display incorrectly, especially special characters and non-English text.",
        !hasDoctype
          ? "Add <!DOCTYPE html> as the first line of your HTML file."
          : 'Add <meta charset="utf-8"> inside your <head>.',
      );
    }

    // Viewport: 20 points
    const hasViewport = new RegExp(`<meta\\s[^>]*${attrLit("name", "viewport")}`, "i").test(pageContent);
    if (hasViewport) {
      technicalHealthChecks["viewport"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["viewport"] = "not-checked";
    } else {
      technicalHealthChecks["viewport"] = "fail";
      addIssue("Technical Health", "critical", "important",
        "No viewport meta tag.",
        "Without a viewport tag, your site won't scale correctly on mobile devices. Over 50% of web traffic is mobile, and Google uses mobile-first indexing.",
        'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside your <head>.',
      );
    }

    // Charset: 20 points
    if (hasCharset) {
      technicalHealthChecks["charset"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["charset"] = "not-checked";
    } else {
      technicalHealthChecks["charset"] = "warn";
    }

    // Canonical: 15 points
    if (canonicalUrl) {
      technicalHealthChecks["canonical"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["canonical"] = "not-checked";
    } else {
      technicalHealthChecks["canonical"] = "warn";
    }

    // Clean URL: 15 points (no query params, no excessive path segments)
    const urlPath = parsedUrl.pathname;
    const hasCleanUrls = !parsedUrl.search && urlPath.split("/").filter(Boolean).length <= 4;
    if (hasCleanUrls) {
      technicalHealthChecks["clean-urls"] = "pass";
    } else {
      technicalHealthChecks["clean-urls"] = "warn";
      if (parsedUrl.search) {
        addIssue("Technical Health", "info", "nice-to-have",
          "URL contains query parameters.",
          "Query parameters can cause duplicate content issues and make URLs harder to share and remember.",
          "Use clean, descriptive URLs instead of query strings. For example, use /products/shoes instead of /products?id=123&cat=shoes.",
        );
      }
    }

    // HTTP status (technical component)
    if (status >= 200 && status < 300) {
      technicalHealthChecks["http-status"] = "pass";
    } else if (status >= 300 && status < 400) {
      technicalHealthChecks["http-status"] = "warn";
      addIssue("Technical Health", "warning", "recommended",
        `Final response was a redirect (HTTP ${status}).`,
        "If the redirect chain doesn't resolve properly, users and search engines may not reach your intended page.",
        "Ensure the redirect chain resolves to a final 200 OK page. Update internal links to point to the final URL.",
        { checkKey: "http-status", stage: "fetch", evidence: `The request to ${parsedUrl.href} ended on HTTP ${status} after ${redirectChain.length} redirect(s); final URL: ${finalUrl}.` },
      );
    } else if (status === 404) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        "Page returned 404 Not Found.",
        "A 404 error means the page doesn't exist. Visitors who land here will leave immediately, and search engines will eventually drop the page from their index.",
        "Verify the URL is correct. If the page was moved, set up a 301 redirect to the new location.",
        { checkKey: "http-status", stage: "fetch", evidence: `GET ${finalUrl} returned HTTP 404 Not Found.` },
      );
    } else if (status === 500) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        "Server returned 500 Internal Server Error.",
        "A 500 error means your server crashed or encountered an unhandled error. The page is completely inaccessible to users and search engines.",
        "Check your server logs for the specific error. Common causes include database connection failures, PHP errors, or misconfigured server software.",
        { checkKey: "http-status", stage: "fetch", evidence: `GET ${finalUrl} returned HTTP 500 Internal Server Error.` },
      );
    } else if (status >= 400) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        `Server returned HTTP ${status}.`,
        "This HTTP status code indicates a server-side error that prevents the page from loading correctly.",
        "Investigate the server logs to identify and fix the root cause of this error.",
        { checkKey: "http-status", stage: "fetch", evidence: `GET ${finalUrl} returned HTTP ${status}.` },
      );
    } else {
      technicalHealthChecks["http-status"] = "not-checked";
    }

    // Redirect count (technical)
    if (redirectChain.length === 0) {
      technicalHealthChecks["redirect-count"] = "pass";
    } else if (redirectChain.length <= 2) {
      technicalHealthChecks["redirect-count"] = "pass";
    } else {
      technicalHealthChecks["redirect-count"] = "fail";
    }

    // ══════════════════════════════════════════════════════════════════
    // SSL CERTIFICATE ANALYSIS
    // ══════════════════════════════════════════════════════════════════

    let sslInfo: SSLInfo | null = null;
    let sslScore = 0;

    if (isHttps) {
      try {
        const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
          const socket = tls.connect({ host: parsedUrl.hostname, port: 443, servername: parsedUrl.hostname, rejectUnauthorized: false, timeout: 5000 }, () => {
            const peerCert = socket.getPeerCertificate();
            socket.end();
            if (peerCert && peerCert.valid_from) resolve(peerCert);
            else reject(new Error("No certificate"));
          });
          socket.on("error", reject);
          socket.on("timeout", () => { socket.destroy(); reject(new Error("Timeout")); });
        });

        const expiryDate = new Date(cert.valid_to);
        const daysUntilExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        const issuer = String(cert.issuer?.CN || cert.issuer?.O || "Unknown");
        const serialNumber = cert.serialNumber || "";
        const subjectAltNames: string[] = [];
        if (cert.subjectaltname) {
          subjectAltNames.push(...cert.subjectaltname.split(",").map((s: string) => s.trim().replace(/^DNS:/, "")));
        }

        sslInfo = {
          valid: daysUntilExpiry > 0,
          issuer,
          expiryDate: expiryDate.toISOString(),
          daysUntilExpiry,
          serialNumber,
          subjectAltNames,
        };

        // SSL scoring: valid=+10, expiring<30d=+5, expired=0
        if (daysUntilExpiry > 30) {
          sslScore = 100;
          securityChecks["ssl-valid"] = "pass";
        } else if (daysUntilExpiry > 0) {
          sslScore = 50;
          securityChecks["ssl-valid"] = "warn";
        } else {
          sslScore = 0;
          securityChecks["ssl-valid"] = "fail";
        }

        if (daysUntilExpiry <= 0) {
          addIssue("Security", "critical", "critical",
            "SSL certificate has expired.",
            "An expired certificate causes browser warnings and breaks trust with visitors. Most users will see a security warning and leave immediately.",
            "Renew your SSL certificate immediately. Consider using auto-renewal services like Let's Encrypt to prevent future expirations.",
            {
              checkKey: "ssl-valid",
              stage: "tls",
              method: "tls",
              evidence: `Certificate for ${parsedUrl.hostname} expired on ${expiryDate.toISOString()} (issuer: ${issuer}).`,
            },
          );
        } else if (daysUntilExpiry <= 30) {
          addIssue("Security", "warning", "important",
            `SSL certificate expires in ${daysUntilExpiry} days (${expiryDate.toLocaleDateString()}).`,
            "An expiring certificate will soon trigger browser warnings, breaking trust with your visitors.",
            "Renew your SSL certificate before it expires. Enable auto-renewal to prevent future issues.",
            {
              checkKey: "ssl-valid",
              stage: "tls",
              method: "tls",
              evidence: `Certificate for ${parsedUrl.hostname} is valid until ${expiryDate.toISOString()} — ${daysUntilExpiry} day(s) remaining (issuer: ${issuer}).`,
            },
          );
        }
      } catch (err) {
        sslScore = 0;
        // The certificate could not be inspected → Unable to Verify, not a failure.
        securityChecks["ssl-valid"] = "not-checked";
        addIssue("Security", "warning", "important",
          "Could not verify SSL certificate.",
          "The certificate could not be inspected from this environment, so no conclusion about the certificate is drawn.",
          "Verify your SSL certificate is properly installed and the server is reachable on port 443.",
          {
            checkKey: "ssl-valid",
            stage: "tls",
            method: "tls",
            status: "unable-to-verify",
            confirmed: false,
            evidence: `TLS handshake with ${parsedUrl.hostname}:443 did not yield a usable certificate: ${err instanceof Error ? err.message : String(err)}`,
          },
        );
      }
    } else {
      // Plain-HTTP target: there is no certificate to inspect.
      securityChecks["ssl-valid"] = "na";
    }

    // ══════════════════════════════════════════════════════════════════
    // COOKIE SECURITY CHECK
    // ══════════════════════════════════════════════════════════════════

    const cookies: CookieInfo[] = [];
    const setCookieHeaders = headers.getSetCookie?.() || [];
    // Also check raw header as fallback
    if (setCookieHeaders.length === 0) {
      const rawCookie = headers.get("set-cookie");
      if (rawCookie) setCookieHeaders.push(rawCookie);
    }

    const finalCookieHost = new URL(finalUrl).hostname;
    for (const cookieStr of setCookieHeaders) {
      const parts = cookieStr.split(";").map((p) => p.trim());
      const nameValue = parts[0] || "";
      const name = nameValue.split("=")[0] || "";
      const lowerParts = parts.map((p) => p.toLowerCase());
      const domainAttr = parts.find((p) => p.toLowerCase().startsWith("domain="))?.split("=")[1] || null;
      cookies.push({
        name,
        httpOnly: lowerParts.includes("httponly"),
        secure: lowerParts.includes("secure"),
        sameSite: lowerParts.find((p) => p.startsWith("samesite="))?.split("=")[1] || null,
        domain: domainAttr,
      });
    }

    let cookiesWithIssues = 0;
    let cookieScore = cookies.length > 0 ? 100 : -1; // -1 = no cookies observed

    for (const cookie of cookies) {
      const missingFlags: string[] = [];
      if (!cookie.httpOnly) missingFlags.push("HttpOnly");
      if (!cookie.secure && isHttps) missingFlags.push("Secure");
      if (!cookie.sameSite) missingFlags.push("SameSite");
      if (missingFlags.length > 0) {
        cookiesWithIssues++;
        cookieScore = clamp(cookieScore - missingFlags.length * 3, 0, 100);
        // First-party vs third-party: compare the cookie Domain attribute with
        // the final page host. No Domain attribute ⇒ first-party (host-only).
        const domainHost = cookie.domain ? cookie.domain.replace(/^\./, "").toLowerCase() : null;
        const isThirdParty = domainHost !== null && domainHost !== finalCookieHost && !finalCookieHost.endsWith(`.${domainHost}`);
        addIssue("Security", "warning", "recommended",
          `Cookie "${cookie.name}" is missing security flags: ${missingFlags.join(", ")}.`,
          `Missing ${missingFlags.join(" and ")} flags makes the cookie vulnerable to theft via XSS attacks or CSRF.`,
          `Add the missing flags: Set-Cookie: ${cookie.name}=...; HttpOnly; Secure; SameSite=Lax`,
          {
            checkKey: "cookie-flags",
            stage: "cookies",
            evidence: `Set-Cookie observed on ${finalUrl}: "${cookie.name}" has no ${missingFlags.join(", ")} attribute (${isThirdParty ? `third-party cookie, Domain=${cookie.domain}` : "first-party cookie"}).`,
          },
        );
      }
    }

    // Cookie-flags check: only evaluated when cookies were actually observed.
    if (cookies.length === 0) securityChecks["cookie-flags"] = "na";
    else if (cookiesWithIssues === 0) securityChecks["cookie-flags"] = "pass";
    else securityChecks["cookie-flags"] = cookiesWithIssues === cookies.length ? "fail" : "warn";

    // ══════════════════════════════════════════════════════════════════
    // MIXED CONTENT DETECTION
    // ══════════════════════════════════════════════════════════════════

    const mixedContent: MixedContent[] = [];
    let mixedContentScore = 100;

    if (isHttps && hasHtml && contentUsable) {
      // Find HTTP resources in src/href attributes of the FINAL HTML document
      // Dead code, disabled: unused whole-document regex superseded by the per-line scan below.
      // /(src|href)=(['"])(http:\/\/[^'\"]+)\2/gi;
      const lines = pageContent.split("\n");

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineMatches = line.matchAll(/(?<![\w-])(src|href)\s*=\s*(?:["'](http:\/\/[^"']+)["']|(http:\/\/[^\s>]+))/gi);
        for (const m of lineMatches) {
          const url = m[2] || m[3];
          if (!url) continue;
          let type: MixedContent["type"] = "other";
          if (/\.js(\?|$)/i.test(url) || /script/i.test(m[0])) type = "script";
          else if (/\.css(\?|$)/i.test(url) || /stylesheet/i.test(m[0]) || /rel=["']stylesheet["']/i.test(m[0])) type = "stylesheet";
          else if (/\.(png|jpe?g|gif|svg|webp|ico)(\?|$)/i.test(url)) type = "image";
          mixedContent.push({ url, type, lineNumber: li + 1 });
        }
      }
    }

    // Mixed-content check (only meaningful on a usable HTTPS HTML page)
    securityChecks["mixed-content"] = !isHttps
      ? "na"
      : contentUsable
        ? (mixedContent.length === 0 ? "pass" : "fail")
        : "not-checked";

    if (mixedContent.length > 0) {
      mixedContentScore = clamp(100 - mixedContent.length * 15, 0, 100);
      const scripts = mixedContent.filter((m) => m.type === "script").length;
      const images = mixedContent.filter((m) => m.type === "image").length;
      const styles = mixedContent.filter((m) => m.type === "stylesheet").length;
      const parts = [];
      if (scripts) parts.push(`${scripts} script(s)`);
      if (images) parts.push(`${images} image(s)`);
      if (styles) parts.push(`${styles} stylesheet(s)`);

      addIssue("Security",
        scripts > 0 ? "critical" : "warning",
        scripts > 0 ? "critical" : "recommended",
        `Found ${mixedContent.length} mixed content resource(s) on HTTPS page: ${parts.join(", ")}.`,
        "Mixed content allows attackers to intercept or modify insecure resources on your HTTPS page, potentially injecting malicious code or stealing data.",
        "Change all HTTP URLs to HTTPS, or use protocol-relative URLs (//example.com). For external resources, ensure they support HTTPS.",
        {
          checkKey: "mixed-content",
          stage: "html",
          evidence: `${mixedContent.length} resource(s) in the final HTML of ${finalUrl} load over http:// — first: ${mixedContent[0].url}`,
        },
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // SERVER INFORMATION
    // ══════════════════════════════════════════════════════════════════

    const serverHeader = headers.get("server") || headers.get("Server") || null;
    const poweredByHeader = headers.get("x-powered-by") || headers.get("X-Powered-By") || null;
    const technology: string[] = [];
    let framework: string | null = null;

    if (serverHeader) {
      const sv = serverHeader.toLowerCase();
      if (sv.includes("nginx")) technology.push("Nginx");
      else if (sv.includes("apache")) technology.push("Apache");
      else if (sv.includes("cloudflare")) technology.push("Cloudflare");
      else if (sv.includes("caddy")) technology.push("Caddy");
      else if (sv.includes("litespeed")) technology.push("LiteSpeed");
      else technology.push(serverHeader);
    }

    if (poweredByHeader) {
      const pf = poweredByHeader.toLowerCase();
      if (pf.includes("next.js")) framework = "Next.js";
      else if (pf.includes("nuxt")) framework = "Nuxt.js";
      else if (pf.includes("express")) framework = "Express";
      else if (pf.includes("laravel")) framework = "Laravel";
      else if (pf.includes("rails")) framework = "Ruby on Rails";
      else if (pf.includes("asp.net")) framework = "ASP.NET";
      else if (pf.includes("django")) framework = "Django";
      else if (pf.includes("flask")) framework = "Flask";
      else if (pf.includes("php")) framework = "PHP";
      else framework = poweredByHeader;
      technology.push(framework);
    }

    // Detect from HTML markers
    if (hasHtml) {
      if (/__next|next\/|_next\/|react|__react/i.test(pageContent)) technology.push("React/Next.js (detected)");
      else if (/nuxt|__nuxt/i.test(pageContent)) technology.push("Nuxt.js (detected)");
      else if (/wordpress|wp-content|wp-includes/i.test(pageContent)) technology.push("WordPress (detected)");
      else if (/shopify/i.test(pageContent)) technology.push("Shopify (detected)");
      else if (/wix\.com|wixstatic/i.test(pageContent)) technology.push("Wix (detected)");
      else if (/squarespace/i.test(pageContent)) technology.push("Squarespace (detected)");
      else if (/gatsby/i.test(pageContent)) technology.push("Gatsby (detected)");
      else if (/astro/i.test(pageContent)) technology.push("Astro (detected)");
    }

    const serverInfo: ServerInfo = { server: serverHeader, poweredBy: poweredByHeader, technology: [...new Set(technology)], framework };

    if (serverHeader && technology.some((t) => t.includes("detected"))) {
      addIssue("Security", "info", "nice-to-have",
        `Server technology is publicly visible: ${technology.join(", ")}.`,
        "Publicly disclosing server technology can help attackers identify known vulnerabilities for that specific stack.",
        "Remove or obfuscate server identification headers (Server, X-Powered-By) where possible.",
        {
          stage: "headers",
          evidence: `Server: ${serverHeader ?? "absent"}${poweredByHeader ? `, X-Powered-By: ${poweredByHeader}` : ""} observed on ${finalUrl}.`,
        },
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // SITE IDENTITY
    // ══════════════════════════════════════════════════════════════════

    // Multilingual page detection: privacy/terms/about/contact links are
    // recognised in English, French, German and Spanish — by link label, by
    // common URL pattern, by declared hreflang alternate and by page title.
    // The legacy English whole-page heuristics below stay as a fallback, so a
    // page that used to count as "found" can never start being reported
    // as missing.
    const sitePages = detectSitePages(pageContent);
    const hasPrivacyPolicy =
      sitePages.found.privacy || /privacy[- _]?policy|datenschutz|privacidad/i.test(html);
    const hasTermsOfService =
      sitePages.found.terms ||
      /terms[- _]?(?:of[- _]?)?service|terms[- _]?and[- _]?conditions|agb|términos/i.test(html);
    const hasContactInfo =
      sitePages.found.contact || /contact[\s@]|mailto:|tel:|phone|address|support@/i.test(html);
    const orgFromSsl = sslInfo?.issuer && !sslInfo.issuer.match(/^(Let's Encrypt|DigiCert|Sectigo|Comodo|GeoTrust|GlobalSign|Thawte)$/i) ? sslInfo.issuer : null;
    const hasOrganization =
      !!orgFromSsl || sitePages.found.about || /organization|company|about[- _]?us/i.test(html);
    const organizationName = orgFromSsl || null;

    const siteIdentity: SiteIdentity = { hasPrivacyPolicy, hasTermsOfService, hasContactInfo, hasOrganization, organizationName };

    if (!hasPrivacyPolicy && hasHtml) {
      addIssue("Security", "info", "nice-to-have",
        "No privacy policy link found.",
        "A privacy policy is required by law in many jurisdictions (GDPR, CCPA). It builds trust with users and protects you legally.",
        "Create and link a privacy policy page explaining how you collect, use, and protect user data.",
        {
          stage: "html",
          confirmed: false,
          evidence: `No privacy-policy link found in the fetched HTML of ${finalUrl}. Only this page was fetched, so absence elsewhere cannot be ruled out.`,
        },
      );
    }

    if (!hasTermsOfService && hasHtml) {
      addIssue("Security", "info", "nice-to-have",
        "No terms of service link found.",
        "Terms of service set the legal framework for your website usage and protect your business.",
        "Create and link terms of service that outline the rules for using your site.",
        {
          stage: "html",
          confirmed: false,
          evidence: `No terms-of-service link found in the fetched HTML of ${finalUrl}. Only this page was fetched, so absence elsewhere cannot be ruled out.`,
        },
      );
    }

    // ── Gate content-derived checks and findings ──────────────────────────
    // If the page content could not be honestly inspected, HTML-derived
    // checks become "Unable to Verify" and their findings are removed so no
    // unverified result is ever presented as a confirmed failure.
    if (!contentUsable) {
      const contentChecksByCategory: Array<[Record<string, CheckResult>, string[]]> = [
        [seoChecks, ["title", "meta-description", "h1-tag", "heading-structure", "canonical-tag", "robots-meta"]],
        [accessibilityChecks, ["image-alt", "html-lang", "form-labels"]],
        [technicalHealthChecks, ["html-structure", "viewport", "charset", "canonical"]],
        [performanceChecks, ["page-size", "image-count", "external-resources"]],
        [securityChecks, ["mixed-content"]],
      ];
      for (const [map, keys] of contentChecksByCategory) {
        for (const key of keys) if (map[key] !== undefined) map[key] = "not-checked";
      }
      for (let i = issues.length - 1; i >= 0; i--) {
        if (issues[i].stage === "html") issues.splice(i, 1);
      }
    }
    if (hardBlock) {
      // A bot-challenge/CDN response does not carry the application's own
      // headers or cookies, so those checks cannot be verified either.
      for (const key of Object.keys(securityChecks)) {
        if (key.startsWith("header-") || key === "cookie-flags") securityChecks[key] = "not-checked";
      }
      seoChecks["robots-txt"] = "not-checked";
      seoChecks["sitemap-xml"] = "not-checked";
      cookies.length = 0;
      cookiesWithIssues = 0;
      cookieScore = -1;
      for (let i = issues.length - 1; i >= 0; i--) {
        const issueStage = issues[i].stage;
        if (issueStage === "headers" || issueStage === "cookies" || issueStage === "origin-probe") issues.splice(i, 1);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // SCORING SUMMARY
    // ══════════════════════════════════════════════════════════════════

    // ── SCORING — shared, documented, applicable-only ──────────────────
    // Every category uses the same formula:
    //   score = round(100 × (passed + 0.5 × warnings) ÷ applicable)
    // where applicable = passed + failed + warnings. "Unable to Verify" and
    // "Not Applicable" checks are excluded entirely — incomplete data can
    // never drag a category to 0/100 (hasScore=false ⇒ display "—").
    const perfCatScore = scoreCategory(performanceChecks);
    const seoCatScore = scoreCategory(seoChecks);
    const secCatScore = scoreCategory(securityChecks);
    const a11yCatScore = scoreCategory(accessibilityChecks);
    const techCatScore = scoreCategory(technicalHealthChecks);

    const perfScore = perfCatScore.score;
    const seoScore = seoCatScore.score;
    const secScore = secCatScore.score;
    const a11yScore = a11yCatScore.score;
    const techScore = techCatScore.score;

    // Informational sub-scores kept for display; they are already represented
    // inside the Security category's ssl-valid / cookie-flags / mixed-content
    // checks, so they no longer carry separate hidden weights.
    const effectiveSslScore = sslInfo ? sslScore : 50;
    const effectiveCookieScore = cookieScore >= 0 ? cookieScore : 50;
    const effectiveMixedContentScore = isHttps ? mixedContentScore : 50;

    // Overall: weighted, renormalized over categories that HAVE a score.
    // Weights: Security 30%, Performance 25%, SEO 25%, Technical Health 10%,
    // Accessibility 10%.
    const overallResult = overallScore({
      Performance: perfCatScore.hasScore ? perfScore : null,
      SEO: seoCatScore.hasScore ? seoScore : null,
      Security: secCatScore.hasScore ? secScore : null,
      "Technical Health": techCatScore.hasScore ? techScore : null,
      Accessibility: a11yCatScore.hasScore ? a11yScore : null,
    });
    const overallScored = overallResult.score !== null;
    const overallScoreValue = overallResult.score ?? 0;

    // Risk level
    const riskLevel: "low" | "medium" | "high" | "critical" =
      !overallScored ? "medium"
      : overallScoreValue >= 80 ? "low"
      : overallScoreValue >= 60 ? "medium"
      : overallScoreValue >= 40 ? "high"
      : "critical";

    // Industry comparison (deterministic estimate derived from the score itself,
    // so identical results always display identically)
    const betterThanPercent = Math.min(99, Math.max(1, Math.round(overallScoreValue * 0.9)));

    // Aggregate counts — must match the actual checks exactly (all five states)
    const catScores = [perfCatScore, seoCatScore, secCatScore, a11yCatScore, techCatScore];
    const sum = (pick: (c: CategoryScore) => number) => catScores.reduce((acc, c) => acc + pick(c), 0);
    const totalPassed = sum((c) => c.passed);
    const totalFailed = sum((c) => c.failed);
    const totalWarnings = sum((c) => c.warnings);
    const totalUnverified = sum((c) => c.unverified ?? c.notChecked);
    const totalNotApplicable = sum((c) => c.notApplicable ?? 0);
    // "Checks run" = checks evaluated against observed evidence
    const totalChecksCompleted = totalPassed + totalFailed + totalWarnings;

    // ── Transparent report summary ──────────────────────────────────────
    const completeness: ScanSummary["completeness"] = hardBlock
      ? "blocked"
      : contentUsable && totalUnverified === 0 && limitations.length === 0
        ? "complete"
        : "partial";
    const summary: ScanSummary = {
      completeness,
      limitations,
      requestedUrl: parsedUrl.href,
      finalUrl,
      status,
      redirects: redirectChain.length,
      redirectChain,
      contentType: target.contentType ?? undefined,
      durationMs: responseTime,
      method: "http",
      browserChecks:
        "Not run — no browser engine (Playwright/Chromium) is available in this execution environment. Rendered-DOM checks (JS-injected content, console errors, computed accessibility, lab performance metrics such as LCP/CLS) were NOT performed; results that would need a browser are reported as Unable to Verify instead of guessed. HTTP-derived results are labeled with their method throughout this report.",
      blocked: hardBlock,
      blockReason: block?.reason ?? undefined,
      notHtml,
      incomplete,
      counts: {
        passed: totalPassed,
        failed: totalFailed,
        warnings: totalWarnings,
        notApplicable: totalNotApplicable,
        unverified: totalUnverified,
        total: totalChecksCompleted + totalUnverified + totalNotApplicable,
      },
      categoryFormula: CATEGORY_SCORE_FORMULA,
      overallFormula: overallResult.formula,
      performanceBasis:
        "Measured with a single server-side HTTP GET: response duration (including redirects), status, headers and HTML byte size. This is server response timing — NOT a browser lab test and not full page-load performance; LCP/FCP/CLS/TTI are not measured without a browser engine.",
      overallScored,
    };

    // Top 5 issues sorted by priority then severity
    const priorityOrder: Record<Priority, number> = { critical: 0, important: 1, recommended: 2, "nice-to-have": 3 };
    const severityOrder: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    const sortedIssues = [...issues].sort((a, b) =>
      priorityOrder[a.priority] - priorityOrder[b.priority] ||
      severityOrder[a.severity] - severityOrder[b.severity]
    );
    const topIssues = sortedIssues.slice(0, 5);

    // Quick Wins: top 3 fixes with biggest impact (excluding critical already covered)
    const quickWins: QuickWin[] = sortedIssues
      .filter((issue) => issue.priority !== "critical")
      .slice(0, 5)
      .map((issue) => {
        // Deterministic potential-gain estimates based on priority band
        const potentialGain = issue.priority === "important" ? 10 : issue.priority === "recommended" ? 6 : 3;
        return {
          category: issue.category,
          message: issue.message,
          potentialGain,
          priority: issue.priority,
        };
      })
      .sort((a, b) => b.potentialGain - a.potentialGain)
      .slice(0, 5);

    // Positive feedback if no issues
    if (issues.length === 0) {
      addIssue("Technical Health", "info", "nice-to-have",
        "No issues found. Your website looks healthy across all checks.",
        "All automated checks passed. Continue monitoring your site regularly as standards evolve.",
        "Run periodic scans to catch regressions, and consider manual accessibility and performance audits.",
      );
    }

    return {
      url: parsedUrl.href,
      finalUrl,
      status,
      https: isHttps,
      redirects: redirectChain.length,
      redirectChain,
      responseTime,
      pageSize,
      pageSizeFormatted: formatBytes(pageSize),

      title,
      titleLength,
      description,
      descriptionLength,
      hasViewport,
      hasCharset,
      hasLanguage,
      hasH1: h1Count > 0,
      h1Count,
      headingStructure: headingCount > 0 ? `${headingCount} heading tags` : "None found",
      canonicalUrl,
      hasRobotsMeta,
      robotsTxtAvailable,
      sitemapXmlAvailable,

      imageCount,
      imagesWithoutAlt,
      linkCount: (html.match(/<a[\s>]/g) || []).length,
      scriptCount,
      styleCount,
      internalLinkCount: Math.max(0, (html.match(/<a[\s>]/g) || []).length - (html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || []).length),
      externalLinkCount: (html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || []).length,
      formInputCount: inputMatches.length,
      inputsWithoutLabels,

      hasCSP: securityChecks["header-csp"] === "pass",
      hasXFrameOptions: securityChecks["header-xfo"] === "pass",
      hasXContentTypeOptions: securityChecks["header-xcto"] === "pass",
      hasStrictTransportSecurity: securityChecks["header-hsts"] === "pass",
      hasXPermittedCrossDomainPolicies: securityChecks["header-xpcdp"] === "pass",
      hasReferrerPolicy: securityChecks["header-rp"] === "pass",
      hasPermissionsPolicy: securityChecks["header-pp"] === "pass",

      score: overallScoreValue,
      grade: scoreToGrade(overallScoreValue),
      overallScored,
      riskLevel,
      betterThanPercent,

      ssl: sslInfo,
      cookies,
      cookiesWithIssues,
      mixedContent,
      mixedContentCount: mixedContent.length,
      serverInfo,
      siteIdentity,

      performanceScore: perfScore,
      seoScore,
      securityScore: secScore,
      accessibilityScore: a11yScore,
      technicalHealthScore: techScore,
      sslScore: effectiveSslScore,
      cookieScore: effectiveCookieScore,
      mixedContentScore: effectiveMixedContentScore,

      performanceChecks: perfCatScore,
      seoChecks: seoCatScore,
      securityChecks: secCatScore,
      accessibilityChecks: a11yCatScore,
      technicalHealthChecks: techCatScore,

      issues: sortedIssues,
      topIssues,
      quickWins,
      totalChecksCompleted,
      totalPassed,
      totalFailed,
      totalWarnings,
      totalUnverified,
      totalNotApplicable,
      summary,

      scannedAt: scannedAtMs,
    };
  },
});
