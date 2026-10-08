import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const categoryScoreValidator = v.object({
  score: v.number(), passed: v.number(), failed: v.number(), warnings: v.number(), notChecked: v.number(),
  applicable: v.optional(v.number()), unverified: v.optional(v.number()), notApplicable: v.optional(v.number()),
  hasScore: v.optional(v.boolean()), formula: v.optional(v.string()), factors: v.optional(v.array(v.string())),
});

const issueValidator = v.object({
  category: v.string(),
  severity: v.union(v.literal("critical"), v.literal("warning"), v.literal("info")),
  priority: v.union(v.literal("critical"), v.literal("important"), v.literal("recommended"), v.literal("nice-to-have")),
  message: v.string(), whyItMatters: v.string(), howToFix: v.string(),
  evidence: v.optional(v.string()), evidenceUrl: v.optional(v.string()), stage: v.optional(v.string()),
  method: v.optional(v.union(v.literal("http"), v.literal("tls"), v.literal("browser"))),
  checkKey: v.optional(v.string()), detectedAt: v.optional(v.number()), confirmed: v.optional(v.boolean()),
  status: v.optional(v.union(v.literal("fail"), v.literal("warning"), v.literal("unable-to-verify"))),
});

const scanSummaryValidator = v.object({
  completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("blocked")),
  limitations: v.array(v.string()),
  requestedUrl: v.string(), finalUrl: v.string(), status: v.number(),
  redirects: v.number(), redirectChain: v.array(v.string()),
  contentType: v.optional(v.string()), durationMs: v.number(),
  method: v.string(), browserChecks: v.string(),
  blocked: v.boolean(), blockReason: v.optional(v.string()),
  notHtml: v.boolean(), incomplete: v.boolean(),
  counts: v.object({ passed: v.number(), failed: v.number(), warnings: v.number(), notApplicable: v.number(), unverified: v.number(), total: v.number() }),
  categoryFormula: v.string(), overallFormula: v.string(),
  performanceBasis: v.string(), overallScored: v.boolean(),
});

const quickWinValidator = v.object({
  category: v.string(), message: v.string(), potentialGain: v.number(),
  priority: v.union(v.literal("critical"), v.literal("important"), v.literal("recommended"), v.literal("nice-to-have")),
});

const sslInfoValidator = v.object({
  valid: v.boolean(), issuer: v.string(), expiryDate: v.string(),
  daysUntilExpiry: v.number(), serialNumber: v.string(), subjectAltNames: v.array(v.string()),
});

const cookieInfoValidator = v.object({
  name: v.string(), httpOnly: v.boolean(), secure: v.boolean(),
  sameSite: v.optional(v.string()), domain: v.optional(v.string()),
});

const mixedContentValidator = v.object({
  url: v.string(),
  type: v.union(v.literal("script"), v.literal("image"), v.literal("stylesheet"), v.literal("other")),
  lineNumber: v.number(),
});

const serverInfoValidator = v.object({
  server: v.optional(v.string()), poweredBy: v.optional(v.string()),
  technology: v.array(v.string()), framework: v.optional(v.string()),
});

const siteIdentityValidator = v.object({
  hasPrivacyPolicy: v.boolean(), hasTermsOfService: v.boolean(),
  hasContactInfo: v.boolean(), hasOrganization: v.boolean(),
  organizationName: v.optional(v.string()),
});

export const saveScan = mutation({
  args: {
    url: v.string(), finalUrl: v.string(), status: v.number(), https: v.boolean(),
    redirects: v.number(), redirectChain: v.optional(v.array(v.string())),
    responseTime: v.number(), pageSize: v.number(), pageSizeFormatted: v.string(),
    title: v.optional(v.string()), titleLength: v.optional(v.number()),
    description: v.optional(v.string()), descriptionLength: v.optional(v.number()),
    hasViewport: v.boolean(), hasCharset: v.boolean(), hasLanguage: v.boolean(),
    hasH1: v.boolean(), h1Count: v.number(), headingStructure: v.optional(v.string()),
    canonicalUrl: v.optional(v.string()), hasRobotsMeta: v.optional(v.boolean()),
    robotsTxtAvailable: v.optional(v.boolean()), sitemapXmlAvailable: v.optional(v.boolean()),
    imageCount: v.number(), imagesWithoutAlt: v.number(), linkCount: v.number(),
    scriptCount: v.number(), styleCount: v.number(), internalLinkCount: v.number(),
    externalLinkCount: v.number(), formInputCount: v.optional(v.number()),
    inputsWithoutLabels: v.optional(v.number()),
    hasCSP: v.boolean(), hasXFrameOptions: v.boolean(), hasXContentTypeOptions: v.boolean(),
    hasStrictTransportSecurity: v.boolean(), hasXPermittedCrossDomainPolicies: v.boolean(),
    hasReferrerPolicy: v.boolean(), hasPermissionsPolicy: v.boolean(),
    ssl: v.optional(sslInfoValidator),
    cookies: v.optional(v.array(cookieInfoValidator)), cookiesWithIssues: v.optional(v.number()),
    mixedContent: v.optional(v.array(mixedContentValidator)), mixedContentCount: v.optional(v.number()),
    serverInfo: v.optional(serverInfoValidator), siteIdentity: v.optional(siteIdentityValidator),
    score: v.number(), grade: v.string(),
    riskLevel: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"))),
    betterThanPercent: v.optional(v.number()),
    performanceScore: v.number(), seoScore: v.number(), securityScore: v.number(),
    accessibilityScore: v.number(), technicalHealthScore: v.number(),
    sslScore: v.optional(v.number()), cookieScore: v.optional(v.number()), mixedContentScore: v.optional(v.number()),
    performanceChecks: categoryScoreValidator, seoChecks: categoryScoreValidator,
    securityChecks: categoryScoreValidator, accessibilityChecks: categoryScoreValidator,
    technicalHealthChecks: categoryScoreValidator,
    issues: v.array(issueValidator), topIssues: v.array(issueValidator),
    quickWins: v.array(quickWinValidator),
    totalChecksCompleted: v.number(), totalPassed: v.number(),
    totalFailed: v.number(), totalWarnings: v.number(),
    totalUnverified: v.optional(v.number()), totalNotApplicable: v.optional(v.number()),
    overallScored: v.optional(v.boolean()), summary: v.optional(scanSummaryValidator),
    scannedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("scans", args);
    return id;
  },
});

export const getScan = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});
