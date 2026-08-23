import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const categoryScoreValidator = v.object({
  score: v.number(),
  passed: v.number(),
  failed: v.number(),
  warnings: v.number(),
  notChecked: v.number(),
});

const issueValidator = v.object({
  category: v.string(),
  severity: v.union(
    v.literal("critical"),
    v.literal("warning"),
    v.literal("info"),
  ),
  message: v.string(),
});

export const saveScan = mutation({
  args: {
    url: v.string(),
    finalUrl: v.string(),
    status: v.number(),
    https: v.boolean(),
    redirects: v.number(),
    redirectChain: v.optional(v.array(v.string())),
    responseTime: v.number(),
    pageSize: v.number(),
    pageSizeFormatted: v.string(),
    title: v.optional(v.string()),
    titleLength: v.number(),
    description: v.optional(v.string()),
    descriptionLength: v.number(),
    hasViewport: v.boolean(),
    hasCharset: v.boolean(),
    hasLanguage: v.boolean(),
    hasH1: v.boolean(),
    h1Count: v.number(),
    headingStructure: v.string(),
    canonicalUrl: v.optional(v.string()),
    hasRobotsMeta: v.boolean(),
    robotsTxtAvailable: v.optional(v.boolean()),
    sitemapXmlAvailable: v.optional(v.boolean()),
    imageCount: v.number(),
    imagesWithoutAlt: v.number(),
    linkCount: v.number(),
    scriptCount: v.number(),
    styleCount: v.number(),
    internalLinkCount: v.number(),
    externalLinkCount: v.number(),
    formInputCount: v.number(),
    inputsWithoutLabels: v.number(),
    hasCSP: v.boolean(),
    hasXFrameOptions: v.boolean(),
    hasXContentTypeOptions: v.boolean(),
    hasStrictTransportSecurity: v.boolean(),
    hasReferrerPolicy: v.boolean(),
    hasPermissionsPolicy: v.boolean(),
    overallScore: v.number(),
    performanceScore: v.number(),
    seoScore: v.number(),
    securityScore: v.number(),
    accessibilityScore: v.number(),
    technicalHealthScore: v.number(),
    performanceChecks: categoryScoreValidator,
    seoChecks: categoryScoreValidator,
    securityChecks: categoryScoreValidator,
    accessibilityChecks: categoryScoreValidator,
    technicalHealthChecks: categoryScoreValidator,
    issues: v.array(issueValidator),
    topIssues: v.array(issueValidator),
    totalChecksCompleted: v.number(),
    totalPassed: v.number(),
    totalFailed: v.number(),
    totalWarnings: v.number(),
    scannedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("scans", args);
    return id;
  },
});

export const getScan = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
