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

// ── Phase 7: billing & subscriptions ─────────────────────────────────────────
// Mirrors src/lib/billing/plans.ts. Kept as validators (not imported types)
// so the schema stays self-contained, exactly like roleValidator above.
const planValidator = v.union(
  v.literal("free"),
  v.literal("pro"),
  v.literal("agency"),
);
const currencyValidator = v.union(v.literal("INR"), v.literal("USD"));
const subscriptionStatusValidator = v.union(
  v.literal("active"),
  v.literal("trialing"),
  v.literal("past_due"),
  v.literal("canceled"),
  v.literal("expired"),
);
const billingProviderValidator = v.union(
  v.literal("simulated"),
  v.literal("stripe"),
  v.literal("razorpay"),
);

const categoryScoreValidator = v.object({
  score: v.number(),
  passed: v.number(),
  failed: v.number(),
  warnings: v.number(),
  notChecked: v.number(),
  // Evidence-based scoring extensions (optional so old reports still load)
  applicable: v.optional(v.number()),
  unverified: v.optional(v.number()),
  notApplicable: v.optional(v.number()),
  hasScore: v.optional(v.boolean()),
  formula: v.optional(v.string()),
  factors: v.optional(v.array(v.string())),
});

const issueValidator = v.object({
  category: v.string(),
  severity: v.union(v.literal("critical"), v.literal("warning"), v.literal("info")),
  priority: v.union(v.literal("critical"), v.literal("important"), v.literal("recommended"), v.literal("nice-to-have")),
  message: v.string(),
  whyItMatters: v.string(),
  howToFix: v.string(),
  // Evidence trail (optional so old reports still load)
  evidence: v.optional(v.string()),
  evidenceUrl: v.optional(v.string()),
  stage: v.optional(v.string()),
  method: v.optional(v.union(v.literal("http"), v.literal("tls"), v.literal("browser"))),
  checkKey: v.optional(v.string()),
  detectedAt: v.optional(v.number()),
  confirmed: v.optional(v.boolean()),
  status: v.optional(v.union(v.literal("fail"), v.literal("warning"), v.literal("unable-to-verify"))),
});

const scanSummaryValidator = v.object({
  completeness: v.union(v.literal("complete"), v.literal("partial"), v.literal("blocked")),
  limitations: v.array(v.string()),
  requestedUrl: v.string(),
  finalUrl: v.string(),
  status: v.number(),
  redirects: v.number(),
  redirectChain: v.array(v.string()),
  contentType: v.optional(v.string()),
  durationMs: v.number(),
  method: v.string(),
  browserChecks: v.string(),
  blocked: v.boolean(),
  blockReason: v.optional(v.string()),
  notHtml: v.boolean(),
  incomplete: v.boolean(),
  counts: v.object({
    passed: v.number(),
    failed: v.number(),
    warnings: v.number(),
    notApplicable: v.number(),
    unverified: v.number(),
    total: v.number(),
  }),
  categoryFormula: v.string(),
  overallFormula: v.string(),
  performanceBasis: v.string(),
  overallScored: v.boolean(),
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

// ── Phase 2: automatic uptime monitoring ─────────────────────────────────────
// Three outcome states a probe can produce, plus the config-error state.
const probeResultValidator = v.union(
  v.literal("ok"),
  v.literal("down"),
  v.literal("blocked"), // bot wall / auth wall / rate limit: not evidence of downtime
  v.literal("error"),   // invalid or unsafe URL: a config problem, not downtime
);

const monitorStateValidator = v.union(
  v.literal("up"),
  v.literal("suspect"), // one failed check, awaiting confirmation
  v.literal("down"),
  v.literal("unknown"), // created but nothing verified yet
);

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
      totalUnverified: v.optional(v.number()),
      totalNotApplicable: v.optional(v.number()),
      overallScored: v.optional(v.boolean()),
      summary: v.optional(scanSummaryValidator),

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

    // Rolling-window counters for the public endpoints (currently: scans).
    // One document per key; the window resets in place, and stale keys are
    // swept by the retention cron.
    rateLimits: defineTable({
      key: v.string(), // e.g. "scan:<visitorId>"
      windowStart: v.number(), // epoch ms when the current window opened
      count: v.number(), // requests consumed inside this window
    }).index("by_key", ["key"])
      .index("by_window_start", ["windowStart"]),

    // A website the owner wants watched on a recurring schedule. Probing runs
    // entirely server-side (crons.ts → monitors.dispatchDue → probe.probe);
    // no browser needs to be open. Interval and per-owner caps live in
    // src/lib/monitoring.ts.
    monitors: defineTable({
      ownerId: v.id("users"),
      name: v.string(),
      url: v.string(),
      host: v.string(),
      intervalMs: v.number(),
      status: v.union(v.literal("active"), v.literal("paused")),
      state: monitorStateValidator,
      /** When the dispatcher should consider this monitor due next. */
      nextCheckAt: v.number(),
      lastDispatchedAt: v.optional(v.number()),
      lastCheckedAt: v.optional(v.number()),
      lastResult: v.optional(probeResultValidator),
      lastHttpStatus: v.optional(v.number()),
      lastDurationMs: v.optional(v.number()),
      consecutiveFailures: v.number(),
      consecutiveSuccesses: v.number(),
      /** Where alerts go; falls back to the owner's account email. */
      alertEmail: v.optional(v.string()),
      createdAt: v.number(),
      pausedAt: v.optional(v.number()),
    })
      .index("by_owner", ["ownerId", "createdAt"])
      .index("by_due", ["status", "nextCheckAt"]),

    // One row per scheduled probe. The 30-day sweep (retention.ts) is what
    // keeps this table — the bulk of Phase 2's writes — bounded.
    uptimeChecks: defineTable({
      monitorId: v.id("monitors"),
      checkedAt: v.number(),
      /** Dispatch time of the probe that produced this row (ordering key). */
      dispatchedAt: v.number(),
      result: probeResultValidator,
      httpStatus: v.optional(v.number()),
      durationMs: v.optional(v.number()),
      /** Stable detail string: "timeout", "http-503", "blocked", … */
      detail: v.optional(v.string()),
      attempt: v.number(),
    })
      .index("by_monitor_checked", ["monitorId", "checkedAt"])
      .index("by_checked_at", ["checkedAt"]),

    // A confirmed outage: opened only after FAILURES_TO_DECLARE_DOWN
    // consecutive failed checks, closed after SUCCESSES_TO_RECOVER successes.
    incidents: defineTable({
      monitorId: v.id("monitors"),
      kind: v.union(v.literal("down")),
      open: v.boolean(),
      openedAt: v.number(),
      closedAt: v.optional(v.number()),
      recoveredAt: v.optional(v.number()),
      reason: v.string(),
      failureCount: v.number(),
      /** Set once the outage email for this incident has been enqueued. */
      alertedAt: v.optional(v.number()),
      recoveryAlertedAt: v.optional(v.number()),
    })
      .index("by_monitor_open", ["monitorId", "open", "openedAt"])
      .index("by_opened_at", ["openedAt"]),

    // Outbox for downtime/recovery emails: written first (idempotently), then
    // sent by an action — a side effect Convex never auto-retries for us.
    alertDeliveries: defineTable({
      monitorId: v.id("monitors"),
      incidentId: v.id("incidents"),
      kind: v.union(v.literal("downtime"), v.literal("recovery")),
      to: v.string(),
      subject: v.string(),
      text: v.string(),
      status: v.union(v.literal("queued"), v.literal("sent"), v.literal("failed")),
      createdAt: v.number(),
      sentAt: v.optional(v.number()),
      providerId: v.optional(v.string()),
      error: v.optional(v.string()),    }).index("by_incident_kind", ["incidentId", "kind"])
      .index("by_status_created", ["status", "createdAt"])
      .index("by_created", ["createdAt"]),

    // ── Phase 5: GitHub Repair Agent ─────────────────────────────────────
    // One-shot OAuth states: created by an authenticated mutation, redeemed
    // once by the HTTP callback, then deleted. Short TTL, swept by crons.
    githubOAuthStates: defineTable({
      state: v.string(),
      userId: v.id("users"),
      /** Same-origin path to return the browser to after the round trip. */
      returnPath: v.string(),
      createdAt: v.number(),
      expiresAt: v.number(),
    })
      .index("by_state", ["state"])
      .index("by_expires_at", ["expiresAt"]),

    // Server-side GitHub connection. `token` is the user's OAuth access token:
    // it is written ONLY by the callback action, read ONLY by server actions
    // through an internal query, and NEVER returned by any public function.
    githubConnections: defineTable({
      userId: v.id("users"),
      provider: v.literal("github"),
      login: v.string(),
      /** Token scopes GitHub granted — shown to the user, never the token. */
      scopes: v.string(),
      token: v.string(),
      connectedAt: v.number(),
    }).index("by_user", ["userId"]),

    // A code-aware repair proposal: generated server-side from a saved scan
    // finding + repository file, reviewed by the owner, then (and only then)
    // usable to request a pull request. `before`/`after` stay server-side for
    // the stale-write check; clients receive the rendered diff instead.
    repairProposals: defineTable({
      ownerId: v.id("users"),
      scanId: v.id("scans"),
      /** The scanned site's URL (for PR text); validated at save time. */
      scanUrl: v.string(),
      repoFullName: v.string(),
      branch: v.string(),
      issueKey: v.string(),
      findingMessage: v.string(),
      category: v.string(),
      targetPath: v.string(),
      fileExisted: v.boolean(),
      before: v.string(),
      after: v.string(),
      diff: v.string(),
      explanation: v.string(),
      /** draft → (explicit approval) → pr_requested → pr_created. */
      status: v.union(
        v.literal("draft"),
        v.literal("pr_requested"),
        v.literal("pr_created"),
      ),
      createdAt: v.number(),
      expiresAt: v.number(),
      approvedAt: v.optional(v.number()),
      prRequestedAt: v.optional(v.number()),
      prNumber: v.optional(v.number()),
      prUrl: v.optional(v.string()),
      /** The NEW branch the PR used (never the source branch / default). */
      prBranch: v.optional(v.string()),
    })
      .index("by_owner_created", ["ownerId", "createdAt"])
      .index("by_expires_at", ["expiresAt"]),

    // ── Phase 6: agency workspace ───────────────────────────────────────────
    // One workspace per user (owner or member — never both, never two). Every
    // member row below is the ONLY authority for "may this user act on this
    // agency"; nothing ever trusts a client-submitted email or agency id.
    agencies: defineTable({
      ownerId: v.id("users"),
      name: v.string(),
      /** Optional branding image; http(s) URL only (validated at write time). */
      logoUrl: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_owner", ["ownerId"]),

    agencyMembers: defineTable({
      agencyId: v.id("agencies"),
      userId: v.id("users"),
      /** "owner" manages members, invites and branding; "member" runs clients. */
      role: v.union(v.literal("owner"), v.literal("member")),
      createdAt: v.number(),
    })
      .index("by_agency", ["agencyId"])
      .index("by_agency_user", ["agencyId", "userId"])
      .index("by_user", ["userId"]),

    clients: defineTable({
      agencyId: v.id("agencies"),
      name: v.string(),
      /** Free-form contact label ("Dana @ Acme") — never an auth signal. */
      contact: v.optional(v.string()),
      notes: v.optional(v.string()),
      archived: v.boolean(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_agency_archived", ["agencyId", "archived"])
      .index("by_agency_created", ["agencyId", "createdAt"]),

    // Assignment of an existing monitor (a website the ACTING user personally
    // owns) to a client of their agency. Ownership of the monitor is verified
    // server-side at assignment time; a monitor can be assigned at most once
    // (enforced through by_monitor).
    clientWebsites: defineTable({
      agencyId: v.id("agencies"),
      clientId: v.id("clients"),
      monitorId: v.id("monitors"),
      addedById: v.id("users"),
      createdAt: v.number(),
    })
      .index("by_agency", ["agencyId"])
      .index("by_agency_client", ["agencyId", "clientId"])
      .index("by_monitor", ["monitorId"]),

    // Team invitations: the token is a bearer secret handed to the owner to
    // pass along out of band. Accepting needs BOTH the token AND a signed-in
    // account whose own (already-verified) email matches the invited address —
    // an email alone, or a leaked link alone, grants nothing.
    agencyInvites: defineTable({
      agencyId: v.id("agencies"),
      email: v.string(),
      token: v.string(),
      invitedBy: v.id("users"),
      createdAt: v.number(),
      expiresAt: v.number(),
      acceptedAt: v.optional(v.number()),
      acceptedById: v.optional(v.id("users")),
      revokedAt: v.optional(v.number()),
    })
      .index("by_token", ["token"])
      .index("by_agency", ["agencyId"]),

    // One subscription row per user (Phase 7). Absence of a row means the
    // Free plan — existing users need no migration. Entitlements are derived
    // server-side from this row ONLY; the client can never assert a plan,
    // status, amount or currency (checkout amounts come from the catalog).
    subscriptions: defineTable({
      userId: v.id("users"),
      plan: planValidator,
      status: subscriptionStatusValidator,
      currency: currencyValidator,
      provider: billingProviderValidator,
      /** Stripe customer / Razorpay customer id (real providers, test mode). */
      providerCustomerId: v.optional(v.string()),
      /** Stripe subscription / Razorpay subscription id (test mode). */
      providerSubscriptionId: v.optional(v.string()),
      /** Minor units (paise/cents), captured from the catalog at checkout. */
      amountPerPeriod: v.number(),
      currentPeriodStart: v.number(),
      currentPeriodEnd: v.number(),
      cancelAtPeriodEnd: v.boolean(),
      /** Grace deadline set when a renewal failed (fail-closed window). */
      pastDueGraceUntil: v.optional(v.number()),
      /** Highest provider event timestamp already applied (out-of-order guard). */
      lastProviderEventAt: v.optional(v.number()),
      startedAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_provider_sub", ["providerSubscriptionId"]),

    // A pending or completed checkout. The server computes plan, currency and
    // amount when it is created; completing a checkout never accepts those
    // values from the client — a simulated "provider event" can only flip a
    // row this server created for THIS user.
    billingCheckouts: defineTable({
      userId: v.id("users"),
      plan: planValidator,
      currency: currencyValidator,
      amount: v.number(),
      provider: billingProviderValidator,
      status: v.union(
        v.literal("pending"),
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("expired"),
      ),
      failureReason: v.optional(v.string()),
      providerCheckoutId: v.optional(v.string()),
      createdAt: v.number(),
      expiresAt: v.number(),
      completedAt: v.optional(v.number()),
    })
      .index("by_user_created", ["userId", "createdAt"])
      .index("by_provider_checkout", ["providerCheckoutId"]),

    // Append-only billing audit log: EVERY provider event (applied, duplicate,
    // stale or rejected) is recorded here with a dedupe key. Replays of a
    // delivery are detected by `by_dedupe` before any state changes.
    billingEvents: defineTable({
      provider: billingProviderValidator,
      providerEventId: v.string(),
      type: v.string(),
      dedupeKey: v.string(),
      outcome: v.union(
        v.literal("applied"),
        v.literal("duplicate"),
        v.literal("stale"),
        v.literal("rejected"),
        v.literal("ignored"),
      ),
      detail: v.optional(v.string()),
      userId: v.optional(v.id("users")),
      createdAt: v.number(),
    }).index("by_dedupe", ["dedupeKey"]),

    // Monthly per-account usage counters (key = "<userId>:<YYYY-MM>:<name>").
    // Used for the saved-scans quota; kept generic so future monthly quotas
    // reuse it. Counters are best-effort (races may overshoot by one) — they
    // bound honest usage, they are not a security boundary.
    billingUsage: defineTable({
      key: v.string(),
      count: v.number(),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),
  },
  { schemaValidation: false },
);

export default schema;
