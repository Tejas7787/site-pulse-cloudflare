"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import type { Issue, Severity, CheckResult, CategoryScore } from "../types/scan";

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

function makeCategoryScore(
  checks: Record<string, CheckResult>,
): CategoryScore {
  const vals = Object.values(checks);
  return {
    score: 0, // computed later
    passed: vals.filter((v) => v === "pass").length,
    failed: vals.filter((v) => v === "fail").length,
    warnings: vals.filter((v) => v === "warn").length,
    notChecked: vals.filter((v) => v === "not-checked").length,
  };
}

function computeCategoryScore(
  checks: Record<string, CheckResult>,
): number {
  const vals = Object.values(checks);
  const scorable = vals.filter((v) => v !== "not-checked");
  if (scorable.length === 0) return -1; // not-checked
  const passed = scorable.filter((v) => v === "pass").length;
  const warned = scorable.filter((v) => v === "warn").length;
  return Math.round(((passed + warned * 0.5) / scorable.length) * 100);
}

function pickSeverity(score: number): Severity {
  if (score < 50) return "critical";
  if (score < 80) return "warning";
  return "info";
}

// ── SSRF Protection ──────────────────────────────────────────────────

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Block localhost variants
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    h === "0.0.0.0" ||
    h === "127.0.0.0" ||
    h === "127.0.0.1" ||
    h === "loopback"
  )
    return true;

  // Block internal / metadata hostnames
  if (
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    h.endsWith(".corp") ||
    h.endsWith(".intranet") ||
    h.endsWith(".localdomain") ||
    h.endsWith(".private") ||
    h === "metadata.google.internal" ||
    h === "169.254.169.254"
  )
    return true;

  // Block IPv4 private / reserved ranges
  const ip4Match = h.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (ip4Match) {
    const [, a, b] = ip4Match.map(Number);
    if (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && +ip4Match[3] === 100) ||
      (a === 203 && b === 0 && +ip4Match[3] === 113) ||
      a >= 224
    )
      return true;
  }

  // Block IPv6 loopback / private
  if (
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe80")
  )
    return true;

  return false;
}

async function isUrlSafe(urlStr: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return false;

  const hostname = parsed.hostname;
  if (isPrivateHost(hostname)) return false;

  // DNS resolution check — block IPs that resolve to private ranges
  try {
    const dns = await import("node:dns");
    const addrs = await new Promise<string[]>((resolve, reject) => {
      dns.resolve4(hostname, (err: Error | null, addresses: string[]) => {
        if (err) {
          dns.resolve6(
            hostname,
            (err2: Error | null, a6: string[]) => {
              if (err2) reject(err2);
              else resolve(a6);
            },
          );
        } else {
          resolve(addresses);
        }
      });
    });
    for (const addr of addrs) {
      if (isPrivateHost(addr)) return false;
    }
  } catch {
    // DNS lookup failed — still proceed with the fetch (blocklist already passed)
  }

  return true;
}

// ── Main Scan ────────────────────────────────────────────────────────

export const scanWebsite = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => {
    // 1. Validate & normalize URL
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("Invalid URL. Please enter a valid website address.");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported.");
    }

    // 2. SSRF protection
    if (!(await isUrlSafe(parsedUrl.href))) {
      throw new Error(
        "This URL points to a private or restricted address and cannot be scanned.",
      );
    }

    // 3. Issue & check tracking
    const issues: Issue[] = [];
    const performanceChecks: Record<string, CheckResult> = {};
    const seoChecks: Record<string, CheckResult> = {};
    const securityChecks: Record<string, CheckResult> = {};
    const accessibilityChecks: Record<string, CheckResult> = {};
    const technicalHealthChecks: Record<string, CheckResult> = {};

    const addIssue = (cat: string, sev: Severity, msg: string) => {
      issues.push({ category: cat, severity: sev, message: msg });
    };

    // 4. Fetch with redirect tracking (timeout 12s, max 10 redirects)
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
            "User-Agent":
              "SitePulse/1.0 (+https://sitepulse.dev) Website-Health-Scanner",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
          // Re-check SSRF on redirect targets
          if (!(await isUrlSafe(currentUrl))) {
            throw new Error(
              "Redirect target is a private or restricted address.",
            );
          }
        } else {
          break;
        }
      } catch (err) {
        if (i === 0) {
          const isTimeout =
            (err instanceof DOMException && err.name === "TimeoutError") ||
            (err instanceof Error && err.name === "TimeoutError") ||
            (err instanceof Error && /timeout/i.test(err.message));
          if (isTimeout) {
            throw new Error(
              "The website took too long to respond. It may be down or blocking health checks.",
            );
          }
          throw new Error(
            `Could not connect to ${parsedUrl.href}. Please verify the URL and try again.`,
          );
        }
        break;
      }
    }

    const responseTime = Date.now() - startTime;
    const finalUrl = currentUrl;

    if (!finalResponse) {
      throw new Error("Failed to get a response from the server.");
    }

    // 5. Read page content (max5MB)
    let pageSize = 0;
    let pageContent = "";
    try {
      const arrayBuffer = await finalResponse.arrayBuffer();
      pageSize = arrayBuffer.byteLength;
      if (pageSize >5 * 1024 * 1024) {
        throw new Error(
          "The page is too large to analyze (over5 MB). Try a different page.",
        );
      }
      pageContent = new TextDecoder("utf-8", { fatal: false }).decode(
        arrayBuffer,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("too large")
      ) {
        throw err;
      }
      // Proceed with empty content — we can still report HTTP-level info
    }

    const html = pageContent.toLowerCase();
    const hasHtml = html.includes("<html") || html.includes("<!doctype");

    // ── PERFORMANCE CHECKS ───────────────────────────────────────────

    // Response time
    if (responseTime <= 1000) {
      performanceChecks["response-time"] = "pass";
    } else if (responseTime <= 3000) {
      performanceChecks["response-time"] = "warn";
      addIssue(
        "Performance",
        "warning",
        `Response time is ${responseTime}ms. Aim for under1 second for a snappy experience.`,
      );
    } else {
      performanceChecks["response-time"] = "fail";
      addIssue(
        "Performance",
        "critical",
        `Very slow response time (${responseTime}ms). Optimize server performance, enable caching, or use a CDN.`,
      );
    }

    // Page size
    if (pageSize <=500 * 1024) {
      performanceChecks["page-size"] = "pass";
    } else if (pageSize <=2 * 1024 * 1024) {
      performanceChecks["page-size"] = "warn";
      addIssue(
        "Performance",
        "warning",
        `Page HTML is large (${formatBytes(pageSize)}). Minify HTML and reduce inline assets.`,
      );
    } else {
      performanceChecks["page-size"] = "fail";
      addIssue(
        "Performance",
        "critical",
        `Page HTML is very large (${formatBytes(pageSize)}). Compress and optimize to improve load times.`,
      );
    }

    // Image count
    const imgMatches = html.match(/<img[\s>]/g);
    const imageCount = imgMatches ? imgMatches.length : 0;
    performanceChecks["image-count"] = imageCount > 0 ? "pass" : "not-checked";

    // External resources
    const scriptMatches = html.match(/<script[\s>]/g);
    const styleMatches = html.match(/<style[\s>]/g);
    const linkStylesheetMatches = html.match(
      /rel=["']stylesheet["']/g,
    );
    const scriptCount = scriptMatches ? scriptMatches.length : 0;
    const styleCount = (styleMatches ? styleMatches.length : 0) + (linkStylesheetMatches ? linkStylesheetMatches.length : 0);
    const totalResources = scriptCount + styleCount;
    if (totalResources <= 10) {
      performanceChecks["external-resources"] = "pass";
    } else if (totalResources <= 20) {
      performanceChecks["external-resources"] = "warn";
      addIssue(
        "Performance",
        "warning",
        `High number of external resources (${totalResources}). Reduce scripts and stylesheets for faster loading.`,
      );
    } else {
      performanceChecks["external-resources"] = "fail";
      addIssue(
        "Performance",
        "warning",
        `Too many external resources (${totalResources}). Consolidate and defer non-critical assets.`,
      );
    }

    // Redirect performance
    if (redirectChain.length === 0) {
      performanceChecks["redirects"] = "pass";
    } else if (redirectChain.length <= 2) {
      performanceChecks["redirects"] = "warn";
      addIssue(
        "Performance",
        "info",
        `Page redirects ${redirectChain.length} time(s). Link directly to the final URL when possible.`,
      );
    } else {
      performanceChecks["redirects"] = "fail";
      addIssue(
        "Performance",
        "warning",
        `Too many redirects (${redirectChain.length}). Each redirect adds latency. Point users directly to the final URL.`,
      );
    }

    // ── SEO CHECKS ───────────────────────────────────────────────────

    // Title
    const titleMatch = pageContent.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || undefined;
    const titleLength = title?.length ?? 0;

    if (title && titleLength >= 30 && titleLength <= 60) {
      seoChecks["title"] = "pass";
    } else if (title && titleLength > 0) {
      seoChecks["title"] = "warn";
      if (titleLength < 10) {
        addIssue(
          "SEO",
          "warning",
          `The title tag is very short ("${title}", ${titleLength} characters). Expand it to 30\u201360 characters for better search visibility.`,
        );
      } else if (titleLength > 70) {
        addIssue(
          "SEO",
          "warning",
          `The title tag is ${titleLength} characters long. Shorten it to 30\u201360 characters so it displays fully in search results.`,
        );
      } else {
        addIssue(
          "SEO",
          "warning",
          `The title tag is ${titleLength} characters. Aim for 30\u201360 characters for optimal search results.`,
        );
      }
    } else {
      seoChecks["title"] = "fail";
      addIssue(
        "SEO",
        "critical",
        "No title tag found. Add a unique, descriptive title between 30 and 60 characters to every page.",
      );
    }

    // Meta description
    const descMatch =
      pageContent.match(
        /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
      ) ||
      pageContent.match(
        /<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i,
      );
    const description = descMatch?.[1]?.trim() || undefined;
    const descriptionLength = description?.length ?? 0;

    if (description && descriptionLength >= 120 && descriptionLength <= 160) {
      seoChecks["meta-description"] = "pass";
    } else if (description && descriptionLength > 0) {
      seoChecks["meta-description"] = "warn";
      addIssue(
        "SEO",
        descriptionLength < 50 ? "warning" : "info",
        descriptionLength < 50
          ? "The meta description is too short. Aim for 120\u2013160 characters to make the most of search result snippets."
          : `The meta description is ${descriptionLength} characters. Aim for 120\u2013160 characters for optimal search snippets.`,
      );
    } else {
      seoChecks["meta-description"] = "fail";
      addIssue(
        "SEO",
        "critical",
        "No meta description found. Write a compelling 120\u2013160 character summary for each page to improve click-through rates.",
      );
    }

    // H1
    const h1Matches = html.match(/<h1[\s>]/g);
    const h1Count = h1Matches ? h1Matches.length : 0;
    if (h1Count === 1) {
      seoChecks["h1-tag"] = "pass";
    } else if (h1Count === 0) {
      seoChecks["h1-tag"] = "fail";
      addIssue(
        "SEO",
        "warning",
        "No <h1> tag found. Add exactly one <h1> to each page to clearly communicate the page topic to search engines.",
      );
    } else {
      seoChecks["h1-tag"] = "warn";
      addIssue(
        "SEO",
        "warning",
        `Found ${h1Count} <h1> tags. Use a single <h1> per page to maintain a clear content hierarchy.`,
      );
    }

    // Heading structure
    const headingMatches = html.match(/<h[1-6][\s>]/g);
    const headingCount = headingMatches ? headingMatches.length : 0;
    if (h1Count >= 1 && headingCount >= 2) {
      seoChecks["heading-structure"] = "pass";
    } else if (h1Count >= 1) {
      seoChecks["heading-structure"] = "warn";
      addIssue(
        "SEO",
        "info",
        "The page has only an H1 tag. Adding H2 and H3 headings improves content structure for both users and search engines.",
      );
    } else {
      seoChecks["heading-structure"] = "not-checked";
    }

    // Canonical URL
    const canonicalMatch = pageContent.match(
      /<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i,
    ) ||
      pageContent.match(
        /<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i,
      );
    const canonicalUrl = canonicalMatch?.[1]?.trim() || undefined;
    if (canonicalUrl) {
      seoChecks["canonical-tag"] = "pass";
    } else {
      seoChecks["canonical-tag"] = "warn";
      addIssue(
        "SEO",
        "info",
        "No canonical tag found. Add a <link rel=\"canonical\"> to prevent duplicate content issues in search results.",
      );
    }

    // Robots meta
    const robotsMetaMatch = html.match(
      /<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']*)["']/i,
    );
    const robotsMetaContent = robotsMetaMatch?.[1]?.toLowerCase() || "";
    const hasRobotsMeta = robotsMetaContent.length > 0;
    if (!hasRobotsMeta || !robotsMetaContent.includes("noindex")) {
      seoChecks["robots-meta"] = "pass";
    } else {
      seoChecks["robots-meta"] = "fail";
      addIssue(
        "SEO",
        "critical",
        'The page has a "noindex" robots meta tag. This tells search engines not to index the page, which will hide it from search results.',
      );
    }

    // Sitemap & robots.txt availability
    const origin = parsedUrl.origin;
    let robotsTxtAvailable: boolean | null = null;
    let sitemapXmlAvailable: boolean | null = null;

    try {
      const robotsResp = await fetch(`${origin}/robots.txt`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      robotsTxtAvailable = robotsResp.status === 200;
      seoChecks["robots-txt"] = robotsTxtAvailable ? "pass" : "warn";
      if (!robotsTxtAvailable) {
        addIssue(
          "SEO",
          "info",
          "No robots.txt file found. While not strictly required, a robots.txt file helps search engines crawl your site efficiently.",
        );
      }
    } catch {
      robotsTxtAvailable = null;
      seoChecks["robots-txt"] = "not-checked";
    }

    try {
      const sitemapResp = await fetch(`${origin}/sitemap.xml`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      sitemapXmlAvailable = sitemapResp.status === 200;
      seoChecks["sitemap-xml"] = sitemapXmlAvailable ? "pass" : "warn";
      if (!sitemapXmlAvailable) {
        addIssue(
          "SEO",
          "info",
          "No sitemap.xml found. Adding a sitemap helps search engines discover and index your pages more effectively.",
        );
      }
    } catch {
      sitemapXmlAvailable = null;
      seoChecks["sitemap-xml"] = "not-checked";
    }

    // ── SECURITY CHECKS ──────────────────────────────────────────────

    const isHttps = finalUrl.startsWith("https://");
    if (isHttps) {
      securityChecks["https"] = "pass";
    } else {
      securityChecks["https"] = "fail";
      addIssue(
        "Security",
        "critical",
        "Your site does not use HTTPS. Migrate to HTTPS to protect user data and improve search rankings.",
      );
    }

    // HTTP→HTTPS redirect
    if (
      parsedUrl.protocol === "http:" &&
      finalUrl.startsWith("https://")
    ) {
      securityChecks["http-to-https-redirect"] = "pass";
    } else if (parsedUrl.protocol === "http:") {
      securityChecks["http-to-https-redirect"] = "fail";
    } else {
      securityChecks["http-to-https-redirect"] = "pass";
    }

    // Security headers
    const headers = finalResponse.headers;
    const securityHeaderDefs = [
      {
        name: "Content-Security-Policy",
        key: "csp",
        label: "Content-Security-Policy",
        critical: true,
      },
      {
        name: "Strict-Transport-Security",
        key: "hsts",
        label: "Strict-Transport-Security (HSTS)",
        critical: false,
      },
      {
        name: "X-Content-Type-Options",
        key: "xcto",
        label: "X-Content-Type-Options",
        critical: false,
      },
      {
        name: "X-Frame-Options",
        key: "xfo",
        label: "X-Frame-Options",
        critical: false,
      },
      {
        name: "Referrer-Policy",
        key: "rp",
        label: "Referrer-Policy",
        critical: false,
      },
      {
        name: "Permissions-Policy",
        key: "pp",
        label: "Permissions-Policy",
        critical: false,
      },
      {
        name: "X-Permitted-Cross-Domain-Policies",
        key: "xpcdp",
        label: "X-Permitted-Cross-Domain-Policies",
        critical: false,
      },
    ];

    for (const sh of securityHeaderDefs) {
      const present = !!headers.get(sh.name);
      securityChecks[`header-${sh.key}`] = present ? "pass" : "fail";
      if (!present) {
        addIssue(
          "Security",
          sh.critical ? "critical" : "warning",
          `Missing the ${sh.label} header. Add it to protect your site from common attacks.`,
        );
      }
    }

    // ── ACCESSIBILITY CHECKS ─────────────────────────────────────────

    // Images missing alt
    const imgNoAlt = html.match(/<img\s(?![^>]*\balt=)[^>]*>/g);
    const imagesWithoutAlt = imgNoAlt ? imgNoAlt.length : 0;
    if (imageCount === 0) {
      accessibilityChecks["image-alt"] = "not-checked";
    } else if (imagesWithoutAlt === 0) {
      accessibilityChecks["image-alt"] = "pass";
    } else {
      accessibilityChecks["image-alt"] = "fail";
      addIssue(
        "Accessibility",
        imagesWithoutAlt > 3 ? "critical" : "warning",
        `${imagesWithoutAlt} of ${imageCount} image(s) are missing alt text. Add descriptive alt attributes so screen readers and search engines understand the content.`,
      );
    }

    // HTML lang attribute
    const hasLanguage = /<html\s+[^>]*lang=["'][^"']+["']/i.test(
      pageContent,
    );
    if (hasLanguage) {
      accessibilityChecks["html-lang"] = "pass";
    } else {
      accessibilityChecks["html-lang"] = "fail";
      addIssue(
        "Accessibility",
        "warning",
        'The <html> tag is missing a lang attribute. Add lang="en" (or the appropriate language code) to improve accessibility and SEO.',
      );
    }

    // Form inputs without labels
    const inputMatches =
      html.match(
        /<input\s+[^>]*(?:type=["'](?:text|email|password|search|tel|url|number)["'])?[^>]*>/gi,
      ) || [];
    const labelMatches = html.match(/<label[\s>]/gi) || [];
    const labelForMatches = html.match(/for=["'][^"']+["']/gi) || [];
    const hasFormLabels =
      labelMatches.length > 0 || labelForMatches.length > 0;
    const inputsWithoutLabels =
      inputMatches.length > 0 && !hasFormLabels
        ? inputMatches.length
        : 0;

    if (inputMatches.length === 0) {
      accessibilityChecks["form-labels"] = "not-checked";
    } else if (inputsWithoutLabels === 0) {
      accessibilityChecks["form-labels"] = "pass";
    } else {
      accessibilityChecks["form-labels"] = "warn";
      addIssue(
        "Accessibility",
        "warning",
        `${inputsWithoutLabels} form input(s) may be missing associated labels. Use <label> elements or aria-label for screen reader support.`,
      );
    }

    // ── TECHNICAL HEALTH CHECKS ──────────────────────────────────────

    // HTTP status
    if (status >= 200 && status < 300) {
      technicalHealthChecks["http-status"] = "pass";
    } else if (status >= 300 && status < 400) {
      technicalHealthChecks["http-status"] = "warn";
      addIssue(
        "Technical Health",
        "warning",
        `The final response was a redirect (HTTP ${status}). Ensure the redirect chain resolves correctly.`,
      );
    } else if (status === 404) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue(
        "Technical Health",
        "critical",
        "The page returned a 404 Not Found status. Verify the URL is correct and the page exists.",
      );
    } else if (status === 500) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue(
        "Technical Health",
        "critical",
        "The server returned a 500 Internal Server Error. Check your server logs and fix the underlying issue.",
      );
    } else if (status >= 400) {
      technicalHealthChecks["http-status"] = "fail";
      addIssue(
        "Technical Health",
        "critical",
        `The server returned HTTP ${status}. Investigate the cause and resolve the error.`,
      );
    } else {
      technicalHealthChecks["http-status"] = "not-checked";
    }

    // Redirect count
    if (redirectChain.length === 0) {
      technicalHealthChecks["redirect-count"] = "pass";
    } else if (redirectChain.length <= 2) {
      technicalHealthChecks["redirect-count"] = "pass";
    } else {
      technicalHealthChecks["redirect-count"] = "fail";
    }

    // Viewport
    const hasViewport = /<meta\s+[^>]*name=["']viewport["']/i.test(
      pageContent,
    );
    if (hasViewport) {
      technicalHealthChecks["viewport"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["viewport"] = "not-checked";
    } else {
      technicalHealthChecks["viewport"] = "fail";
      addIssue(
        "Technical Health",
        "critical",
        'No viewport meta tag. Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page displays correctly on mobile devices.',
      );
    }

    // Canonical
    if (canonicalUrl) {
      technicalHealthChecks["canonical"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["canonical"] = "not-checked";
    } else {
      technicalHealthChecks["canonical"] = "warn";
    }

    // HTML structure
    const hasDoctype = pageContent.toLowerCase().includes("<!doctype");
    const hasCharset =
      /<meta\s+[^>]*charset=["']/i.test(pageContent) ||
      /<meta\s+[^>]*http-equiv=["']content-type["']/i.test(pageContent);
    if (hasDoctype && hasCharset) {
      technicalHealthChecks["html-structure"] = "pass";
    } else if (!hasHtml) {
      technicalHealthChecks["html-structure"] = "not-checked";
    } else {
      technicalHealthChecks["html-structure"] = "warn";
      addIssue(
        "Technical Health",
        "info",
        !hasDoctype
          ? "No DOCTYPE declaration found. Adding <!DOCTYPE html> ensures consistent rendering across browsers."
          : "No charset declaration found. Add <meta charset=\"utf-8\"> for proper text rendering.",
      );
    }

    // ── SCORING ──────────────────────────────────────────────────────

    const perfScore = computeCategoryScore(performanceChecks);
    const seoScore = computeCategoryScore(seoChecks);
    const secScore = computeCategoryScore(securityChecks);
    const a11yScore = computeCategoryScore(accessibilityChecks);
    const techScore = computeCategoryScore(technicalHealthChecks);

    // Overall = weighted average of available scores
    const scores = [perfScore, seoScore, secScore, a11yScore, techScore].filter(
      (s) => s >= 0,
    );
    const overallScore =
      scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;

    // Build category score objects
    const perfCatScore = makeCategoryScore(performanceChecks);
    perfCatScore.score = perfScore;

    const seoCatScore = makeCategoryScore(seoChecks);
    seoCatScore.score = seoScore;

    const secCatScore = makeCategoryScore(securityChecks);
    secCatScore.score = secScore;

    const a11yCatScore = makeCategoryScore(accessibilityChecks);
    a11yCatScore.score = a11yScore;

    const techCatScore = makeCategoryScore(technicalHealthChecks);
    techCatScore.score = techScore;

    // Aggregate counts
    const allChecks = {
      ...performanceChecks,
      ...seoChecks,
      ...securityChecks,
      ...accessibilityChecks,
      ...technicalHealthChecks,
    };
    const allVals = Object.values(allChecks);
    const totalPassed = allVals.filter((v) => v === "pass").length;
    const totalFailed = allVals.filter((v) => v === "fail").length;
    const totalWarnings = allVals.filter((v) => v === "warn").length;
    const totalChecksCompleted = allVals.filter(
      (v) => v !== "not-checked",
    ).length;

    // Top 5 issues (critical first, then warning, then info)
    const severityOrder: Record<Severity, number> = {
      critical: 0,
      warning: 1,
      info: 2,
    };
    const topIssues = [...issues]
      .sort(
        (a, b) =>
          severityOrder[a.severity] - severityOrder[b.severity],
      )
      .slice(0, 5);

    // If no issues, add positive feedback
    if (issues.length === 0) {
      addIssue(
        "Technical Health",
        "info",
        "No issues found. Your website looks healthy across all checks.",
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
      headingStructure:
        headingCount > 0 ? `${headingCount} heading tags` : "None found",
      canonicalUrl,
      hasRobotsMeta,
      robotsTxtAvailable,
      sitemapXmlAvailable,

      imageCount,
      imagesWithoutAlt,
      linkCount: (html.match(/<a[\s>]/g) || []).length,
      scriptCount,
      styleCount,
      internalLinkCount: Math.max(
        0,
        (html.match(/<a[\s>]/g) || []).length -
          (html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || []).length,
      ),
      externalLinkCount: (
        html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || []
      ).length,
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
      overallScore,
      performanceScore: perfScore,
      seoScore,
      securityScore: secScore,
      accessibilityScore: a11yScore,
      technicalHealthScore: techScore,

      performanceChecks: perfCatScore,
      seoChecks: seoCatScore,
      securityChecks: secCatScore,
      accessibilityChecks: a11yCatScore,
      technicalHealthChecks: techCatScore,

      issues,
      topIssues,
      totalChecksCompleted,
      totalPassed,
      totalFailed,
      totalWarnings,

      scannedAt: Date.now(),
    };
  },
});
