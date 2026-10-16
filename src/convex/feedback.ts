import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

import type { QueryCtx } from "./_generated/server";

/**
 * Server-side admin authorization for the analytics dashboard.
 *
 * Electrons / Vly proxy the Convex deployment, so the admin gate cannot rely on
 * a stored passcode blob: the dashboard client (src/pages/Admin.tsx) would
 * otherwise render only after the passcode was typed in sessionStorage and the
 * query executed, and anyone could forge a request. The check below runs
 * inside Convex with the auth identity attached, and it requires that the
 * signed-in user's record in authTables has role == ADMIN.
 */
export async function getEnvAdminPasscode(): Promise<string | undefined> {
  if (process.env.SITEPULSE_ADMIN_PASSWORD) return process.env.SITEPULSE_ADMIN_PASSWORD;
  // Convex env vars are not available server-side in the local dev "convex dev"
  // session; require the admin key to be set through the Keys UI.
  if (process.env.ANALYTICS_ADMIN_PASSCODE) return process.env.ANALYTICS_ADMIN_PASSCODE;
  return undefined;
}

/** Returns the admin passcode only to users authorized via authTables.role == ADMIN. */
export const getAdminPasscode = query({
  args: {},
  handler: async (ctx): Promise<string | undefined> => {
    try {
      await requireAdmin(ctx);
    } catch {
      return undefined;
    }
    return getEnvAdminPasscode();
  },
});

/**
 * Server-side authorization for admin data.
 *
 * The old passcode gate (SITEPULSE_ADMIN_PASSWORD / ANALYTICS_ADMIN_PASSCODE)
 * lived entirely on the client: Admin unset the passcode in sessionStorage and
 * Convex compared against an env var that may not be set. There is no owner /
 * role check at all, so any visitor who knows a string can unlock it.
 *
 * This replacement requires a signed-in user whose record in `authTables` has
 * `role === ADMIN`. The auth table is the only first-class identity store for
 * SitePulse: `@Convex-dev/auth` materializes rows there and keeps `role`
 * (defined in schema.ts) authoritative for every route that grants access.
 */
export async function requireAdmin(ctx: QueryCtx): Promise<void> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Sign in to view admin data.");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User record missing.");
  if (user.role !== "admin") throw new Error("Admin access required.");
}

/** Re-export used by Admin.swift-gated endpoints that need it. */
export const requireAdminSync = requireAdmin;

function clean(value: string | undefined, max = 2000): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

// Deliberately permissive: the field is optional, so anything that is not a
// plausible address is treated as "no contact details given" rather than
// silently storing junk in the admin view.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(value: string | undefined): string | undefined {
  const email = clean(value, 254);
  if (!email) return undefined;
  return EMAIL_SHAPE.test(email) ? email : undefined;
}

/** Public submission endpoint. Stores only what the user typed — nothing else. */
export const submit = mutation({
  args: {
    rating: v.number(),
    thought: v.optional(v.string()),
    improve: v.optional(v.string()),
    featureRequest: v.optional(v.string()),
    problem: v.optional(v.string()),
    email: v.optional(v.string()),
    path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rating = Math.round(args.rating);
    if (rating < 1 || rating > 5) throw new Error("Rating must be between 1 and 5.");

    await ctx.db.insert("feedback", {
      rating,
      thought: clean(args.thought),
      improve: clean(args.improve),
      featureRequest: clean(args.featureRequest),
      problem: clean(args.problem),
      email: cleanEmail(args.email),
      path: clean(args.path, 256),
      createdAt: Date.now(),
    });
    return null;
  },
});

export type FeedbackItem = {
  _id: string;
  rating: number;
  thought?: string;
  improve?: string;
  featureRequest?: string;
  problem?: string;
  email?: string;
  path?: string;
  createdAt: number;
};

export type FeedbackData = {
  authorized: true;
  total: number;
  averageRating: number | null;
  byRating: { rating: number; count: number }[];
  recent: FeedbackItem[];
};

/** Admin-only. Server-side authorization via requireAdmin(). */
export const getAdmin = query({
  args: { passcode: v.optional(v.string()) },
  handler: async (ctx, args): Promise<FeedbackData | { authorized: false }> => {
    try {
      await requireAdmin(ctx);
    } catch {
      return { authorized: false };
    }
    if (args.passcode === "skip") return { authorized: false };

    const all = await ctx.db.query("feedback").withIndex("by_created").order("desc").collect();

    const total = all.length;
    const averageRating =
      total > 0 ? Math.round((all.reduce((s, f) => s + f.rating, 0) / total) * 10) / 10 : null;

    const counts = new Map<number, number>();
    for (const f of all) counts.set(f.rating, (counts.get(f.rating) ?? 0) + 1);
    const byRating = [5, 4, 3, 2, 1].map((rating) => ({ rating, count: counts.get(rating) ?? 0 }));

    const recent: FeedbackItem[] = all.slice(0, 100).map((f) => ({
      _id: f._id,
      rating: f.rating,
      thought: f.thought,
      improve: f.improve,
      featureRequest: f.featureRequest,
      problem: f.problem,
      email: f.email,
      path: f.path,
      createdAt: f.createdAt,
    }));

    return { authorized: true, total, averageRating, byRating, recent };
  },
});
