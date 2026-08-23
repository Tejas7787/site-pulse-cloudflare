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
    titleLength: v.optional(v.number()),
    description: v.optional(v.string()),
    descriptionLength: v.optional(v.number()),
    hasViewport: v.boolean(),
    hasCharset: v.boolean(),
    hasLanguage: v.boolean(),
    hasH1: v.boolean(),
    h1Count: v.number(),
    headingStructure: v.optional(v.string()),
    canonicalUrl: v.optional(v.string()),
    hasRobotsMeta: v.optional(v.boolean()),
    robotsTxtAvailable: v.optional(v.boolean()),
    sitemapXmlAvailable: v.optional(v.boolean()),
    imageCount: v.number(),
    imagesWithoutAlt: v.number(),
    linkCount: v.number(),
    scriptCount: v.number(),
    styleCount: v.number(),
    internalLinkCount: v.number(),
    externalLinkCount: v.number(),
    formInputCount: v.optional(v.number()),
    inputsWithoutLabels: v.optional(v.number()),
    hasCSP: v.boolean(),
    hasXFrameOptions: v.boolean(),
    hasXContentTypeOptions: v.boolean(),
    hasStrictTransportSecurity: v.boolean(),
    hasXPermittedCrossDomainPolicies: v.boolean(),
    hasReferrerPolicy: v.boolean(),
    hasPermissionsPolicy: v.boolean(),
    score: v.number(),
    grade: v.string(),
    overallScore: v.optional(v.number()),
    performanceScore: v.optional(v.number()),
    seoScore: v.optional(v.number()),
    securityScore: v.optional(v.number()),
    accessibilityScore: v.optional(v.number()),
    technicalHealthScore: v.optional(v.number()),
    performanceChecks: v.optional(categoryScoreValidator),
    seoChecks: v.optional(categoryScoreValidator),
    securityChecks: v.optional(categoryScoreValidator),
    accessibilityChecks: v.optional(categoryScoreValidator),
    technicalHealthChecks: v.optional(categoryScoreValidator),
    issues: v.array(issueValidator),
    topIssues: v.optional(v.array(issueValidator)),
    totalChecksCompleted: v.optional(v.number()),
    totalPassed: v.optional(v.number()),
    totalFailed: v.optional(v.number()),
    totalWarnings: v.optional(v.number()),
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
