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
        message: "Website does not use HTTPS. All sites should use HTTPS.",
      });
    }

    // --- Status check ---
    if (status === 404) {
      issues.push({
        category: "Availability",
        severity: "critical",
        message:
          "Page returned a 404 Not Found status. The page may not exist.",
      });
    } else if (status === 500) {
      issues.push({
        category: "Availability",
        severity: "critical",
        message:
          "Server returned a 500 Internal Server Error. The site may be down.",
      });
    } else if (status >= 400) {
      issues.push({
        category: "Availability",
        severity: "critical",
        message: `Server returned HTTP ${status}. This may indicate an error.`,
      });
    } else if (status >= 300 && status < 400) {
      issues.push({
        category: "Availability",
        severity: "warning",
        message: `Final response was a redirect (HTTP ${status}). The page may not have loaded correctly.`,
      });
    }

    // --- Redirect check ---
    if (redirectChain.length > 0) {
      if (redirectChain.length >= 3) {
        issues.push({
          category: "Performance",
          severity: "warning",
          message: `Too many redirects (${redirectChain.length}). This slows down loading and hurts SEO.`,
        });
      } else {
        issues.push({
          category: "Performance",
          severity: "info",
          message: `Page redirects ${redirectChain.length} time(s). Consider pointing directly to the final URL.`,
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
            "HTTP redirects to HTTPS. Good practice, but consider using HTTPS from the start.",
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
        message: `Page is very large (${formatBytes(pageSize)}). Consider optimizing content size.`,
      });
    } else if (pageSize > 2 * 1024 * 1024) {
      issues.push({
        category: "Performance",
        severity: "info",
        message: `Page is large (${formatBytes(pageSize)}). Could be optimized for faster loading.`,
      });
    }

    // --- Response time ---
    if (responseTime > 5000) {
      issues.push({
        category: "Performance",
        severity: "critical",
        message: `Very slow response time (${responseTime}ms). Aim for under 2000ms.`,
      });
    } else if (responseTime > 3000) {
      issues.push({
        category: "Performance",
        severity: "warning",
        message: `Slow response time (${responseTime}ms). Consider optimizing server performance.`,
      });
    } else if (responseTime > 1500) {
      issues.push({
        category: "Performance",
        severity: "info",
        message: `Response time is ${responseTime}ms. Could be faster.`,
      });
    }

    // --- HTML Analysis ---
    const html = parseHtml(pageContent);

    if (!html.title) {
      issues.push({
        category: "SEO",
        severity: "critical",
        message: "No <title> tag found. Every page needs a unique title tag.",
      });
    } else if (html.title.length < 10) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `Title tag is very short ("${html.title}"). Aim for 30-60 characters.`,
      });
    } else if (html.title.length > 70) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `Title tag is very long (${html.title.length} chars). Aim for 30-60 characters.`,
      });
    }

    if (!html.description) {
      issues.push({
        category: "SEO",
        severity: "critical",
        message:
          "No meta description found. Add a compelling 120-160 character description.",
      });
    } else if (html.description.length < 50) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message:
          "Meta description is short. Aim for 120-160 characters for best results.",
      });
    }

    if (!html.hasViewport) {
      issues.push({
        category: "Mobile",
        severity: "critical",
        message:
          "No viewport meta tag. Your site may not display correctly on mobile devices.",
      });
    }

    if (!html.hasLanguage) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message:
          'No lang attribute on <html>. Add lang="en" (or appropriate language) for accessibility and SEO.',
      });
    }

    if (html.h1Count === 0) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message:
          "No <h1> tag found. Every page should have exactly one <h1> tag.",
      });
    } else if (html.h1Count > 1) {
      issues.push({
        category: "SEO",
        severity: "warning",
        message: `Found ${html.h1Count} <h1> tags. Use only one <h1> per page for best SEO.`,
      });
    }

    if (html.imagesWithoutAlt > 0) {
      issues.push({
        category: "Accessibility",
        severity: html.imagesWithoutAlt > 3 ? "critical" : "warning",
        message: `${html.imagesWithoutAlt} image(s) missing alt attribute. All images need alt text for accessibility.`,
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
            sh.name === "Content-Space-Policy" ? "critical" : "warning",
          message: `Missing security header: ${sh.label}.`,
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
        category: "General",
        severity: "info",
        message: "No issues found! Your website looks healthy.",
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
