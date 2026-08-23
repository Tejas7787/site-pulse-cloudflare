import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

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

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // SitePulse scan results
    scans: defineTable({
      url: v.string(),
      finalUrl: v.string(),
      status: v.number(),
      https: v.boolean(),
      redirects: v.number(),
      redirectChain: v.optional(v.array(v.string())),
      responseTime: v.number(),
      pageSize: v.number(),
      pageSizeFormatted: v.string(),

      // SEO
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

      // Content
      imageCount: v.number(),
      imagesWithoutAlt: v.number(),
      linkCount: v.number(),
      scriptCount: v.number(),
      styleCount: v.number(),
      internalLinkCount: v.number(),
      externalLinkCount: v.number(),
      formInputCount: v.number(),
      inputsWithoutLabels: v.number(),

      // Security headers
      hasCSP: v.boolean(),
      hasXFrameOptions: v.boolean(),
      hasXContentTypeOptions: v.boolean(),
      hasStrictTransportSecurity: v.boolean(),
      hasReferrerPolicy: v.boolean(),
      hasPermissionsPolicy: v.boolean(),

      // Category scores
      overallScore: v.number(),
      performanceScore: v.number(),
      seoScore: v.number(),
      securityScore: v.number(),
      accessibilityScore: v.number(),
      technicalHealthScore: v.number(),

      // Checks tracking
      performanceChecks: categoryScoreValidator,
      seoChecks: categoryScoreValidator,
      securityChecks: categoryScoreValidator,
      accessibilityChecks: categoryScoreValidator,
      technicalHealthChecks: categoryScoreValidator,

      // Issues
      issues: v.array(issueValidator),
      topIssues: v.array(issueValidator),
      totalChecksCompleted: v.number(),
      totalPassed: v.number(),
      totalFailed: v.number(),
      totalWarnings: v.number(),

      scannedAt: v.number(),
    })
      .index("by_url", ["url"])
      .index("by_scanned_at", ["scannedAt"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
