import { v } from "convex/values";
import { action } from "./_generated/server";

// Helper to format bytes into human readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// Check a single security header
function checkHeader(
  headers: Headers,
  name: string,
): { present: boolean; value: string | null } {
  const value = headers.get(name);
  return { present: !!value, value };
}

// Extract meta tags and SEO info from HTML
function parseHtml(html: string) {
  const lower = html.toLowerCase();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || undefined;

  const descMatch = html.match(
    /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
  ) ||
    html.match(
      /<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i,
    );
  const description = descMatch?.[1]?.trim() || undefined;

  const hasViewport = /<meta\s+[^>]*name=["']viewport["']/i.test(html);
  const hasCharset =
    /<meta\s+[^>]*charset=["']/i.test(html) ||
    /<meta\s+[^>]*http-equiv=["']content-type["']/i.test(html);
  const hasLanguage = /<html\s+[^>]*lang=["'][^"']+["']/i.test(html);

  const h1Matches = html.match(/<h1[\s>]/gi);
  const h1Count = h1Matches ? h1Matches.length : 0;

  const imgMatches = html.match(/<img\s/gi);
  const imageCount = imgMatches ? imgMatches.length : 0;

  const imgNoAlt = html.match(/<img\s(?![^>]*\balt=)[^>]*>/gi);
  const imagesWithoutAlt = imgNoAlt ? imgNoAlt.length : 0;

  const linkMatches = html.match(/<a\s/gi);
  const linkCount = linkMatches ? linkMatches.length : 0;

  const scriptMatches = html.match(/<script[\s>]/gi);
  const scriptCount = scriptMatches ? scriptMatches.length : 0;

  const styleMatches = html.match(/<style[\s>]/gi);
  const styleCount = styleMatches ? styleMatches.length : 0;

  // Count internal vs external links
  const hrefMatches = html.match(/href=["'](https?:\/\/[^"']+)["']/gi) || [];
  const externalLinkCount = hrefMatches.length;
  const internalLinkCount = linkCount - externalLinkCount;

  return {
    title,
    description,
    hasViewport,
    hasCharset,
    hasLanguage,
    h1Count,
    imageCount,
    imagesWithoutAlt,
    linkCount,
    scriptCount,
    styleCount,
    internalLinkCount: Math.max(0, internalLinkCount),
    externalLinkCount,
  };
}

export const scanWebsite = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => {
    // Normalize URL
    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("Invalid URL. Please enter a valid website address.");
    }

    const issues: Array<{
      category: string;
      severity: "critical" | "warning" | "info";
      message: string;
    }> = [];

    // --- Fetch with redirect tracking ---
    const redirectChain: string[] = [];
    let currentUrl = parsedUrl.href;
    let status = 0;
    let finalResponse: Response | null = null;
    const maxRedirects = 10;

    const startTime = Date.now();

    for (let i = 0; i <= maxRedirects; i++) {
      try {
        // Use no-cors-friendly server-side fetch
        finalResponse = await fetch(currentUrl, {
          method: "GET",
          headers: {
            "User-Agent":
              "SitePulse/1.0 (+https://sitepulse.dev) Health-Check-Scanner",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          redirect: "manual", // Handle redirects manually
          signal: AbortSignal.timeout(15000),
        });

        status = finalResponse.status;

        if (finalResponse.status >= 300 && finalResponse.status < 400) {
          const location = finalResponse.headers.get("Location");
          if (!location) break;
          redirectChain.push(currentUrl);
          // Resolve relative redirects
          currentUrl = new URL(location, currentUrl).href;
        } else {
          break;
        }
      } catch (err) {
        if (i === 0) {
          throw new Error(
            `Could not connect to ${parsedUrl.href}. Please check the URL and try again.`,
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

    // --- HTTPS check ---
    const isHttps = finalUrl.startsWith("https://");
    if (!isHttps) {
      issues.push({
        category: "Security",
        severity: "critical",
        message:
          "Your site does not use HTTPS. Migrate to HTTPS to protect user data and improve search rankings.",
      });
    }

    // --- Status check ---
    if (status === 404) {
      issues.push({
        category: "Technical Health",
        severity: "critical",
        message:
          "The page returned a 404 Not Found status. Verify the URL is correct and the page exists.",
      });
    } else if (status === 500) {
      issues.push({
        category: "Technical Health",
        severity: "critical",
        message:
          "The server returned a 500 Internal Server Error. Check your server logs and fix the underlying issue.",
      });
    } else if (status >= 400) {
      issues.push({
        category: "Technical Health",
        severity: "critical",
        message: `The server returned HTTP ${status}. Investigate the cause and resolve the error.`,
      });
    } else if (status >= 300 && status < 400) {
      issues.push({
        category: "Technical Health",
        severity: "warning",
        message: `The final response was a redirect (HTTP ${status}). Ensure the redirect chain resolves correctly.`,
      });
    }

    // --- Redirect check ---
    if (redirectChain.length > 0) {
      if (redirectChain.length >= 3) {
        issues.push({
          category: "Performance",
          severity: "warning",
          message: `Too many redirects (${redirectChain.length}). Each redirect adds latency. Point users directly to the final URL.`,
        });
      } else {
        issues.push({
          category: "Performance",
          severity: "info",
          message: `The page redirects ${redirectChain.length} time(s). Consider linking directly to the final destination.`,
        });
      }

      // Check for HTTP→HTTPS redirect (good practice)
      if (
        parsedUrl.protocol === "http:" &&
        finalUrl.startsWith("https://")
      ) {
        issues.push({
          category: "Security",
          severity: "info",
          message:
            "HTTP redirects to HTTPS, which is good. Consider using HTTPS from the start to skip the redirect.",
        });
      }
    }

    // --- Page size ---
    let pageSize = 0;
    let pageContent = "";
    try {
      const text = await finalResponse.text();
      pageSize = new TextEncoder().encode(text).length;
      pageContent = text;
    } catch {
      // Could not read body
    }

    if (pageSize > 5 * 1024 * 1024) {
      issues.push({
        category: "Performance",
        severity: "warning",
        message: `The page is very large (${formatBytes(pageSize)}). Compress images, minify code, and remove unused assets.`,
      });
    } else if (pageSize > 2 * 1024 * 1024) {
      issues.push({
        category: "Performance",
        severity: "info",
        message: `The page is large (${formatBytes(pageSize)}). Optimizing asset sizes will improve load times.`,
      });
    }

    // --- Response time ---
    if (responseTime > 5000) {
      issues.push({
        category: "Performance",
        severity: "critical",
        message: `Very slow response time (${responseTime}ms). Optimize server performance, use caching, or consider a CDN.`,
      });
    } else if (responseTime > 3000) {
      issues.push({
        category: "Performance",
        severity: "warning",
        message: `Slow response time (${responseTime}ms). Enable caching and review server-side processing.`,
      });
    } else if (responseTime > 1500) {
      issues.push({
        category: "Performance",
        severity: "info",
        message: `Response time is ${responseTime}ms. There is room to improve for a faster experience.`,
      });
    }

    // --- HTML Analysis ---
    const html = parseHtml(pageContent);

    if (!html.title) {
      issues.push({
        category: "SEO",
        severity: "critical",
        message:
          "No title tag found. Add a unique, descriptive title between 30 and 60 characters to every page.",
      });
    } else if (html.title.length < 10) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `The title tag is very short (\"${html.title}\", ${html.title.length} characters). Expand it to 30\u201360 characters for better search visibility.`,
      });
    } else if (html.title.length > 70) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `The title tag is ${html.title.length} characters long. Shorten it to 30\u201360 characters so it displays fully in search results.`,
      });
    }

    if (!html.description) {
      issues.push({
        category: "SEO",
        severity: "critical",
        message:
          "No meta description found. Write a compelling 120\u2013160 character summary for each page to improve click-through rates.",
      });
    } else if (html.description.length < 50) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message:
          "The meta description is too short. Aim for 120\u2013160 characters to make the most of search result snippets.",
      });
    }

    if (!html.hasViewport) {
      issues.push({
        category: "Technical Health",
        severity: "critical",
        message:
          "No viewport meta tag. Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> so the page displays correctly on mobile devices.",
      });
    }

    if (!html.hasLanguage) {
      issues.push({
        category: "Accessibility",
        severity: "warning",
        message:
          'The <html> tag is missing a lang attribute. Add lang="en" (or the appropriate language code) to improve accessibility and SEO.',
      });
    }

    if (html.h1Count === 0) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message:
          "No <h1> tag found. Add exactly one <h1> to each page to clearly communicate the page topic to search engines.",
      });
    } else if (html.h1Count > 1) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `Found ${html.h1Count} <h1> tags. Use a single <h1> per page to maintain a clear content hierarchy.`,
      });
    }

    if (html.imagesWithoutAlt > 0) {
      issues.push({
        category: "Accessibility",
        severity: html.imagesWithoutAlt > 3 ? "critical" : "warning",
        message: `${html.imagesWithoutAlt} image(s) are missing alt text. Add descriptive alt attributes so screen readers and search engines understand the content.`,
      });
    }

    // --- Security Headers ---
    const headers = finalResponse.headers;

    const securityHeaders = [
      {
        name: "Content-Security-Policy",
        field: "hasCSP",
        label: "Content-Security-Policy",
      },
      {
        name: "X-Frame-Options",
        field: "hasXFrameOptions",
        label: "X-Frame-Options",
      },
      {
        name: "X-Content-Type-Options",
        field: "hasXContentTypeOptions",
        label: "X-Content-Type-Options",
      },
      {
        name: "Strict-Transport-Security",
        field: "hasStrictTransportSecurity",
        label: "Strict-Transport-Security (HSTS)",
      },
      {
        name: "X-Permitted-Cross-Domain-Policies",
        field: "hasXPermittedCrossDomainPolicies",
        label: "X-Permitted-Cross-Domain-Policies",
      },
      {
        name: "Referrer-Policy",
        field: "hasReferrerPolicy",
        label: "Referrer-Policy",
      },
      {
        name: "Permissions-Policy",
        field: "hasPermissionsPolicy",
        label: "Permissions-Policy",
      },
    ];

    const headerValues: Record<string, boolean> = {};

    for (const sh of securityHeaders) {
      const check = checkHeader(headers, sh.name);
      headerValues[sh.field] = check.present;
      if (!check.present) {
        issues.push({
          category: "Security",
          severity:
            sh.name === "Content-Security-Policy" ? "critical" : "warning",
          message: `Missing the ${sh.label} header. Add it to protect your site from common attacks.`,
        });
      }
    }

    // --- Score Calculation ---
    let score = 100;
    for (const issue of issues) {
      if (issue.severity === "critical") score -= 15;
      else if (issue.severity === "warning") score -= 8;
      else score -= 3;
    }
    score = Math.max(0, Math.min(100, score));

    let grade: string;
    if (score >= 90) grade = "A";
    else if (score >= 80) grade = "B";
    else if (score >= 65) grade = "C";
    else if (score >= 50) grade = "D";
    else grade = "F";

    // Positive feedback
    if (issues.length === 0) {
      issues.push({
        category: "Technical Health",
        severity: "info",
        message: "No issues found. Your website looks healthy across all checks.",
      });
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
      ...html,
      ...headerValues,
      score,
      grade,
      issues,
      scannedAt: Date.now(),
    };
  },
});
