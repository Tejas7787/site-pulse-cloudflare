import { internalQuery, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { MAX_MONITORS_PER_OWNER } from "../lib/monitoring";

// Signed-in user as seen by useAuth() (src/hooks/use-auth.ts): the id and
// account email, nothing else.
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return undefined;
    const user = await ctx.db.get(userId);
    if (!user) return undefined;
    return { _id: user._id, email: user.email };
  },
});

// ── Read-only cap the dashboard uses to show the free-tier monitor limit. ─────
// Kept on the users module instead of a new file so the only new entry point
// for the frontend is a single server query, and so the frontend can read the
// same value the monitor creation gate enforces.
export const getFreeMonitorLimit = query({
  args: {},
  handler: async () => {
    // Public read of the configured free cap; no per-user data is returned.
    return { limit: MAX_MONITORS_PER_OWNER };
  },
});

export const internalGetFreeMonitorLimit = internalQuery({
  args: {},
  handler: async () => {
    return { limit: MAX_MONITORS_PER_OWNER };
  },
});
