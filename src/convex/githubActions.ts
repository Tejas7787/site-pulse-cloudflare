"use node";

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { issueKey, platformFromScan } from "../lib/recommendations";
import {
  GITHUB_API_BASE,
  GH_MAX_FILE_BYTES,
  applyRepair,
  isValidBranchName,
  isValidRepoFullName,
  isValidRepoPath,
  parseBranches,
  parseFileContent,
  parseRepos,
  prBodyFor,
  prTitleFor,
  repairBranchName,
  sanitizeTree,
  selectRepairTarget,
  unifiedDiff,
} from "../lib/githubRepair";

// ── GitHub Repair Agent (Phase 5) — every network call to GitHub ─────────────
//
// Rules enforced here (and pinned in tests/githubRepair.test.ts):
//  * Auth first: every action resolves the signed-in user, then fetches the
//    connection row FOR THAT USER (internal, server-to-server only).
//  * The OAuth token is passed to fetch headers only — never logged, never
//    returned, never embedded in a message. Errors carry fixed strings or a
//    GitHub HTTP status number, nothing else.
//  * Reads are quota-gated (github:<user>, per hour) and file/tree/size caps
//    come from src/lib/githubRepair.ts.
//  * The write path checks its OFF-by-default switch BEFORE any external
//    call, requires a per-proposal approval recorded server-side, refuses
//    stale files, and only ever pushes a NEW `sitepulse/repair-*` branch —
//    never the default branch, never a merge, never a deploy.

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SitePulse-Repair-Agent",
  };
}

async function requireAuthUser(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to use the GitHub Repair Agent.");
  return userId;
}

/** Parse a GitHub response body defensively (it is untrusted input). */
async function ghJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* ── OAuth: code → token, entirely server-side ─────────────────────────────── */

/**
 * Redeem the one-time state, exchange the authorization code for an access
 * token (client secret used here, server-side), verify it by reading the
 * account login, and store the connection. The token appears in no log line
 * and no URL — only in the request body to GitHub and the database write.
 */
export const exchangeOAuthCode = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; returnPath: string; error?: string; login?: string }> => {
    // State: single-use and TTL-checked; also pins the return path.
    const redeemed = await ctx.runMutation(internal.github.redeemOAuthState, {
      state: args.state,
    });
    if (!redeemed) {
      return { ok: false, returnPath: "/", error: "invalid_state" };
    }
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { ok: false, returnPath: redeemed.returnPath, error: "not_configured" };
    }

    // 2. Code → token (server-to-server; secret never reaches the browser).
    let token: string;
    let scope: string;
    try {
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "SitePulse-Repair-Agent",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: args.code,
          redirect_uri: `${(process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "")}/github/callback`,
        }),
      });
      const data = (await ghJson(res)) as {
        access_token?: unknown;
        scope?: unknown;
        error?: unknown;
      } | null;
      if (!res.ok || !data || typeof data.access_token !== "string" || !data.access_token) {
        // Codes only — never the response body (it could echo request data).
        const code = typeof data?.error === "string" ? data.error : `http_${res.status}`;
        return { ok: false, returnPath: redeemed.returnPath, error: code };
      }
      token = data.access_token;
      scope = typeof data.scope === "string" ? data.scope : "";
    } catch {
      return { ok: false, returnPath: redeemed.returnPath, error: "exchange_failed" };
    }

    // 3. Verify the token and learn the account login.
    try {
      const userRes = await fetch(`${GITHUB_API_BASE}/user`, { headers: ghHeaders(token) });
      if (!userRes.ok) {
        return { ok: false, returnPath: redeemed.returnPath, error: "user_lookup_failed" };
      }
      const ghUser = (await ghJson(userRes)) as { login?: unknown } | null;
      const login = typeof ghUser?.login === "string" ? ghUser.login : "";
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
        return { ok: false, returnPath: redeemed.returnPath, error: "user_lookup_failed" };
      }
      await ctx.runMutation(internal.github.upsertConnection, {
        userId: redeemed.userId,
        login,
        scopes: scope,
        token,
      });
      return { ok: true, returnPath: redeemed.returnPath, login };
    } catch {
      return { ok: false, returnPath: redeemed.returnPath, error: "user_lookup_failed" };
    }
  },
});

/**
 * Best-effort server-side revocation of the token with GitHub (OAuth
 * applications can revoke their own grants). Failures are swallowed — the
 * local row is already deleted by the disconnect mutation.
 */
export const revokeToken = internalAction({
  args: { token: v.string() },
  handler: async (_ctx, args): Promise<{ revoked: boolean }> => {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) return { revoked: false };
    try {
      const res = await fetch(
        `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "SitePulse-Repair-Agent",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          },
          body: JSON.stringify({ access_token: args.token }),
        },
      );
      return { revoked: res.ok };
    } catch {
      return { revoked: false };
    }
  },
});

/* ── Read APIs (quota-gated, connection-scoped) ────────────────────────────── */

type ReadFailure =
  | { kind: "not_connected" }
  | { kind: "auth_expired"; message: string }
  | { kind: "quota_limited"; retryAfterMs: number; limit: number }
  | { kind: "github_error"; message: string };

const AUTH_EXPIRED: ReadFailure = {
  kind: "auth_expired",
  message:
    "GitHub no longer accepts this connection — disconnect it and connect again. Nothing was changed.",
};

export const listRepositories = action({
  args: {},
  handler: async (ctx): Promise<ReadFailure | { kind: "ok"; repos: ReturnType<typeof parseRepos> }> => {
    const userId = await requireAuthUser(ctx);
    const quota = await ctx.runMutation(internal.github.consumeGithubQuota, { userId });
    if (!quota.allowed) {
      return { kind: "quota_limited", retryAfterMs: quota.retryAfterMs, limit: quota.limit };
    }
    const secret = await ctx.runQuery(internal.github.getOwnConnectionSecret, { userId });
    if (!secret) return { kind: "not_connected" };
    try {
      const res = await fetch(`${GITHUB_API_BASE}/user/repos?per_page=100&sort=updated`, {
        headers: ghHeaders(secret.token),
      });
      if (res.status === 401) return AUTH_EXPIRED;
      if (!res.ok) {
        return { kind: "github_error", message: `GitHub returned HTTP ${res.status} while listing repositories.` };
      }
      return { kind: "ok", repos: parseRepos(await ghJson(res)) };
    } catch {
      return { kind: "github_error", message: "Could not reach GitHub to list repositories. Try again shortly." };
    }
  },
});

export const listBranches = action({
  args: { repoFullName: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<ReadFailure | { kind: "ok"; branches: string[] }> => {
    const userId = await requireAuthUser(ctx);
    if (!isValidRepoFullName(args.repoFullName)) {
      return { kind: "github_error", message: "That repository name is not valid." };
    }
    const quota = await ctx.runMutation(internal.github.consumeGithubQuota, { userId });
    if (!quota.allowed) {
      return { kind: "quota_limited", retryAfterMs: quota.retryAfterMs, limit: quota.limit };
    }
    const secret = await ctx.runQuery(internal.github.getOwnConnectionSecret, { userId });
    if (!secret) return { kind: "not_connected" };
    try {
      const res = await fetch(`${GITHUB_API_BASE}/repos/${args.repoFullName}/branches?per_page=100`, {
        headers: ghHeaders(secret.token),
      });
      if (res.status === 401) return AUTH_EXPIRED;
      if (res.status === 404) {
        return { kind: "github_error", message: "That repository or branch list is not visible to this connection." };
      }
      if (!res.ok) {
        return { kind: "github_error", message: `GitHub returned HTTP ${res.status} while listing branches.` };
      }
      return { kind: "ok", branches: parseBranches(await ghJson(res)) };
    } catch {
      return { kind: "github_error", message: "Could not reach GitHub to list branches. Try again shortly." };
    }
  },
});

/* ── Analysis: finding + repository → reviewable proposal ──────────────────── */

export const analyzeRepair = action({
  args: {
    scanId: v.id("scans"),
    issueKey: v.string(),
    repoFullName: v.string(),
    branch: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | ReadFailure
    | { kind: "invalid_input"; message: string }
    | { kind: "not_found" }
    | { kind: "unsupported"; reason: string }
    | {
        kind: "ok";
        proposalId: Id<"repairProposals">;
        targetPath: string;
        fileExisted: boolean;
        diff: string;
        explanation: string;
      }
  > => {
    const userId = await requireAuthUser(ctx);
    // Client strings that will be used in API paths — validate before use.
    if (!isValidRepoFullName(args.repoFullName) || !isValidBranchName(args.branch)) {
      return { kind: "invalid_input", message: "Repository or branch name is not valid." };
    }
    const quota = await ctx.runMutation(internal.github.consumeGithubQuota, { userId });
    if (!quota.allowed) {
      return { kind: "quota_limited", retryAfterMs: quota.retryAfterMs, limit: quota.limit };
    }
    const secret = await ctx.runQuery(internal.github.getOwnConnectionSecret, { userId });
    if (!secret) return { kind: "not_connected" };

    // Trusted input: the SAVED scan (same pattern as proposeFixes) — the
    // finding is looked up by identity inside the stored document.
    const scan = await ctx.runQuery(api.scans.getScan, { id: args.scanId });
    if (!scan) return { kind: "not_found" };
    const issue = scan.issues.find((i) => issueKey(i) === args.issueKey);
    if (!issue) return { kind: "not_found" };
    let scanOrigin: string;
    try {
      const parsed = new URL(scan.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
      scanOrigin = parsed.origin;
    } catch {
      return {
        kind: "unsupported",
        reason: "The saved scan's URL could not be validated — manual fix required.",
      };
    }

    // Tree discovery (recursive, capped, sanitized: valid non-secret blobs only).
    let treeJson: unknown;
    try {
      const res = await fetch(
        `${GITHUB_API_BASE}/repos/${args.repoFullName}/git/trees/${encodeURIComponent(args.branch)}?recursive=1`,
        { headers: ghHeaders(secret.token) },
      );
      if (res.status === 401) return AUTH_EXPIRED;
      if (res.status === 404 || res.status === 403) {
        return {
          kind: "github_error",
          message: `GitHub did not grant access to that repository or branch (HTTP ${res.status}) — check that your connection can see ${args.repoFullName}.`,
        };
      }
      if (!res.ok) {
        return { kind: "github_error", message: `GitHub returned HTTP ${res.status} while reading the repository tree.` };
      }
      treeJson = await ghJson(res);
    } catch {
      return { kind: "github_error", message: "Could not reach GitHub to read the repository tree. Try again shortly." };
    }
    const tree = sanitizeTree(treeJson);
    if (tree.truncated) {
      return {
        kind: "unsupported",
        reason:
          "The repository tree is too large or malformed for safe file discovery (GitHub truncated the response) — manual fix required.",
      };
    }

    // Deterministic target discovery from the saved finding.
    const platform = platformFromScan(scan.serverInfo ?? {});
    const selection = selectRepairTarget(issue, platform, tree.entries);
    if (selection.kind === "unsupported") return { kind: "unsupported", reason: selection.reason };

    // Read at most one file (the target), path-validated, size-capped.
    let existed = false;
    let before = "";
    if (selection.kind === "read") {
      if (!isValidRepoPath(selection.path)) {
        return { kind: "unsupported", reason: "The discovered file path failed validation — manual fix required." };
      }
      try {
        const encodedPath = selection.path.split("/").map(encodeURIComponent).join("/");
        const res = await fetch(
          `${GITHUB_API_BASE}/repos/${args.repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(args.branch)}`,
          { headers: ghHeaders(secret.token) },
        );
        if (res.status === 401) return AUTH_EXPIRED;
        if (res.status === 404) {
          return { kind: "github_error", message: "The target file disappeared between discovery and read — try again." };
        }
        if (!res.ok) {
          return { kind: "github_error", message: `GitHub returned HTTP ${res.status} while reading the target file.` };
        }
        const parsed = parseFileContent(await ghJson(res));
        if (!parsed.ok) {
          return {
            kind: "unsupported",
            reason:
              parsed.reason === "too_large"
                ? `The target file exceeds the ${GH_MAX_FILE_BYTES}-byte read limit — manual fix required.`
                : "The target file could not be decoded safely — manual fix required.",
          };
        }
        existed = true;
        before = parsed.text;
      } catch {
        return { kind: "github_error", message: "Could not reach GitHub to read the target file. Try again shortly." };
      }
    }

    // Deterministic edit on the real file text → real unified diff.
    const plan = applyRepair({
      issue,
      platform,
      scanOrigin,
      targetPath: selection.path,
      existed,
      before,
    });
    if (plan.kind === "unsupported") return { kind: "unsupported", reason: plan.reason };
    const diff = unifiedDiff(plan.before, plan.after, plan.targetPath);

    const proposalId = await ctx.runMutation(internal.github.saveProposal, {
      ownerId: userId,
      scanId: args.scanId,
      scanUrl: scan.url,
      repoFullName: args.repoFullName,
      branch: args.branch,
      issueKey: args.issueKey,
      findingMessage: issue.message,
      category: issue.category,
      targetPath: plan.targetPath,
      fileExisted: plan.existed,
      before: plan.before,
      after: plan.after,
      diff,
      explanation: plan.explanation,
    });

    return {
      kind: "ok",
      proposalId,
      targetPath: plan.targetPath,
      fileExisted: plan.existed,
      diff,
      explanation: plan.explanation,
    };
  },
});

/* ── The write path: OFF by default, approval-gated, new-branch-only ───────── */

export const createPullRequest = action({
  args: { proposalId: v.id("repairProposals") },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { kind: "write_disabled"; message: string }
    | { kind: "not_found"; message: string }
    | { kind: "not_approved"; message: string }
    | { kind: "expired"; message: string }
    | { kind: "not_connected"; message: string }
    | { kind: "auth_expired"; message: string }
    | { kind: "no_permission"; message: string }
    | { kind: "stale"; message: string }
    | { kind: "error"; message: string }
    | { kind: "ok"; prNumber: number; prUrl: string; branchName: string }
  > => {
    // GATE 0 — checked BEFORE any authentication work or external call: this
    // deployment must explicitly opt in to GitHub writes. When off (the
    // default), zero requests are made to GitHub.
    if (process.env.GITHUB_WRITE_ENABLED !== "true") {
      return {
        kind: "write_disabled",
        message:
          "Pull-request creation is disabled on this deployment. Your approval was recorded and the proposal stays reviewable — nothing was sent to GitHub. Enabling writes requires a verified GitHub setup (see deployment notes).",
      };
    }

    const userId = await requireAuthUser(ctx);
    const proposal = await ctx.runQuery(internal.github.getProposalForWrite, {
      proposalId: args.proposalId,
      userId,
    });
    if (!proposal) return { kind: "not_found", message: "Proposal not found." };
    if (proposal.status === "pr_created") {
      return { kind: "not_approved", message: "A pull request was already created from this proposal." };
    }
    if (proposal.status !== "pr_requested") {
      return {
        kind: "not_approved",
        message: "This proposal has not been approved for pull-request creation. Approve it first.",
      };
    }
    if (Date.now() > proposal.expiresAt) {
      return { kind: "expired", message: "This proposal has expired — analyze the repository again." };
    }
    if (
      !isValidRepoFullName(proposal.repoFullName) ||
      !isValidBranchName(proposal.branch) ||
      !isValidRepoPath(proposal.targetPath)
    ) {
      return { kind: "error", message: "The stored proposal failed validation — analyze the repository again." };
    }
    const secret = await ctx.runQuery(internal.github.getOwnConnectionSecret, { userId });
    if (!secret) {
      return { kind: "not_connected", message: "The GitHub connection was removed — reconnect and analyze again." };
    }

    const h = ghHeaders(secret.token);
    const fail = (step: string, status?: number): { kind: "error"; message: string } => ({
      kind: "error",
      message: `GitHub ${step} failed${status ? ` (HTTP ${status})` : ""} — no pull request was created.`,
    });

    try {
      // 1. Push permission on this repository (server-side, with the token).
      const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}`, { headers: h });
      if (repoRes.status === 401) return { kind: "auth_expired", message: AUTH_EXPIRED.message };
      if (!repoRes.ok) return fail("repository lookup", repoRes.status);
      const repo = (await ghJson(repoRes)) as { permissions?: { push?: unknown } } | null;
      if (repo?.permissions?.push !== true) {
        return {
          kind: "no_permission",
          message: `The connected GitHub account (${secret.login}) does not have push access to ${proposal.repoFullName} — no branch or pull request can be created.`,
        };
      }

      // 2. Stale-write guard: the remote file must still be exactly what the
      //    proposal diffed against. Never clobber a concurrent edit.
      const encodedPath = proposal.targetPath.split("/").map(encodeURIComponent).join("/");
      const contentsUrl = `${GITHUB_API_BASE}/repos/${proposal.repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(proposal.branch)}`;
      const current = await fetch(contentsUrl, { headers: h });
      if (proposal.fileExisted) {
        if (current.status === 404) {
          return { kind: "stale", message: "The target file was deleted on GitHub after this proposal — analyze again." };
        }
        if (current.status === 401) return { kind: "auth_expired", message: AUTH_EXPIRED.message };
        if (!current.ok) return fail("file comparison", current.status);
        const parsed = parseFileContent(await ghJson(current));
        if (!parsed.ok) {
          return { kind: "stale", message: "The target file changed shape since this proposal — analyze again." };
        }
        if (parsed.text !== proposal.before) {
          return {
            kind: "stale",
            message: "The target file changed on GitHub after this proposal was generated — nothing was written. Analyze again for a fresh diff.",
          };
        }
      } else if (current.status !== 404) {
        if (current.status === 401) return { kind: "auth_expired", message: AUTH_EXPIRED.message };
        return { kind: "stale", message: "The target file now exists on GitHub — nothing was written. Analyze again." };
      }

      // 3. Source branch head (the branch the owner selected — read only).
      const refRes = await fetch(
        `${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/ref/heads/${encodeURIComponent(proposal.branch)}`,
        { headers: h },
      );
      if (refRes.status === 404) return fail("branch lookup", 404);
      if (!refRes.ok) return fail("branch lookup", refRes.status);
      const ref = (await ghJson(refRes)) as { object?: { sha?: unknown } } | null;
      const headSha = typeof ref?.object?.sha === "string" ? ref.object.sha : null;
      if (!headSha) return fail("branch lookup");

      // 4. blob → tree → commit (content identical to the reviewed `after`).
      const blobRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/blobs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: proposal.after, encoding: "utf-8" }),
      });
      if (!blobRes.ok) return fail("blob creation", blobRes.status);
      const blob = (await ghJson(blobRes)) as { sha?: unknown } | null;
      const blobSha = typeof blob?.sha === "string" ? blob.sha : null;
      if (!blobSha) return fail("blob creation");

      const baseCommitRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/commits/${headSha}`, {
        headers: h,
      });
      if (!baseCommitRes.ok) return fail("commit lookup", baseCommitRes.status);
      const baseCommit = (await ghJson(baseCommitRes)) as { tree?: { sha?: unknown } } | null;
      const baseTreeSha = typeof baseCommit?.tree?.sha === "string" ? baseCommit.tree.sha : null;
      if (!baseTreeSha) return fail("commit lookup");

      const treeRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/trees`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: [{ path: proposal.targetPath, mode: "100644", type: "blob", sha: blobSha }],
        }),
      });
      if (!treeRes.ok) return fail("tree creation", treeRes.status);
      const newTree = (await ghJson(treeRes)) as { sha?: unknown } | null;
      const newTreeSha = typeof newTree?.sha === "string" ? newTree.sha : null;
      if (!newTreeSha) return fail("tree creation");

      const commitRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/commits`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          message: prTitleFor(proposal.findingMessage),
          tree: newTreeSha,
          parents: [headSha],
        }),
      });
      if (!commitRes.ok) return fail("commit creation", commitRes.status);
      const commit = (await ghJson(commitRes)) as { sha?: unknown } | null;
      const commitSha = typeof commit?.sha === "string" ? commit.sha : null;
      if (!commitSha) return fail("commit creation");

      // 5. A NEW branch — never the selected/default branch itself.
      const branchName = repairBranchName();
      const createRefRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/git/refs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }),
      });
      if (!createRefRes.ok) return fail("repair-branch creation", createRefRes.status);

      // 6. Open the pull request (head = new branch, base = selected branch).
      //    Nothing merges; merging stays a human action on GitHub.
      const prRes = await fetch(`${GITHUB_API_BASE}/repos/${proposal.repoFullName}/pulls`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          title: prTitleFor(proposal.findingMessage),
          head: branchName,
          base: proposal.branch,
          body: prBodyFor({
            findingMessage: proposal.findingMessage,
            targetPath: proposal.targetPath,
            explanation: proposal.explanation,
            scanUrl: proposal.scanUrl,
          }),
        }),
      });
      if (!prRes.ok) {
        return {
          kind: "error",
          message: `GitHub pull-request creation failed (HTTP ${prRes.status}). Branch \`${branchName}\` exists but NO pull request was opened — nothing was merged or deployed.`,
        };
      }
      const pr = (await ghJson(prRes)) as { number?: unknown; html_url?: unknown } | null;
      const prNumber = typeof pr?.number === "number" ? pr.number : null;
      const prUrl = typeof pr?.html_url === "string" ? pr.html_url : null;
      if (prNumber === null || !prUrl || !prUrl.startsWith("https://github.com/")) {
        return {
          kind: "error",
          message: `GitHub answered the pull-request request unexpectedly — verify on GitHub whether PR ${branchName} exists. Nothing was merged or deployed.`,
        };
      }

      await ctx.runMutation(internal.github.markPrCreated, {
        proposalId: args.proposalId,
        prNumber,
        prUrl,
        branchName,
      });
      return { kind: "ok", prNumber, prUrl, branchName };
    } catch {
      // Fixed message only: no token, no response body, no stack in output.
      return {
        kind: "error",
        message: "The GitHub write failed unexpectedly — no pull request was created. Try again later.",
      };
    }
  },
});
