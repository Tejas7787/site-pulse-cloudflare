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

      // Content
      imageCount: v.number(),
      imagesWithoutAlt: v.number(),
      linkCount: v.number(),
      scriptCount: v.number(),
      styleCount: v.number(),
      internalLinkCount: v.number(),
      externalLinkCount: v.number(),
      formInputCount: v.optional(v.number()),
      inputsWithoutLabels: v.optional(v.number()),

      // Security headers
      hasCSP: v.boolean(),
      hasXFrameOptions: v.boolean(),
      hasXContentTypeOptions: v.boolean(),
      hasStrictTransportSecurity: v.boolean(),
      hasXPermittedCrossDomainPolicies: v.boolean(),
      hasReferrerPolicy: v.boolean(),
      hasPermissionsPolicy: v.boolean(),

      // Health score & grade (consumed by UI)
      score: v.number(),
      grade: v.string(),

      // Category scores
      overallScore: v.optional(v.number()),
      performanceScore: v.optional(v.number()),
      seoScore: v.optional(v.number()),
      securityScore: v.optional(v.number()),
      accessibilityScore: v.optional(v.number()),
      technicalHealthScore: v.optional(v.number()),

      // Checks tracking
      performanceChecks: v.optional(categoryScoreValidator),
      seoChecks: v.optional(categoryScoreValidator),
      securityChecks: v.optional(categoryScoreValidator),
      accessibilityChecks: v.optional(categoryScoreValidator),
      technicalHealthChecks: v.optional(categoryScoreValidator),

      // Issues
      issues: v.array(issueValidator),
      topIssues: v.optional(v.array(issueValidator)),
      totalChecksCompleted: v.optional(v.number()),
      totalPassed: v.optional(v.number()),
      totalFailed: v.optional(v.number()),
      totalWarnings: v.optional(v.number()),

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
