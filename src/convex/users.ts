import { internalMutation, internalQuery, query } from "./_generated/server";

// ── Read-only cap the dashboard uses to show the free-tier monitor limit. ─────
// Kept on the users module instead of a new file so the only new entry point
// for the frontend is a single server query, and so the frontend can read the
// same value the monitor creation gate enforces.
export const getFreeMonitorLimit = query({
  args: {},
  handler: async (ctx) => {
    const userId = await ctx.auth.getUserIdentity();
    // Public read of the configured free cap; no per-user data is returned.
    return { limit: 10 };
  },
});

export const internalGetFreeMonitorLimit = internalQuery({
  args: {},
  handler: async (ctx) => {
    return { limit: 10 };
  },
});
