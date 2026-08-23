import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const saveScan = mutation({
  args: {
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
    description: v.optional(v.string()),
    hasViewport: v.boolean(),
    hasCharset: v.boolean(),
    hasLanguage: v.boolean(),
    hasH1: v.boolean(),
    h1Count: v.number(),
    imageCount: v.number(),
    imagesWithoutAlt: v.number(),
    linkCount: v.number(),
    scriptCount: v.number(),
    styleCount: v.number(),
    internalLinkCount: v.number(),
    externalLinkCount: v.number(),
    hasCSP: v.boolean(),
    hasXFrameOptions: v.boolean(),
    hasXContentTypeOptions: v.boolean(),
    hasStrictTransportSecurity: v.boolean(),
    hasXPermittedCrossDomainPolicies: v.boolean(),
    hasReferrerPolicy: v.boolean(),
    hasPermissionsPolicy: v.boolean(),
    score: v.number(),
    grade: v.string(),
    issues: v.array(
      v.object({
        category: v.string(),
        severity: v.union(
          v.literal("critical"),
          v.literal("warning"),
          v.literal("info"),
        ),
        message: v.string(),
      }),
    ),
    scannedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("scans", args);
    return id;
  },
});

export const getScan = query({
  args: { id: v.id("scans") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});
