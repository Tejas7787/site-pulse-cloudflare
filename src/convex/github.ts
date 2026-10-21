import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { consumeQuota } from "./rateLimit";
import { entitlementsOf } from "./billing";
import {
  GH_ANALYZE_LIMIT_PER_HOUR,
  GH_OAUTH_STATE_TTL_MS,
  REPAIR_PROPOSAL_TTL_MS,
  isValidBranchName,
  isValidRepoFullName,
  isValidRepoPath,
  isValidReturnPath,
} from "../lib/githubRepair";

// ── GitHub Repair Agent (Phase 5) — connection, proposals, approval ──────────
//
// Credential boundary: the OAuth access token lives ONLY on githubConnections
// and is readable ONLY through the internal queries below (server actions).
// No public function in this module returns it — getConnection reports status
// and scopes, never the token. The client secret and token are also never
// logged: every error path in githubActions.ts returns a code or a fixed
// message, never a payload.
//
// This file holds queries/mutations only; all network I/O lives in
// githubActions.ts ("use node"), per the project's Convex layout rule.

/** Everyone here is signed in — the Repair Agent is an account feature. */
async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to use the GitHub Repair Agent.");
  return userId;
}

/** Deployment write switch — OFF unless explicitly enabled by an operator. */
function writeEnabled(): boolean {
  return process.env.GITHUB_WRITE_ENABLED === "true";
}

async function ownConnection(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("githubConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/* ── OAuth connection (server-side code exchange lives in githubActions.ts) ── */

/**
 * Begin the GitHub OAuth round trip: create a one-time, short-lived state
 * bound to THIS signed-in user, and return GitHub's authorize URL. The client
 * secret never appears here — the browser only ever sees client_id + state.
 */
export const startConnection = mutation({
  args: { returnPath: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const clientId = process.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      throw new ConvexError({
        code: "github_not_configured",
        message:
          "GitHub is not configured on this deployment yet (manual setup required — see the deployment notes).",
      });
    }
    // Never leave the open-redirect surface: same-origin paths only.
    const returnPath = isValidReturnPath(args.returnPath) ? args.returnPath : "/";
    const state = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("githubOAuthStates", {
      state,
      userId,
      returnPath,
      createdAt: now,
      expiresAt: now + GH_OAUTH_STATE_TTL_MS,
    });
    const siteUrl = (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${siteUrl}/github/callback`,
      scope: "public_repo", // minimum for this MVP: public repositories, no `repo` (private) grant
      state,
    });
    return { authorizeUrl: `https://github.com/login/oauth/authorize?${params.toString()}` };
  },
});

/**
 * Connection status for the UI. NEVER returns the token — only whether a
 * connection exists, who it is, its scopes, and the deployment's write mode.
 */
export const getConnection = query({
  args: {},
  handler: async (ctx) => {
    const configured = Boolean(process.env.GITHUB_CLIENT_ID);
    const base = { configured, writeEnabled: writeEnabled() };
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ...base, connected: false as const };
    const row = await ownConnection(ctx, userId);
    if (!row) return { ...base, connected: false as const };
    return {
      ...base,
      connected: true as const,
      login: row.login,
      scopes: row.scopes,
      connectedAt: row.connectedAt,
    };
  },
});

/** Disconnect: delete our copy, then best-effort server-side token revoke. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const row = await ownConnection(ctx, userId);
    if (!row) return { disconnected: false };
    await ctx.db.delete(row._id);
    // Revocation is a side effect scheduled after the write — mutations cannot
    // run actions directly, and a failed revoke must never block disconnect.
    // revokeToken itself never throws (it reports { revoked: false } on error).
    ctx.scheduler.runAfter(0, internal.githubActions.revokeToken, { token: row.token });
    return { disconnected: true };
  },
});

/* ── Repair proposals: stored server-side, approved explicitly per proposal ── */

/**
 * Record a proposal generated by the analyze action. Internal-only: clients
 * cannot fabricate proposals (the action validated repo, branch, paths and
 * file contents before this is called).
 */
export const saveProposal = internalMutation({
  args: {
    ownerId: v.id("users"),
    scanId: v.id("scans"),
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
  },
  handler: async (ctx, args) => {
    // Defense in depth: re-validate the strings that will later be used in
    // API paths, even though the action already checked them.
    if (!isValidRepoFullName(args.repoFullName) || !isValidBranchName(args.branch)) {
      throw new ConvexError({ code: "invalid_repo_ref" });
    }
    if (!isValidRepoPath(args.targetPath)) {
      throw new ConvexError({ code: "invalid_path" });
    }
    if (!/^https?:\/\//.test(args.scanUrl) || args.scanUrl.length > 4096) {
      throw new ConvexError({ code: "invalid_scan_url" });
    }
    const now = Date.now();
    return await ctx.db.insert("repairProposals", {
      ...args,
      status: "draft",
      createdAt: now,
      expiresAt: now + REPAIR_PROPOSAL_TTL_MS,
    });
  },
});

/**
 * Explicit approval for ONE specific proposal (the confirmation argument must
 * name this proposal's repository). draft → pr_requested. One-shot: a
 * requested or used proposal can never be approved again.
 */
export const approveAndRequestPr = mutation({
  args: { proposalId: v.id("repairProposals"), confirmRepoFullName: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    // Phase 7: the Repair Agent (proposals + pull requests) is a paid feature
    // (Pro/Agency). Checked before any proposal or repository work so a
    // plan-limited call has no side effects at all.
    const entitlements = await entitlementsOf(ctx, userId);
    if (!entitlements.limits.repairFeatures) {
      throw new ConvexError({
        code: "plan_required",
        plan: entitlements.plan,
        feature: "repair",
        message:
          "The GitHub Repair Agent is included in Pro and Agency plans. Upgrade on /pricing.",
      });
    }
    const proposal = await ctx.db.get(args.proposalId);
    if (!proposal) throw new Error("This proposal no longer exists.");
    if (proposal.ownerId !== userId) {
      throw new Error("This proposal belongs to another account.");
    }
    if (proposal.status === "pr_requested") {
      throw new Error("This proposal has already been approved and requested.");
    }
    if (proposal.status === "pr_created") {
      throw new Error("A pull request was already created from this proposal.");
    }
    if (Date.now() > proposal.expiresAt) {
      throw new Error("This proposal has expired — analyze the repository again.");
    }
    if (args.confirmRepoFullName !== proposal.repoFullName) {
      throw new Error("Confirmation must name this proposal's repository exactly.");
    }
    const now = Date.now();
    await ctx.db.patch(proposal._id, {
      status: "pr_requested",
      approvedAt: now,
      prRequestedAt: now,
    });
    return { status: "pr_requested" as const };
  },
});

/**
 * The signed-in user's proposals (newest first) for the report UI. Deliberately
 * omits `before`/`after` — the rendered `diff` is what the owner reviews; the
 * raw file contents are only needed server-side for the stale-write check.
 */
export const listProposals = query({
  args: { scanId: v.optional(v.id("scans")) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("repairProposals")
      .withIndex("by_owner_created", (q) => q.eq("ownerId", userId))
      .order("desc")
      .take(20);
    const now = Date.now();
    return rows
      .filter((r) => args.scanId === undefined || r.scanId === args.scanId)
      .map((r) => ({
        id: r._id,
        repoFullName: r.repoFullName,
        branch: r.branch,
        issueKey: r.issueKey,
        findingMessage: r.findingMessage,
        category: r.category,
        targetPath: r.targetPath,
        fileExisted: r.fileExisted,
        diff: r.diff,
        explanation: r.explanation,
        status: r.status,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        expired: now > r.expiresAt,
        approvedAt: r.approvedAt,
        prRequestedAt: r.prRequestedAt,
        prNumber: r.prNumber,
        prUrl: r.prUrl,
        prBranch: r.prBranch,
      }));
  },
});

/* ── Internal server-to-server surface ─────────────────────────────────────── */

/**
 * Redemption of an OAuth state: single-use (deleted here), TTL-checked, and
 * bound to the user who created it. Returns the returnPath for the redirect.
 */
export const redeemOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("githubOAuthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();
    if (!row) return null;
    await ctx.db.delete(row._id); // single-use, even when expired
    if (Date.now() > row.expiresAt) return null;
    return { userId: row.userId, returnPath: row.returnPath };
  },
});

/** Called by the OAuth callback action after a verified exchange. */
export const upsertConnection = internalMutation({
  args: {
    userId: v.id("users"),
    login: v.string(),
    scopes: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ownConnection(ctx, args.userId);
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        login: args.login,
        scopes: args.scopes,
        token: args.token,
        connectedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("githubConnections", {
      userId: args.userId,
      provider: "github",
      login: args.login,
      scopes: args.scopes,
      token: args.token,
      connectedAt: now,
    });
  },
});

/**
 * Token access for server actions ONLY (internal — no client path reaches
 * this). Callers pass the authenticated user id they proved; the row is keyed
 * to that user, so one user's token can never serve another user's request.
 */
export const getOwnConnectionSecret = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ownConnection(ctx, args.userId);
    if (!row) return null;
    return { token: row.token, login: row.login };
  },
});

/** Full proposal for the write path — internal, owner-checked by the caller. */
export const getProposalForWrite = internalQuery({
  args: { proposalId: v.id("repairProposals"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.proposalId);
    if (!row || row.ownerId !== args.userId) return null;
    return row;
  },
});

/** The write path records its outcome — internal, after GitHub answered. */
export const markPrCreated = internalMutation({
  args: {
    proposalId: v.id("repairProposals"),
    prNumber: v.number(),
    prUrl: v.string(),
    branchName: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.proposalId);
    if (!row) return;
    await ctx.db.patch(row._id, {
      status: "pr_created",
      prNumber: args.prNumber,
      prUrl: args.prUrl,
      // Audit trail of the NEW branch that was pushed (the source `branch`
      // field stays exactly what the owner selected).
      prBranch: args.branchName,
    });
  },
});

/**
 * Rolling quota for GitHub-backed reads (repositories, branches, analysis) —
 * one key per signed-in user, server-side, same machinery as the scanner.
 */
export const consumeGithubQuota = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const result = await consumeQuota(ctx, {
      key: `github:${args.userId}`,
      limit: GH_ANALYZE_LIMIT_PER_HOUR,
      windowMs: 60 * 60 * 1_000,
    });
    return { ...result, limit: GH_ANALYZE_LIMIT_PER_HOUR };
  },
});

/** Sweep expired OAuth states and stale proposals in bounded batches. */
export const cleanup = internalMutation({
  args: { maxDeletes: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.maxDeletes ?? 100), 1), 500);
    const now = Date.now();
    let deleted = 0;
    const states = await ctx.db
      .query("githubOAuthStates")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
      .take(limit);
    for (const row of states) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    const proposals = await ctx.db
      .query("repairProposals")
      .withIndex("by_expires_at", (q) => q.lt("expiresAt", now))
      .take(limit);
    for (const row of proposals) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    return { deleted };
  },
});
