import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isValidAlertEmail } from "../lib/alerts";
import {
  INVITE_TTL_MS,
  MAX_AGENCY_NAME,
  MAX_CLIENTS_PER_AGENCY,
  MAX_CLIENT_CONTACT,
  MAX_CLIENT_NAME,
  MAX_CLIENT_NOTES,
  MAX_MEMBERS_PER_AGENCY,
  MAX_PENDING_INVITES,
  MAX_WEBSITES_PER_CLIENT,
  isInvitePending,
  normalizeAgencyName,
  normalizeClientContact,
  normalizeClientName,
  normalizeClientNotes,
  normalizeLogoUrl,
} from "../lib/agency";

// ── Phase 6: agency workspace ────────────────────────────────────────────────
// Every function in this module is tenant-scoped through requireMembership():
// an actor can only ever see or touch rows of an agency whose membership row
// they hold. Email addresses are never an authorization signal — the invite
// flow below requires a signed-in account whose OWN (already verified) email
// matches the invitation, and every other operation keys off the session
// identity only.
//
// Role model: "owner" manages members, invites and branding; "owner" and
// "member" alike manage clients and website assignments. One workspace per
// user (enforced at create/accept time), which keeps the whole surface a
// single flat tenant boundary.

type Ctx = QueryCtx | MutationCtx;

async function requireUser(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "unauthenticated", message: "Sign in to use the agency workspace." });
  }
  return userId;
}

/** The caller's membership row in `agencyId`, or null (never trusted from args). */
async function membershipOf(
  ctx: Ctx,
  userId: Id<"users">,
  agencyId: Id<"agencies">,
): Promise<Doc<"agencyMembers"> | null> {
  return await ctx.db
    .query("agencyMembers")
    .withIndex("by_agency_user", (q) => q.eq("agencyId", agencyId).eq("userId", userId))
    .unique();
}

async function requireMembership(
  ctx: Ctx,
  userId: Id<"users">,
  agencyId: Id<"agencies">,
): Promise<Doc<"agencyMembers">> {
  const membership = await membershipOf(ctx, userId, agencyId);
  if (membership === null) {
    throw new ConvexError({
      code: "forbidden",
      message: "You are not a member of this agency workspace.",
    });
  }
  return membership;
}

/** Owner-only gate: members and the public get a plain forbidden error. */
async function requireOwner(
  ctx: Ctx,
  userId: Id<"users">,
  agencyId: Id<"agencies">,
): Promise<Doc<"agencyMembers">> {
  const membership = await requireMembership(ctx, userId, agencyId);
  if (membership.role !== "owner") {
    throw new ConvexError({
      code: "forbidden",
      message: "Only the agency owner can manage the team and workspace settings.",
    });
  }
  return membership;
}

/** Membership row for "the one workspace this user belongs to", or null. */
async function ownMembership(ctx: Ctx, userId: Id<"users">): Promise<Doc<"agencyMembers"> | null> {
  return await ctx.db
    .query("agencyMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** Throw when the user already belongs to a workspace (one per user). */
async function assertNoExistingMembership(ctx: Ctx, userId: Id<"users">): Promise<void> {
  if ((await ownMembership(ctx, userId)) !== null) {
    throw new ConvexError({
      code: "already_member",
      message: "You already belong to an agency workspace. Leave it before joining or creating another.",
    });
  }
}

async function requireClientOf(
  ctx: Ctx,
  agencyId: Id<"agencies">,
  clientId: Id<"clients">,
): Promise<Doc<"clients">> {
  const client = await ctx.db.get(clientId);
  // Cross-tenant guard: the id must resolve INSIDE this agency, never merely exist.
  if (client === null || client.agencyId !== agencyId) {
    throw new ConvexError({ code: "not_found", message: "Client not found in this workspace." });
  }
  return client;
}

/** Invite tokens are 256-bit secrets rendered as 64 hex characters. */
function generateInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function publicAgency(agency: Doc<"agencies">) {
  return { _id: agency._id, name: agency.name, logoUrl: agency.logoUrl, createdAt: agency.createdAt };
}

/* ── Workspace lifecycle ───────────────────────────────────────────────────── */

export const getMyAgency = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const membership = await ownMembership(ctx, userId);
    if (membership === null) return null;
    const agency = await ctx.db.get(membership.agencyId);
    if (agency === null) return null;
    return { agency: publicAgency(agency), role: membership.role };
  },
});

export const createAgency = mutation({
  args: { name: v.string(), logoUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await assertNoExistingMembership(ctx, userId);

    const name = normalizeAgencyName(args.name);
    if (name === null || name.length > MAX_AGENCY_NAME) {
      throw new ConvexError({ code: "invalid_name", message: "Enter a workspace name (1–80 characters)." });
    }
    const logoUrl = args.logoUrl === undefined ? undefined : normalizeLogoUrl(args.logoUrl);
    if (args.logoUrl !== undefined && args.logoUrl.trim() !== "" && logoUrl === null) {
      throw new ConvexError({
        code: "invalid_logo",
        message: "The logo must be an http(s) image URL.",
      });
    }

    const now = Date.now();
    const agencyId = await ctx.db.insert("agencies", {
      ownerId: userId,
      name,
      ...(logoUrl ? { logoUrl } : {}),
      createdAt: now,
    });
    await ctx.db.insert("agencyMembers", { agencyId, userId, role: "owner", createdAt: now });
    return agencyId;
  },
});

export const updateAgency = mutation({
  args: { agencyId: v.id("agencies"), name: v.string(), logoUrl: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwner(ctx, userId, args.agencyId);

    const name = normalizeAgencyName(args.name);
    if (name === null) {
      throw new ConvexError({ code: "invalid_name", message: "Enter a workspace name (1–80 characters)." });
    }
    const logoUrl = args.logoUrl === undefined ? undefined : normalizeLogoUrl(args.logoUrl);
    if (args.logoUrl !== undefined && args.logoUrl.trim() !== "" && logoUrl === null) {
      throw new ConvexError({ code: "invalid_logo", message: "The logo must be an http(s) image URL." });
    }

    await ctx.db.patch(args.agencyId, { name, logoUrl: logoUrl ?? undefined });
    return { ok: true as const };
  },
});

/* ── Team: members + invitations (owner-managed) ───────────────────────────── */

export const listMembers = query({
  args: { agencyId: v.id("agencies") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const rows = await ctx.db
      .query("agencyMembers")
      .withIndex("by_agency", (q) => q.eq("agencyId", args.agencyId))
      .take(MAX_MEMBERS_PER_AGENCY + 1);
    const members = await Promise.all(
      rows.map(async (row) => {
        const user = await ctx.db.get(row.userId);
        return {
          userId: row.userId,
          role: row.role,
          joinedAt: row.createdAt,
          email: user?.email ?? null,
          name: user?.name ?? null,
        };
      }),
    );
    return members;
  },
});

export const listInvites = query({
  args: { agencyId: v.id("agencies") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwner(ctx, userId, args.agencyId);
    const rows = await ctx.db
      .query("agencyInvites")
      .withIndex("by_agency", (q) => q.eq("agencyId", args.agencyId))
      .take(MAX_PENDING_INVITES + 1);
    const now = Date.now();
    // The token is a bearer secret and is never returned after creation.
    return rows.map((row) => ({
      _id: row._id,
      email: row.email,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      status: row.acceptedAt
        ? ("accepted" as const)
        : row.revokedAt
          ? ("revoked" as const)
          : isInvitePending(row, now)
            ? ("pending" as const)
            : ("expired" as const),
    }));
  },
});

export const inviteMember = mutation({
  args: { agencyId: v.id("agencies"), email: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwner(ctx, userId, args.agencyId);

    const email = args.email.trim().toLowerCase();
    if (!isValidAlertEmail(email)) {
      throw new ConvexError({ code: "invalid_email", message: "Enter a valid email address." });
    }

    const members = await ctx.db
      .query("agencyMembers")
      .withIndex("by_agency", (q) => q.eq("agencyId", args.agencyId))
      .take(MAX_MEMBERS_PER_AGENCY + 1);
    if (members.length >= MAX_MEMBERS_PER_AGENCY) {
      throw new ConvexError({ code: "limit", message: "This workspace already has the maximum number of members." });
    }
    // An existing member's account email can never be invited again.
    const alreadyMember = await Promise.all(
      members.map(async (m) => (await ctx.db.get(m.userId))?.email?.trim().toLowerCase() === email),
    );
    if (alreadyMember.some(Boolean)) {
      throw new ConvexError({ code: "already_member", message: "That person is already in this workspace." });
    }

    const now = Date.now();
    const invites = await ctx.db
      .query("agencyInvites")
      .withIndex("by_agency", (q) => q.eq("agencyId", args.agencyId))
      .take(MAX_PENDING_INVITES + 1);
    const pending = invites.filter((i) => isInvitePending(i, now));
    if (pending.length >= MAX_PENDING_INVITES) {
      throw new ConvexError({ code: "limit", message: "Too many pending invitations — revoke or reuse one first." });
    }
    // Collapse duplicates: one pending invite per address.
    for (const invite of pending) {
      if (invite.email === email) {
        await ctx.db.patch(invite._id, { revokedAt: now });
      }
    }

    const token = generateInviteToken();
    const inviteId = await ctx.db.insert("agencyInvites", {
      agencyId: args.agencyId,
      email,
      token,
      invitedBy: userId,
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
    });
    // The token is returned exactly once, to the owner who created the invite.
    return { inviteId, token, email, expiresAt: now + INVITE_TTL_MS };
  },
});

export const revokeInvite = mutation({
  args: { agencyId: v.id("agencies"), inviteId: v.id("agencyInvites") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwner(ctx, userId, args.agencyId);
    const invite = await ctx.db.get(args.inviteId);
    if (invite === null || invite.agencyId !== args.agencyId) {
      throw new ConvexError({ code: "not_found", message: "Invitation not found." });
    }
    if (invite.acceptedAt !== undefined) {
      throw new ConvexError({ code: "accepted", message: "That invitation was already accepted." });
    }
    await ctx.db.patch(invite._id, { revokedAt: Date.now() });
    return { ok: true as const };
  },
});

/**
 * Look at an invitation before accepting (safe for signed-out visitors: the
 * token is the only secret involved, and only the invited address + workspace
 * name are revealed to its holder).
 */
export const previewInvite = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const token = args.token.trim();
    if (!/^[0-9a-f]{64}$/.test(token)) return { status: "invalid" as const };
    const invite = await ctx.db
      .query("agencyInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (invite === null) return { status: "invalid" as const };
    const agency = await ctx.db.get(invite.agencyId);
    const now = Date.now();
    const status = invite.acceptedAt
      ? ("accepted" as const)
      : invite.revokedAt
        ? ("revoked" as const)
        : isInvitePending(invite, now)
          ? ("pending" as const)
          : ("expired" as const);
    return { status, agencyName: agency?.name ?? "A workspace", email: invite.email };
  },
});

export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const token = args.token.trim();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new ConvexError({ code: "invalid_invite", message: "That invitation link is not valid." });
    }
    const invite = await ctx.db
      .query("agencyInvites")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    const now = Date.now();
    if (invite === null || !isInvitePending(invite, now)) {
      throw new ConvexError({
        code: "invalid_invite",
        message: "That invitation is invalid, expired, revoked, or already used.",
      });
    }

    // Authorization signal #1: the authenticated account's OWN email must be
    // the invited address. A submitted email is never enough on its own.
    const user = await ctx.db.get(userId);
    const accountEmail = user?.email?.trim().toLowerCase();
    if (!accountEmail || accountEmail !== invite.email) {
      throw new ConvexError({
        code: "wrong_account",
        message: `This invitation was sent to ${invite.email}. Sign in with that account to accept it.`,
      });
    }

    await assertNoExistingMembership(ctx, userId);

    await ctx.db.insert("agencyMembers", {
      agencyId: invite.agencyId,
      userId,
      role: "member",
      createdAt: now,
    });
    await ctx.db.patch(invite._id, { acceptedAt: now, acceptedById: userId });
    return { agencyId: invite.agencyId };
  },
});

export const leaveAgency = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const membership = await ownMembership(ctx, userId);
    if (membership === null) {
      throw new ConvexError({ code: "not_found", message: "You do not belong to a workspace." });
    }
    const agency = await ctx.db.get(membership.agencyId);
    if (agency !== null && agency.ownerId === userId) {
      throw new ConvexError({
        code: "owner",
        message: "The workspace owner cannot leave. Transfer or archive the workspace instead.",
      });
    }
    await ctx.db.delete(membership._id);
    return { ok: true as const };
  },
});

/* ── Clients ───────────────────────────────────────────────────────────────── */

export const listClients = query({
  args: { agencyId: v.id("agencies"), includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const includeArchived = args.includeArchived === true;
    const rows = await ctx.db
      .query("clients")
      .withIndex("by_agency_created", (q) => q.eq("agencyId", args.agencyId))
      .order("desc")
      .take(MAX_CLIENTS_PER_AGENCY + 1);
    return rows
      .filter((c) => includeArchived || !c.archived)
      .map((c) => ({
        _id: c._id,
        name: c.name,
        contact: c.contact,
        notes: c.notes,
        archived: c.archived,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
  },
});

export const createClient = mutation({
  args: {
    agencyId: v.id("agencies"),
    name: v.string(),
    contact: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);

    const name = normalizeClientName(args.name);
    if (name === null) {
      throw new ConvexError({ code: "invalid_name", message: "Enter a client name (1–120 characters)." });
    }
    const contact = args.contact === undefined ? undefined : normalizeClientContact(args.contact);
    if (args.contact !== undefined && args.contact.trim() !== "" && contact === null) {
      throw new ConvexError({ code: "invalid_contact", message: "The contact label is too long (max 120 characters)." });
    }
    const notes = args.notes === undefined ? undefined : normalizeClientNotes(args.notes);
    if (args.notes !== undefined && args.notes.trim() !== "" && notes === null) {
      throw new ConvexError({ code: "invalid_notes", message: "Notes are too long (max 2,000 characters)." });
    }

    const active = await ctx.db
      .query("clients")
      .withIndex("by_agency_archived", (q) => q.eq("agencyId", args.agencyId).eq("archived", false))
      .take(MAX_CLIENTS_PER_AGENCY + 1);
    if (active.length >= MAX_CLIENTS_PER_AGENCY) {
      throw new ConvexError({
        code: "limit",
        message: `Workspace limit: ${MAX_CLIENTS_PER_AGENCY} active clients. Archive one first.`,
      });
    }

    const now = Date.now();
    return await ctx.db.insert("clients", {
      agencyId: args.agencyId,
      name,
      ...(contact ? { contact } : {}),
      ...(notes ? { notes } : {}),
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateClient = mutation({
  args: {
    agencyId: v.id("agencies"),
    clientId: v.id("clients"),
    name: v.optional(v.string()),
    contact: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const client = await requireClientOf(ctx, args.agencyId, args.clientId);

    const patch: Partial<Omit<Doc<"clients">, "_id" | "_creationTime">> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      const name = normalizeClientName(args.name);
      if (name === null) {
        throw new ConvexError({ code: "invalid_name", message: "Enter a client name (1–120 characters)." });
      }
      patch.name = name;
    }
    if (args.contact !== undefined) {
      const contact = normalizeClientContact(args.contact);
      if (args.contact.trim() !== "" && contact === null) {
        throw new ConvexError({ code: "invalid_contact", message: "The contact label is too long (max 120 characters)." });
      }
      patch.contact = contact ?? undefined;
    }
    if (args.notes !== undefined) {
      const notes = normalizeClientNotes(args.notes);
      if (args.notes.trim() !== "" && notes === null) {
        throw new ConvexError({ code: "invalid_notes", message: "Notes are too long (max 2,000 characters)." });
      }
      patch.notes = notes ?? undefined;
    }

    await ctx.db.patch(client._id, patch);
    return { ok: true as const };
  },
});

export const setClientArchived = mutation({
  args: { agencyId: v.id("agencies"), clientId: v.id("clients"), archived: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const client = await requireClientOf(ctx, args.agencyId, args.clientId);
    if (!args.archived) {
      const active = await ctx.db
        .query("clients")
        .withIndex("by_agency_archived", (q) => q.eq("agencyId", args.agencyId).eq("archived", false))
        .take(MAX_CLIENTS_PER_AGENCY + 1);
      if (active.length >= MAX_CLIENTS_PER_AGENCY) {
        throw new ConvexError({
          code: "limit",
          message: `Workspace limit: ${MAX_CLIENTS_PER_AGENCY} active clients. Archive another first.`,
        });
      }
    }
    await ctx.db.patch(client._id, { archived: args.archived, updatedAt: Date.now() });
    return { ok: true as const };
  },
});

/* ── Website assignment (ownership-verified) ───────────────────────────────── */

export const assignWebsite = mutation({
  args: { agencyId: v.id("agencies"), clientId: v.id("clients"), monitorId: v.id("monitors") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const client = await requireClientOf(ctx, args.agencyId, args.clientId);
    if (client.archived) {
      throw new ConvexError({ code: "archived", message: "This client is archived — restore it first." });
    }

    // Ownership verification: the monitor must belong to the ACTING user.
    // Members cannot surface another account's (or another agency's) sites.
    const monitor = await ctx.db.get(args.monitorId);
    if (monitor === null || monitor.ownerId !== userId) {
      throw new ConvexError({
        code: "forbidden",
        message: "That website is not one of your monitors. You can only assign sites you watch from your own account.",
      });
    }

    // One client per monitor, enforced server-side.
    const existing = await ctx.db
      .query("clientWebsites")
      .withIndex("by_monitor", (q) => q.eq("monitorId", args.monitorId))
      .unique();
    if (existing !== null) {
      if (existing.clientId === args.clientId) {
        return { ok: true as const, alreadyAssigned: true as const };
      }
      throw new ConvexError({
        code: "already_assigned",
        message: "That website is already assigned to a client. Remove it there first.",
      });
    }

    const sites = await ctx.db
      .query("clientWebsites")
      .withIndex("by_agency_client", (q) => q.eq("agencyId", args.agencyId).eq("clientId", args.clientId))
      .take(MAX_WEBSITES_PER_CLIENT + 1);
    if (sites.length >= MAX_WEBSITES_PER_CLIENT) {
      throw new ConvexError({
        code: "limit",
        message: `Client limit: ${MAX_WEBSITES_PER_CLIENT} websites per client. Remove one first.`,
      });
    }

    await ctx.db.insert("clientWebsites", {
      agencyId: args.agencyId,
      clientId: args.clientId,
      monitorId: args.monitorId,
      addedById: userId,
      createdAt: Date.now(),
    });
    return { ok: true as const, alreadyAssigned: false as const };
  },
});

export const unassignWebsite = mutation({
  args: { agencyId: v.id("agencies"), websiteId: v.id("clientWebsites") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const row = await ctx.db.get(args.websiteId);
    if (row === null || row.agencyId !== args.agencyId) {
      throw new ConvexError({ code: "not_found", message: "Website assignment not found." });
    }
    await ctx.db.delete(row._id);
    return { ok: true as const };
  },
});

/* ── Dashboards ────────────────────────────────────────────────────────────── */

/** Latest saved report for a monitored URL (scans are keyed by exact URL). */
async function latestReportFor(ctx: Ctx, url: string) {
  const scan = await ctx.db
    .query("scans")
    .withIndex("by_url", (q) => q.eq("url", url))
    .order("desc")
    .first();
  if (scan === null) return null;
  return { scanId: scan._id, score: scan.score, grade: scan.grade, scannedAt: scan.scannedAt };
}

async function websiteSummaries(ctx: Ctx, agencyId: Id<"agencies">, clientId: Id<"clients">) {
  const rows = await ctx.db
    .query("clientWebsites")
    .withIndex("by_agency_client", (q) => q.eq("agencyId", agencyId).eq("clientId", clientId))
    .take(MAX_WEBSITES_PER_CLIENT + 1);
  const sites = await Promise.all(
    rows.map(async (row) => {
      const monitor = await ctx.db.get(row.monitorId);
      if (monitor === null) return null; // monitor deleted since assignment
      const report = await latestReportFor(ctx, monitor.url);
      return {
        assignmentId: row._id,
        monitorId: monitor._id,
        name: monitor.name,
        url: monitor.url,
        status: monitor.status,
        state: monitor.state,
        lastCheckedAt: monitor.lastCheckedAt,
        lastResult: monitor.lastResult,
        assignedAt: row.createdAt,
        latestReport: report,
      };
    }),
  );
  return sites.filter((s): s is NonNullable<typeof s> => s !== null);
}

export const getClient = query({
  args: { agencyId: v.id("agencies"), clientId: v.id("clients") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireMembership(ctx, userId, args.agencyId);
    const client = await requireClientOf(ctx, args.agencyId, args.clientId);
    const websites = await websiteSummaries(ctx, args.agencyId, client._id);
    return {
      client: {
        _id: client._id,
        name: client.name,
        contact: client.contact,
        notes: client.notes,
        archived: client.archived,
        createdAt: client.createdAt,
        updatedAt: client.updatedAt,
      },
      websites,
    };
  },
});

export const getDashboard = query({
  args: { agencyId: v.id("agencies") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const membership = await requireMembership(ctx, userId, args.agencyId);
    const agency = await ctx.db.get(args.agencyId);
    if (agency === null) {
      throw new ConvexError({ code: "not_found", message: "Workspace not found." });
    }

    const clientRows = await ctx.db
      .query("clients")
      .withIndex("by_agency_created", (q) => q.eq("agencyId", args.agencyId))
      .order("desc")
      .take(MAX_CLIENTS_PER_AGENCY + 1);

    const clients = await Promise.all(
      clientRows.map(async (client) => {
        const websites = await websiteSummaries(ctx, args.agencyId, client._id);
        const latestReportAt = websites.reduce(
          (max, w) => Math.max(max, w.latestReport?.scannedAt ?? 0),
          0,
        );
        const down = websites.filter((w) => w.state === "down").length;
        const suspect = websites.filter((w) => w.state === "suspect").length;
        return {
          _id: client._id,
          name: client.name,
          contact: client.contact,
          archived: client.archived,
          websiteCount: websites.length,
          down,
          suspect,
          latestReportAt: latestReportAt || null,
          websites,
        };
      }),
    );

    const active = clients.filter((c) => !c.archived);
    const allWebsites = active.flatMap((c) => c.websites);
    return {
      agency: publicAgency(agency),
      role: membership.role,
      stats: {
        activeClients: active.length,
        archivedClients: clients.length - active.length,
        websites: allWebsites.length,
        down: allWebsites.filter((w) => w.state === "down").length,
        suspect: allWebsites.filter((w) => w.state === "suspect").length,
        up: allWebsites.filter((w) => w.state === "up").length,
      },
      clients,
    };
  },
});
