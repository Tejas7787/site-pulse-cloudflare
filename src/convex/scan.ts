"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import type { Issue, Priority, Severity, CheckResult, CategoryScore, QuickWin, SSLInfo, CookieInfo, MixedContent, ServerInfo, SiteIdentity } from "../types/scan";
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

function makeCategoryScore(checks: Record<string, CheckResult>): CategoryScore {
  const vals = Object.values(checks);
  return {
    score: 0,
    passed: vals.filter((v) => v === "pass").length,
    failed: vals.filter((v) => v === "fail").length,
    warnings: vals.filter((v) => v === "warn").length,
    notChecked: vals.filter((v) => v === "not-checked").length,
  };
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

function makeIssue(
  category: string,
  severity: Severity,
  priority: Priority,
  message: string,
  whyItMatters: string,
  howToFix: string,
): Issue {
  return { category, severity, priority, message, whyItMatters, howToFix };
}

// ── Priority Assignment ──────────────────────────────────────────────

function assignPriority(
  category: string,
  checkKey: string,
  result: CheckResult,
): Priority {
  if (result === "pass" || result === "not-checked") return "nice-to-have";

  // Critical: do today
  if (
    checkKey === "https" ||
    checkKey === "header-csp" ||
    checkKey === "http-status" && result === "fail" ||
    checkKey === "response-time" && result === "fail"
  ) return "critical";

  // Important: do this week
  if (
    checkKey === "meta-description" ||
    checkKey === "h1-tag" ||
    checkKey === "header-hsts" ||
    checkKey === "page-size" && result === "fail" ||
    checkKey === "viewport"
  ) return "important";

  // Recommended: do this month
  if (
    checkKey === "header-xfo" ||
    checkKey === "header-xcto" ||
    checkKey === "canonical-tag" ||
    checkKey === "heading-structure" ||
    checkKey === "title" ||
    checkKey === "redirects" && result === "fail"
  ) return "recommended";

  // Nice to have
  return "nice-to-have";
}

function severityForPriority(p: Priority): Severity {
  if (p === "critical") return "critical";
  if (p === "important") return "warning";
  return "info";
}

// ── Main Scan ────────────────────────────────────────────────────────

export const scanWebsite = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => {
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

    const addIssue = (
      cat: string, sev: Severity, pri: Priority, msg: string, why: string, fix: string,
    ) => { issues.push(makeIssue(cat, sev, pri, msg, why, fix)); };

    // 3. Fetch with redirect tracking
    const redirectChain: string[] = [];
    let currentUrl = parsedUrl.href;
    let status = 0;
    let finalResponse: Response | null = null;
    const maxRedirects = 10;
    const startTime = Date.now();

    for (let i = 0; i <= maxRedirects; i++) {
      try {
        finalResponse = await fetch(currentUrl, {
          method: "GET",
          headers: {
            "User-Agent": "SitePulse/1.0 (+https://sitepulse.dev) Website-Health-Scanner",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
        status = finalResponse.status;
        if (status >= 300 && status < 400) {
          const location = finalResponse.headers.get("Location");
          if (!location) break;
          redirectChain.push(currentUrl);
          currentUrl = new URL(location, currentUrl).href;
          if (!(await isUrlSafe(currentUrl))) {
            throw new Error("Redirect target is a private or restricted address.");
          }
        } else { break; }
      } catch (err) {
        if (i === 0) {
          const isTimeout = (err instanceof Error && /timeout/i.test(err.message));
          if (isTimeout) throw new Error("The website took too long to respond. It may be down or blocking health checks.");
          throw new Error(`Could not connect to ${parsedUrl.href}. Please verify the URL and try again.`);
        }
        break;
      }
    }

    const responseTime = Date.now() - startTime;
    const finalUrl = currentUrl;
    if (!finalResponse) throw new Error("Failed to get a response from the server.");

    // 4. Read page content (max5MB)
    let pageSize = 0;
    let pageContent = "";
    try {
      const arrayBuffer = await finalResponse.arrayBuffer();
      pageSize = arrayBuffer.byteLength;
      if (pageSize >5 * 1024 * 1024) {
        throw new Error("The page is too large to analyze (over5 MB). Try a different page.");
      }
      pageContent = new TextDecoder("utf-8", { fatal: false }).decode(arrayBuffer);
    } catch (err) {
      if (err instanceof Error && err.message.includes("too large")) throw err;
    }

    const html = pageContent.toLowerCase();
    const hasHtml = html.includes("<html") || html.includes("<!doctype");

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
      );
    }

    // Image count
    const imgMatches = html.match(/<img[\s>]/g);
    const imageCount = imgMatches ? imgMatches.length : 0;
    performanceChecks["image-count"] = imageCount > 0 ? "pass" : "not-checked";

    // External resources
    const scriptMatches = html.match(/<script[\s>]/g);
    const styleMatches = html.match(/<style[\s>]/g);
    const linkStylesheetMatches = html.match(/rel=["']stylesheet["']/g);
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
      );
    } else if (totalResources > 10) {
      addIssue("Performance", "info", "nice-to-have",
        `${totalResources} external resources detected.`,
        "While not excessive, reducing external resources can further improve page load speed.",
        "Audit your scripts and stylesheets for unused code and remove or consolidate where possible.",
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
      );
    } else {
      performanceChecks["redirects"] = "fail";
      addIssue("Performance", "warning", "recommended",
        `Too many redirects (${redirectChain.length}).`,
        "Multiple redirects create a chain of server delays. Each redirect adds 100-300ms of latency.",
        "Point users directly to the final URL. Audit your redirect rules and eliminate unnecessary hops.",
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
      );
    }

    const descMatch =
      pageContent.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
      pageContent.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
    const description = descMatch?.[1]?.trim() || undefined;
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
      pageContent.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ||
      pageContent.match(/<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
    const canonicalUrl = canonicalMatch?.[1]?.trim() || undefined;
    seoChecks["canonical-tag"] = canonicalUrl ? "pass" : "warn";

    if (!canonicalUrl) {
      addIssue("SEO", "info", "recommended",
        "No canonical tag found.",
        "Without a canonical tag, search engines may index duplicate versions of the same page (with/without www, trailing slashes, etc.), diluting your SEO authority.",
        'Add <link rel="canonical" href="https://yourdomain.com/page"> inside your <head> to point to the preferred version of the page.',
      );
    }

    // Robots meta
    const robotsMetaMatch = html.match(/<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i);
    const robotsMetaContent = robotsMetaMatch?.[1]?.toLowerCase() || "";
    const hasRobotsMeta = robotsMetaContent.length > 0;
    if (!hasRobotsMeta || !robotsMetaContent.includes("noindex")) {
      seoChecks["robots-meta"] = "pass";
    } else {
      seoChecks["robots-meta"] = "fail";
      addIssue("SEO", "critical", "critical",
        'Page has a "noindex" robots meta tag.',
        "The noindex directive tells search engines to exclude this page from search results. If this is unintentional, your page will be invisible to anyone searching for it.",
        'Remove the noindex directive from your robots meta tag, or change it to <meta name="robots" content="index, follow">.',
      );
    }

    // Sitemap & robots.txt
    const origin = parsedUrl.origin;
    let robotsTxtAvailable: boolean | null = null;
    let sitemapXmlAvailable: boolean | null = null;

    try {
      const robotsResp = await fetch(`${origin}/robots.txt`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      robotsTxtAvailable = robotsResp.status === 200;
      seoChecks["robots-txt"] = robotsTxtAvailable ? "pass" : "warn";
      if (!robotsTxtAvailable) {
        addIssue("SEO", "info", "nice-to-have",
          "No robots.txt file found.",
          "A robots.txt file helps search engines understand which pages to crawl. While not strictly required, it's considered best practice.",
          'Create a robots.txt file at your site root (e.g., https://yourdomain.com/robots.txt) with basic crawl directives.',
        );
      }
    } catch {
      robotsTxtAvailable = null;
      seoChecks["robots-txt"] = "not-checked";
    }

    try {
      const sitemapResp = await fetch(`${origin}/sitemap.xml`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      sitemapXmlAvailable = sitemapResp.status === 200;
      seoChecks["sitemap-xml"] = sitemapXmlAvailable ? "pass" : "warn";
      if (!sitemapXmlAvailable) {
        addIssue("SEO", "info", "nice-to-have",
          "No sitemap.xml found.",
          "A sitemap helps search engines discover all your pages, especially for large sites or pages not well-linked internally.",
          'Generate a sitemap.xml and submit it to Google Search Console and Bing Webmaster Tools.',
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
      );
    }

    // HTTP→HTTPS redirect
    if (parsedUrl.protocol === "http:" && finalUrl.startsWith("https://")) {
      securityChecks["http-to-https-redirect"] = "pass";
    } else if (parsedUrl.protocol === "http:") {
      securityChecks["http-to-https-redirect"] = "fail";
    } else {
      securityChecks["http-to-https-redirect"] = "pass";
    }

    // Security headers (points-based)
    const headers = finalResponse.headers;
    const securityHeaderDefs = [
      { name: "Content-Security-Policy", key: "csp", label: "Content-Security-Policy", points: 20 },
      { name: "Strict-Transport-Security", key: "hsts", label: "Strict-Transport-Security (HSTS)", points: 15 },
      { name: "X-Content-Type-Options", key: "xcto", label: "X-Content-Type-Options", points: 15 },
      { name: "X-Frame-Options", key: "xfo", label: "X-Frame-Options", points: 15 },
      { name: "Referrer-Policy", key: "rp", label: "Referrer-Policy", points: 15 },
      { name: "Permissions-Policy", key: "pp", label: "Permissions-Policy", points: 10 },
      { name: "X-Permitted-Cross-Domain-Policies", key: "xpcdp", label: "X-Permitted-Cross-Domain-Policies", points: 10 },
    ];

    let securityPoints = isHttps ? 20 : 0; // base from HTTPS
    const maxSecurityPoints = 20 + 20 + 15 + 15 + 15 + 15 + 10 + 10; // = 120, but cap at 100

    const headerIssues: Array<{ key: string; header: typeof securityHeaderDefs[0] }> = [];
    for (const sh of securityHeaderDefs) {
      const present = !!headers.get(sh.name);
      securityChecks[`header-${sh.key}`] = present ? "pass" : "fail";
      if (present) {
        securityPoints += sh.points;
      } else {
        headerIssues.push({ key: `header-${sh.key}`, header: sh });
      }
    }

    // Emit issues for missing headers
    for (const { header } of headerIssues) {
      const pri: Priority = header.key === "csp" ? "critical"
        : header.key === "hsts" ? "important"
        : header.key === "xfo" || header.key === "xcto" ? "recommended"
        : "nice-to-have";

      const explanations: Record<string, { why: string; fix: string }> = {
        csp: {
          why: "Without CSP, your site is vulnerable to Cross-Site Scripting (XSS) attacks where malicious scripts can steal user data, deface your site, or redirect users to phishing pages.",
          fix: 'Add a Content-Security-Policy header. Start with a basic policy: Content-Security-Policy: default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'.',
        },
        hsts: {
          why: "HSTS tells browsers to always use HTTPS for your site. Without it, returning visitors may be vulnerable to SSL stripping attacks on their first visit.",
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
        e.why,
        e.fix,
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // ACCESSIBILITY SCORING (deductions from 100)
    // ══════════════════════════════════════════════════════════════════

    let a11yScore = 100;

    const imgNoAlt = html.match(/<img\s(?![^>]*\balt=)[^>]*>/g);
    const imagesWithoutAlt = imgNoAlt ? imgNoAlt.length : 0;
    if (imageCount === 0) {
      accessibilityChecks["image-alt"] = "not-checked";
    } else if (imagesWithoutAlt === 0) {
      accessibilityChecks["image-alt"] = "pass";
    } else {
      accessibilityChecks["image-alt"] = "fail";
      a11yScore -= imagesWithoutAlt * 10;
      addIssue("Accessibility",
        imagesWithoutAlt > 3 ? "critical" : "warning",
        imagesWithoutAlt > 3 ? "important" : "recommended",
        `${imagesWithoutAlt} of ${imageCount} image(s) are missing alt text.`,
        "Screen readers cannot describe images without alt text, making your site unusable for visually impaired visitors. Search engines also use alt text to understand image content.",
        'Add descriptive alt attributes to each image: <img src="photo.jpg" alt="Description of the image">',
      );
    }

    const hasLanguage = /<html\s+[^>]*lang=["'][^"']+["']/i.test(pageContent);
    if (hasLanguage) {
      accessibilityChecks["html-lang"] = "pass";
    } else {
      accessibilityChecks["html-lang"] = "fail";
      a11yScore -= 20;
      addIssue("Accessibility", "warning", "recommended",
        'The <html> tag is missing a lang attribute.',
        "Screen readers use the lang attribute to select the correct pronunciation. Without it, visually impaired users hear content read in the wrong language.",
        'Add the lang attribute to your HTML tag: <html lang="en">',
      );
    }

    const inputMatches = html.match(/<input\s+[^>]*(?:type=["'](?:text|email|password|search|tel|url|number)["'])?[^>]*>/gi) || [];
    const labelMatches = html.match(/<label[\s>]/gi) || [];
    const labelForMatches = html.match(/for=["'][^"']+["']/gi) || [];
    const hasFormLabels = labelMatches.length > 0 || labelForMatches.length > 0;
    const inputsWithoutLabels = inputMatches.length > 0 && !hasFormLabels ? inputMatches.length : 0;

    if (inputMatches.length === 0) {
      accessibilityChecks["form-labels"] = "not-checked";
    } else if (inputsWithoutLabels === 0) {
      accessibilityChecks["form-labels"] = "pass";
    } else {
      accessibilityChecks["form-labels"] = "warn";
      a11yScore -= inputsWithoutLabels * 10;
      addIssue("Accessibility", "warning", "recommended",
        `${inputsWithoutLabels} form input(s) may be missing associated labels.`,
        "Without labels, screen readers cannot tell users what each form field is for. This makes forms unusable for visually impaired visitors.",
        'Associate each input with a label: <label for="email">Email</label> <input id="email" type="email">',
      );
    }

    a11yScore = clamp(a11yScore, 0, 100);
    if (a11yScore >= 80) accessibilityChecks["overall"] = "pass";
    else if (a11yScore >= 50) accessibilityChecks["overall"] = "warn";
    else accessibilityChecks["overall"] = "fail";

    // ══════════════════════════════════════════════════════════════════
    // TECHNICAL SCORING (points-based)
    // ══════════════════════════════════════════════════════════════════

    let techScore = 0;

    // Valid HTML structure: 30 points
    const hasDoctype = pageContent.toLowerCase().includes("<!doctype");
    const hasCharset =
      /<meta\s+[^>]*charset=["']/i.test(pageContent) ||
      /<meta\s+[^>]*http-equiv=["']content-type["']/i.test(pageContent);
    if (hasDoctype && hasCharset) {
      techScore += 30;
      technicalHealthChecks["html-structure"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["html-structure"] = "not-checked";
      techScore += 15; // partial credit for non-HTML
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
    const hasViewport = /<meta\s+[^>]*name=["']viewport["']/i.test(pageContent);
    if (hasViewport) {
      techScore += 20;
      technicalHealthChecks["viewport"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["viewport"] = "not-checked";
      techScore += 10;
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
      techScore += 20;
      technicalHealthChecks["charset"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["charset"] = "not-checked";
      techScore += 10;
    } else {
      technicalHealthChecks["charset"] = "warn";
    }

    // Canonical: 15 points
    if (canonicalUrl) {
      techScore += 15;
      technicalHealthChecks["canonical"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["canonical"] = "not-checked";
      techScore += 7;
    } else {
      technicalHealthChecks["canonical"] = "warn";
    }

    // Clean URL: 15 points (no query params, no excessive path segments)
    const urlPath = parsedUrl.pathname;
    const hasCleanUrls = !parsedUrl.search && urlPath.split("/").filter(Boolean).length <= 4;
    if (hasCleanUrls) {
      techScore += 15;
      technicalHealthChecks["clean-urls"] = "pass";
    } else {
      techScore += 5;
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
      techScore += 15; // bonus for good status
      technicalHealthChecks["http-status"] = "pass";
    } else if (status >= 300 && status < 400) {
      techScore += 10;
      technicalHealthChecks["http-status"] = "warn";
      addIssue("Technical Health", "warning", "recommended",
        `Final response was a redirect (HTTP ${status}).`,
        "If the redirect chain doesn't resolve properly, users and search engines may not reach your intended page.",
        "Ensure the redirect chain resolves to a final 200 OK page. Update internal links to point to the final URL.",
      );
    } else if (status === 404) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        "Page returned 404 Not Found.",
        "A 404 error means the page doesn't exist. Visitors who land here will leave immediately, and search engines will eventually drop the page from their index.",
        "Verify the URL is correct. If the page was moved, set up a 301 redirect to the new location.",
      );
    } else if (status === 500) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        "Server returned 500 Internal Server Error.",
        "A 500 error means your server crashed or encountered an unhandled error. The page is completely inaccessible to users and search engines.",
        "Check your server logs for the specific error. Common causes include database connection failures, PHP errors, or misconfigured server software.",
      );
    } else if (status >= 400) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue("Technical Health", "critical", "critical",
        `Server returned HTTP ${status}.`,
        "This HTTP status code indicates a server-side error that prevents the page from loading correctly.",
        "Investigate the server logs to identify and fix the root cause of this error.",
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

    techScore = clamp(techScore, 0, 100);

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
        if (daysUntilExpiry > 30) sslScore = 100;
        else if (daysUntilExpiry > 0) sslScore = 50;
        else sslScore = 0;

        if (daysUntilExpiry <= 0) {
          addIssue("Security", "critical", "critical",
            "SSL certificate has expired.",
            "An expired certificate causes browser warnings and breaks trust with visitors. Most users will see a security warning and leave immediately.",
            "Renew your SSL certificate immediately. Consider using auto-renewal services like Let's Encrypt to prevent future expirations.",
          );
        } else if (daysUntilExpiry <= 30) {
          addIssue("Security", "warning", "important",
            `SSL certificate expires in ${daysUntilExpiry} days (${expiryDate.toLocaleDateString()}).`,
            "An expiring certificate will soon trigger browser warnings, breaking trust with your visitors.",
            "Renew your SSL certificate before it expires. Enable auto-renewal to prevent future issues.",
          );
        }
      } catch {
        sslScore = 0;
        addIssue("Security", "warning", "important",
          "Could not verify SSL certificate.",
          "The SSL certificate could not be checked. This might indicate a misconfiguration or connection issue.",
          "Verify your SSL certificate is properly installed and the server is accessible on port 443.",
        );
      }
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

    for (const cookieStr of setCookieHeaders) {
      const parts = cookieStr.split(";").map((p) => p.trim());
      const nameValue = parts[0] || "";
      const name = nameValue.split("=")[0] || "";
      const lowerParts = parts.map((p) => p.toLowerCase());
      cookies.push({
        name,
        httpOnly: lowerParts.includes("httponly"),
        secure: lowerParts.includes("secure"),
        sameSite: lowerParts.find((p) => p.startsWith("samesite="))?.split("=")[1] || null,
        domain: parts.find((p) => p.toLowerCase().startsWith("domain="))?.split("=")[1] || null,
      });
    }

    let cookiesWithIssues = 0;
    let cookieScore = cookies.length > 0 ? 100 : -1; // -1 = not checked

    for (const cookie of cookies) {
      const missingFlags: string[] = [];
      if (!cookie.httpOnly) missingFlags.push("HttpOnly");
      if (!cookie.secure && isHttps) missingFlags.push("Secure");
      if (!cookie.sameSite) missingFlags.push("SameSite");
      if (missingFlags.length > 0) {
        cookiesWithIssues++;
        cookieScore = clamp(cookieScore - missingFlags.length * 3, 0, 100);
        addIssue("Security", "warning", "recommended",
          `Cookie "${cookie.name}" is missing security flags: ${missingFlags.join(", ")}.`,
          `Missing ${missingFlags.join(" and ")} flags makes the cookie vulnerable to theft via XSS attacks or CSRF.`,
          `Add the missing flags: Set-Cookie: ${cookie.name}=...; HttpOnly; Secure; SameSite=Lax`,
        );
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // MIXED CONTENT DETECTION
    // ══════════════════════════════════════════════════════════════════

    const mixedContent: MixedContent[] = [];
    let mixedContentScore = 100;

    if (isHttps && hasHtml) {
      // Find HTTP resources in src/href attributes
      const httpResourceRegex = /(src|href)=(['"])(http:\/\/[^'\"]+)\2/gi;
      let match;
      let lineNum = 1;
      const lines = pageContent.split("\n");

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineMatches = line.matchAll(/(src|href)=(['"])(http:\/\/[^'\"]+)\2/gi);
        for (const m of lineMatches) {
          const url = m[3];
          let type: MixedContent["type"] = "other";
          if (/\.js(\?|$)/i.test(url) || /script/i.test(m[0])) type = "script";
          else if (/\.css(\?|$)/i.test(url) || /stylesheet/i.test(m[0]) || /rel=["']stylesheet["']/i.test(m[0])) type = "stylesheet";
          else if (/\.(png|jpe?g|gif|svg|webp|ico)(\?|$)/i.test(url)) type = "image";
          mixedContent.push({ url, type, lineNumber: li + 1 });
        }
      }
    }

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
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // SITE IDENTITY
    // ══════════════════════════════════════════════════════════════════

    const hasPrivacyPolicy = /privacy[- _]?policy|datenschutz|privacidad/i.test(html);
    const hasTermsOfService = /terms[- _]?(?:of[- _]?)?service|terms[- _]?and[- _]?conditions|agb|términos/i.test(html);
    const hasContactInfo = /contact[\s@]|mailto:|tel:|phone|address|support@/i.test(html);
    const orgFromSsl = sslInfo?.issuer && !sslInfo.issuer.match(/^(Let's Encrypt|DigiCert|Sectigo|Comodo|GeoTrust|GlobalSign|Thawte)$/i) ? sslInfo.issuer : null;
    const hasOrganization = !!orgFromSsl || /organization|company|about[- _]?us/i.test(html);
    const organizationName = orgFromSsl || null;

    const siteIdentity: SiteIdentity = { hasPrivacyPolicy, hasTermsOfService, hasContactInfo, hasOrganization, organizationName };

    if (!hasPrivacyPolicy && hasHtml) {
      addIssue("Security", "info", "nice-to-have",
        "No privacy policy link found.",
        "A privacy policy is required by law in many jurisdictions (GDPR, CCPA). It builds trust with users and protects you legally.",
        "Create and link a privacy policy page explaining how you collect, use, and protect user data.",
      );
    }

    if (!hasTermsOfService && hasHtml) {
      addIssue("Security", "info", "nice-to-have",
        "No terms of service link found.",
        "Terms of service set the legal framework for your website usage and protect your business.",
        "Create and link terms of service that outline the rules for using your site.",
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // SCORING SUMMARY
    // ══════════════════════════════════════════════════════════════════

    // Performance: weighted average (response time 50%, page size 30%, http status 20%)
    const perfScore = Math.round(rtScore * 0.5 + psScore * 0.3 + (performanceChecks["http-status"] === "pass" ? 100 : performanceChecks["http-status"] === "warn" ? 60 : 0) * 0.2);

    // SEO: weighted average across every check shown in the SEO category.
    // Weights: title .20, description .20, H1 .15, headings .10, canonical .10,
    // robots meta .05, robots.txt .10, sitemap.xml .10 (= 1.00).
    // Checks that could not be performed count as neutral (50) so unreachable
    // lookups neither reward nor punish.
    const robotsTxtCheckScore = seoChecks["robots-txt"] === "pass" ? 100 : seoChecks["robots-txt"] === "not-checked" ? 50 : 0;
    const sitemapXmlCheckScore = seoChecks["sitemap-xml"] === "pass" ? 100 : seoChecks["sitemap-xml"] === "not-checked" ? 50 : 0;
    const seoScore = Math.round(
      titleScore * 0.20 +
      descScore * 0.20 +
      h1Score * 0.15 +
      headingScore * 0.10 +
      (seoChecks["canonical-tag"] === "pass" ? 100 : 50) * 0.10 +
      (seoChecks["robots-meta"] === "pass" ? 100 : 0) * 0.05 +
      robotsTxtCheckScore * 0.10 +
      sitemapXmlCheckScore * 0.10
    );

    // Security headers: points-based, capped at 100
    const headerSecScore = clamp(Math.round((securityPoints / maxSecurityPoints) * 100), 0, 100);

    // Sub-checks that cannot apply use a neutral 50 so they neither reward nor punish.
    const effectiveSslScore = sslInfo ? sslScore : 50; // neutral if not HTTPS
    const effectiveCookieScore = cookieScore >= 0 ? cookieScore : 50; // neutral if no cookies
    const effectiveMixedContentScore = isHttps ? mixedContentScore : 50; // neutral if not HTTPS

    // The Security category combines its four sub-areas with fixed weights:
    // headers 55%, SSL certificate 20%, cookie flags 12.5%, mixed content 12.5%.
    const secScore = Math.round(
      headerSecScore * 0.55 +
      effectiveSslScore * 0.20 +
      effectiveCookieScore * 0.125 +
      effectiveMixedContentScore * 0.125
    );

    // Overall: weighted by importance — exactly matching the weights shown on
    // the report page: Security 30%, Performance 25%, SEO 25%,
    // Technical Health 10%, Accessibility 10%. No other inputs.
    const overallScore = Math.round(
      secScore * 0.30 + perfScore * 0.25 + seoScore * 0.25 + techScore * 0.10 + a11yScore * 0.10
    );

    // Risk level
    const riskLevel: "low" | "medium" | "high" | "critical" = overallScore >= 80 ? "low" : overallScore >= 60 ? "medium" : overallScore >= 40 ? "high" : "critical";

    // Industry comparison (deterministic estimate derived from the score itself,
    // so identical results always display identically)
    const betterThanPercent = Math.min(99, Math.max(1, Math.round(overallScore * 0.9)));

    // Build category score objects
    const perfCatScore = makeCategoryScore(performanceChecks); perfCatScore.score = perfScore;
    const seoCatScore = makeCategoryScore(seoChecks); seoCatScore.score = seoScore;
    const secCatScore = makeCategoryScore(securityChecks); secCatScore.score = secScore;
    const a11yCatScore = makeCategoryScore(accessibilityChecks); a11yCatScore.score = a11yScore;
    const techCatScore = makeCategoryScore(technicalHealthChecks); techCatScore.score = techScore;

    // Aggregate counts
    const allChecks = { ...performanceChecks, ...seoChecks, ...securityChecks, ...accessibilityChecks, ...technicalHealthChecks };
    const allVals = Object.values(allChecks);
    const totalPassed = allVals.filter((v) => v === "pass").length;
    const totalFailed = allVals.filter((v) => v === "fail").length;
    const totalWarnings = allVals.filter((v) => v === "warn").length;
    const totalChecksCompleted = allVals.filter((v) => v !== "not-checked").length;

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

      score: overallScore,
      grade: scoreToGrade(overallScore),
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

      scannedAt: Date.now(),
    };
  },
});
