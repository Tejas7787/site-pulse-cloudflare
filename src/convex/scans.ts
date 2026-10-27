import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { scanRetentionCutoff } from "./retention";
import { consumeQuota, SAVE_SCAN_LIMIT, SCAN_WINDOW_MS } from "./rateLimit";
import { consumeMonthlyQuota, entitlementsOf } from "./billing";
import { verifyScanReceipt, type ScanReceipt } from "../lib/scanReceipt";

// Bounded batch cleanup of expired scan reports.
// Kept small and explicit so a single invocation can never blow up, and so
// the retry chain has a hard limit.
const DELETE_BATCH_MIN = 1;
const DELETE_BATCH_MAX = 500;
const DELETE_DEFAULT_BATCH = 200;

// Retry/backoff guardrails so a failing deployment cannot schedule itself
// forever or create a rapid scheduling storm.
const DELETE_MAX_RETRY_CHAINS = 5; // total runs, including the first
const DELETE_BACKOFF_MS = 1_500;  // grows with each attempt
const DELETE_BACKOFF_MAX_MS = 30_000;

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
    overallScored: v.optional(v.boolean()),    summary: v.optional(scanSummaryValidator),
    scannedAt: v.number(),
    /** Client-side visitor identity for the storage quota (see handler). */
    visitorId: v.optional(v.string()),
    /**
     * Phase 11A — provenance receipt minted by the scanWebsite action over
     * this exact payload (see src/lib/scanReceipt.ts). Optional at the type
     * level so a missing receipt produces OUR typed invalid_receipt error
     * (reason "missing") instead of a generic argument-validation failure;
     * it is still rejected either way, before any quota or write.
     */
    receipt: v.optional(
      v.object({ exp: v.number(), sig: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    // 0. Provenance (Phase 11A): this mutation is PUBLIC, so the report
    //    content must be proven to come from a server-side scan before
    //    anything else happens. Verification reads the internal-only signing
    //    key (never exposed to clients) and runs BEFORE the quota steps and
    //    BEFORE any insert — a rejected call consumes nothing and writes
    //    nothing. Missing key, missing receipt, bad signature, tampered
    //    payload and expiry all fail closed with a typed reason.
    const { receipt, visitorId, ...doc } = args;
    const keyRow = await ctx.db.query("scanReceiptKeys").first();
    if (!keyRow) {
      throw new ConvexError({ code: "invalid_receipt", reason: "key_unavailable" });
    }
    const verdict = await verifyScanReceipt(doc, receipt as ScanReceipt | undefined, keyRow.key);
    if (!verdict.ok) {
      throw new ConvexError({ code: "invalid_receipt", reason: verdict.reason });
    }

    // Storage-spam protection, server-side: this mutation is public (the
    // anonymous scan flow must be able to persist its report), so a rolling
    // window quota is consumed BEFORE any row is written. The key mirrors the
    // other public endpoints and inherits the documented client-supplied
    // identity limitation (see ./rateLimit.ts) — it bounds bulk inserts, it
    // is not authorization. SAVE_SCAN_LIMIT is 2x SCAN_LIMIT, and the honest
    // flow performs at most one save per successful scan, so legitimate scan
    // completion can never be refused here.
    const visitor = visitorId?.trim().slice(0, 64) || "anonymous";
    const quota = await consumeQuota(ctx, {
      key: `save-scan:${visitor}`,
      limit: SAVE_SCAN_LIMIT,
      windowMs: SCAN_WINDOW_MS,
    });
    if (!quota.allowed) {
      throw new ConvexError({
        code: "rate_limited",
        scope: "save-scan",
        retryAfterMs: quota.retryAfterMs,
        limit: SAVE_SCAN_LIMIT,
      });
    }
    // Only the http(s) URLs the scanner itself produces are storable — see
    // src/convex/scan.ts (scanWebsite normalizes to `parsedUrl.href`), so this
    // cannot reject a legitimate save while capping absurd key/value sizes.
    if (doc.url.length > 8192 || !/^https?:\/\//i.test(doc.url)) {
      throw new ConvexError({ code: "invalid_url", scope: "save-scan" });
    }
    // Phase 7: a SIGNED-IN account additionally consumes its plan's monthly
    // saved-scan quota (server-side entitlement). The anonymous flow above is
    // untouched — it keeps the existing per-visitor hourly rate limit. The
    // quota is consumed only once the row is about to be written, so an
    // invalid save never burns it.
    const userId = await getAuthUserId(ctx);
    if (userId !== null) {
      const { limits, plan } = await entitlementsOf(ctx, userId);
      const monthly = await consumeMonthlyQuota(ctx, {
        userId,
        name: "saved-scans",
        limit: limits.savedScansPerMonth,
      });
      if (!monthly.allowed) {
        throw new ConvexError({
          code: "plan_limit",
          scope: "saved-scans",
          plan,
          limit: monthly.limit,
          message: `Monthly saved-scan limit reached for the ${plan} plan (${monthly.limit}/month). Upgrade on /pricing.`,
        });
      }
    }
    const id = await ctx.db.insert("scans", doc);
    return id;
  },
});

/**
 * Phase 11A — create-once receipt signing key (INTERNAL: callable only from
 * other Convex functions, never from a client). The scanWebsite action
 * generates 32 crypto-random bytes and offers them as `candidate`; the first
 * scan's candidate becomes the deployment's key and later calls simply read
 * it back. Mutations are serializable, so concurrent first scans cannot
 * create two keys. No environment variable and no hardcoded secret: losing
 * the row only invalidates outstanding receipts (clients just rescan).
 */
export const getOrCreateReceiptKey = internalMutation({
  args: { candidate: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("scanReceiptKeys").first();
    if (existing) return existing.key;
    // Defense in depth: only a well-formed 32-byte hex value may become the
    // key, so a bug in a caller can never install a weak key.
    if (!/^[0-9a-f]{64}$/.test(args.candidate)) {
      throw new Error("Invalid receipt key candidate.");
    }
    await ctx.db.insert("scanReceiptKeys", { key: args.candidate, createdAt: Date.now() });
    return args.candidate;
  },
});

export const getScan = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

/**
 * Deletes scan reports older than the retention window (see ./retention.ts).
 * Scheduled by ./crons.ts — internal only, never callable from a client.
 *
 * Safety properties:
 * - Only touches the `scans` table, and only rows whose server-set
 *   `scannedAt` (index `by_scanned_at`) predates the cutoff — it cannot
 *   delete analytics, feedback, users, or any unrelated record.
 * - Bounded batch per run (1–500 rows) so a single invocation stays small.
 * - Progress is drained by chained runs, not an unbounded loop.
 * - Failures are retried a bounded number of times with growing backoff; the
 *   job never schedules itself forever and never reports success when deletion
 *   did not complete.
 * - Report/history UX is unaffected structurally: the report page renders
 *   its "Report Not Found" state for deleted ids, and Landing score history
 *   lives in localStorage independent of these documents.
 */
export const deleteExpiredScans = internalMutation({
  args: { maxDeletes: v.optional(v.number()), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = scanRetentionCutoff(now);
    const max = Math.min(
      Math.max(Math.floor(args.maxDeletes ?? DELETE_DEFAULT_BATCH), DELETE_BATCH_MIN),
      DELETE_BATCH_MAX,
    );

    const attempt = Math.max(Math.floor(args.attempt ?? 1), 1);
    if (attempt > DELETE_MAX_RETRY_CHAINS) {
      // Retry limit reached: stop scheduling and surface the failure so the
      // next cron tick re-derives the backlog from scratch instead of looping.
      return {
        deleted: 0,
        cutoff,
        failed: true,
        reason: `retry limit reached (attempt ${attempt} > ${DELETE_MAX_RETRY_CHAINS})`,
      };
    }

    const expired = await ctx.db
      .query("scans")
      .withIndex("by_scanned_at", (q) => q.lt("scannedAt", cutoff))
      .take(max);

    let deletedCount = 0;
    const failedDocIds: Array<{ _id: string; scannedAt: number }> = [];
    for (const doc of expired) {
      try {
        await ctx.db.delete(doc._id);
        deletedCount += 1;
      } catch {
        // Track failures per document so the caller can tell success from
        // partial failure without stopping the rest of the batch.
        failedDocIds.push({ _id: doc._id, scannedAt: doc.scannedAt ?? 0 });
      }
    }

    // Only schedule another run when the batch was full *and* every document
    // in it was deleted.  A partial success is reported honestly rather than
    // silently treated as a completed run.
    if (
      expired.length === max &&
      failedDocIds.length === 0 &&
      attempt < DELETE_MAX_RETRY_CHAINS
    ) {
      const nextWait = Math.min(
        DELETE_BACKOFF_MS * attempt,
        DELETE_BACKOFF_MAX_MS,
      );
      ctx.scheduler.runAfter(
        nextWait,
        internal.scans.deleteExpiredScans,
        { maxDeletes: max, attempt: attempt + 1 },
      );
    }

    const partialFailure = failedDocIds.length > 0;

    return {
      deleted: deletedCount,
      cutoff,
      failed: partialFailure,
      failedCount: partialFailure ? failedDocIds.length : undefined,
      reason:
        partialFailure
          ? `deleted ${deletedCount} of ${expired.length} expired rows`
          : undefined,
    };
  },
});
