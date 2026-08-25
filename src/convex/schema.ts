import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

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
  severity: v.union(v.literal("critical"), v.literal("warning"), v.literal("info")),
  priority: v.union(v.literal("critical"), v.literal("important"), v.literal("recommended"), v.literal("nice-to-have")),
  message: v.string(),
  whyItMatters: v.string(),
  howToFix: v.string(),
});

const quickWinValidator = v.object({
  category: v.string(),
  message: v.string(),
  potentialGain: v.number(),
  priority: v.union(v.literal("critical"), v.literal("important"), v.literal("recommended"), v.literal("nice-to-have")),
});

const sslInfoValidator = v.object({
  valid: v.boolean(),
  issuer: v.string(),
  expiryDate: v.string(),
  daysUntilExpiry: v.number(),
  serialNumber: v.string(),
  subjectAltNames: v.array(v.string()),
});

const cookieInfoValidator = v.object({
  name: v.string(),
  httpOnly: v.boolean(),
  secure: v.boolean(),
  sameSite: v.optional(v.string()),
  domain: v.optional(v.string()),
});

const mixedContentValidator = v.object({
  url: v.string(),
  type: v.union(v.literal("script"), v.literal("image"), v.literal("stylesheet"), v.literal("other")),
  lineNumber: v.number(),
});

const serverInfoValidator = v.object({
  server: v.optional(v.string()),
  poweredBy: v.optional(v.string()),
  technology: v.array(v.string()),
  framework: v.optional(v.string()),
});

const siteIdentityValidator = v.object({
  hasPrivacyPolicy: v.boolean(),
  hasTermsOfService: v.boolean(),
  hasContactInfo: v.boolean(),
  hasOrganization: v.boolean(),
  organizationName: v.optional(v.string()),
});

const schema = defineSchema(
  {
    ...authTables,

    users: defineTable({
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      email: v.optional(v.string()),
      emailVerificationTime: v.optional(v.number()),
      isAnonymous: v.optional(v.boolean()),
      role: v.optional(roleValidator),
    }).index("email", ["email"]),

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

      ssl: v.optional(sslInfoValidator),
      cookies: v.optional(v.array(cookieInfoValidator)),
      cookiesWithIssues: v.optional(v.number()),
      mixedContent: v.optional(v.array(mixedContentValidator)),
      mixedContentCount: v.optional(v.number()),
      serverInfo: v.optional(serverInfoValidator),
      siteIdentity: v.optional(siteIdentityValidator),

      score: v.number(),
      grade: v.string(),
      riskLevel: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical"))),
      betterThanPercent: v.optional(v.number()),

      performanceScore: v.number(),
      seoScore: v.number(),
      securityScore: v.number(),
      accessibilityScore: v.number(),
      technicalHealthScore: v.number(),
      sslScore: v.optional(v.number()),
      cookieScore: v.optional(v.number()),
      mixedContentScore: v.optional(v.number()),

      performanceChecks: categoryScoreValidator,
      seoChecks: categoryScoreValidator,
      securityChecks: categoryScoreValidator,
      accessibilityChecks: categoryScoreValidator,
      technicalHealthChecks: categoryScoreValidator,

      issues: v.array(issueValidator),
      topIssues: v.array(issueValidator),
      quickWins: v.array(quickWinValidator),
      totalChecksCompleted: v.number(),
      totalPassed: v.number(),
      totalFailed: v.number(),
      totalWarnings: v.number(),

      scannedAt: v.number(),
    })
      .index("by_url", ["url"])
      .index("by_scanned_at", ["scannedAt"]),

    // First-party, privacy-friendly product analytics (no PII, no fingerprinting)
    analyticsEvents: defineTable({
      name: v.string(), // page_view | scan_started | scan_completed | scan_failed | report_viewed | share_report_clicked
      visitorId: v.string(), // random ID stored in the visitor's localStorage (not a fingerprint)
      sessionId: v.string(), // random ID stored in sessionStorage (resets when the tab closes)
      path: v.optional(v.string()), // e.g. "/", "/report/:id"
      referrer: v.optional(v.string()), // external referrer host only, captured once per session
      device: v.optional(v.string()), // coarse category: mobile | tablet | desktop | other
      targetUrl: v.optional(v.string()), // for scan events: the URL that was scanned
      createdAt: v.number(),
    })
      .index("by_name_created", ["name", "createdAt"])
      .index("by_created", ["createdAt"]),

    // Optional user feedback submitted from the footer form. Admin-only access.
    feedback: defineTable({
      rating: v.number(), // 1–5
      thought: v.optional(v.string()), // what did you think
      improve: v.optional(v.string()), // what should we improve
      featureRequest: v.optional(v.string()), // next feature
      problem: v.optional(v.string()), // problems found
      email: v.optional(v.string()), // optional contact address
      path: v.optional(v.string()), // page it was submitted from
      createdAt: v.number(),
    }).index("by_created", ["createdAt"]),
  },
  { schemaValidation: false },
);

export default schema;
