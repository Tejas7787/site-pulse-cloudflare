import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function clean(value: string | undefined, max = 2000): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
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
      email: clean(args.email, 254),
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

/** Admin-only. Reuses the same SITEPULSE_ADMIN_PASSWORD gate as analytics. */
export const getAdmin = query({
  args: { passcode: v.string() },
  handler: async (ctx, args): Promise<FeedbackData | { authorized: false }> => {
    const expected =
      process.env.SITEPULSE_ADMIN_PASSWORD ?? process.env.ANALYTICS_ADMIN_PASSCODE;
    if (!expected || expected.length < 8) return { authorized: false };
    if (
      args.passcode.length !== expected.length ||
      [...args.passcode].some((c, i) => c !== expected[i])
    ) {
      return { authorized: false };
    }

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
