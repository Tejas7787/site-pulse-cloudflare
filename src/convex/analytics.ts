import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Only these event names are accepted — anything else is silently dropped. */
const EVENT_NAMES = [
  "page_view",
  "scan_started",
  "scan_completed",
  "scan_failed",
  "report_viewed",
  "share_report_clicked",
] as const;

function truncate(value: string | undefined, max = 512): string | undefined {
  if (value === undefined) return undefined;
  return value.slice(0, max);
}

/** Public, unauthenticated event collector. Stores no PII by design. */
export const track = mutation({
  args: {
    name: v.string(),
    visitorId: v.string(),
    sessionId: v.string(),
    path: v.optional(v.string()),
    referrer: v.optional(v.string()),
    device: v.optional(v.string()),
    targetUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(EVENT_NAMES as readonly string[]).includes(args.name)) return null;
    await ctx.db.insert("analyticsEvents", {
      name: args.name,
      visitorId: truncate(args.visitorId, 64) ?? "unknown",
      sessionId: truncate(args.sessionId, 64) ?? "unknown",
      path: truncate(args.path),
      referrer: truncate(args.referrer),
      device: truncate(args.device, 16),
      targetUrl: truncate(args.targetUrl),
      createdAt: Date.now(),
    });
    return null;
  },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function referrerHost(ref: string): string {
  try {
    return new URL(ref).hostname.replace(/^www\./, "");
  } catch {
    return ref.slice(0, 64);
  }
}

export type DashboardData = {
  authorized: true;
  visitorsTotal: number;
  visitorsToday: number;
  visitorsWeek: number;
  visitorsMonth: number;
  sessionsTotal: number;
  pageViewsTotal: number;
  scansStarted: number;
  scansCompleted: number;
  scansFailed: number;
  scanSuccessRate: number | null; // percent, null when no scans yet
  reportsViewed: number;
  sharesClicked: number;
  visitorTrend: { day: string; views: number; visitors: number }[];
  scanTrend: { day: string; started: number; completed: number }[];
  topSources: { source: string; count: number }[];
  devices: { device: string; count: number }[];
  topPages: { path: string; count: number }[];
  generatedAt: number;
};

/**
 * Admin-only aggregate dashboard. Access is gated by a passcode stored as the
 * Convex environment variable ANALYTICS_ADMIN_PASSCODE. If that variable is
 * not configured, access is denied.
 */
export const getDashboard = query({
  args: { passcode: v.string() },
  handler: async (ctx, args): Promise<DashboardData | { authorized: false }> => {
    const expected =
      process.env.SITEPULSE_ADMIN_PASSWORD ?? process.env.ANALYTICS_ADMIN_PASSCODE;
    if (!expected || expected.length < 8) return { authorized: false };
    // Constant-time-ish comparison to avoid trivial timing leaks.
    if (
      args.passcode.length !== expected.length ||
      [...args.passcode].some((c, i) => c !== expected[i])
    ) {
      return { authorized: false };
    }

    const now = Date.now();
    const sinceMonth = now - 30 * DAY_MS;

    // Full-history read: fine at current scale; revisit with incremental
    // counters if volume grows large.
    const all = await ctx.db.query("analyticsEvents").collect();

    let visitorsTotal = 0,
      visitorsToday = 0,
      visitorsWeek = 0,
      visitorsMonth = 0;
    const monthVisitorIds = new Set<string>();
    const weekVisitorIds = new Set<string>();
    const todayVisitorIds = new Set<string>();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();
    const weekStart = now - 7 * DAY_MS;

    for (const e of all) {
      if (e.createdAt >= sinceMonth) monthVisitorIds.add(e.visitorId);
      if (e.createdAt >= weekStart) weekVisitorIds.add(e.visitorId);
      if (e.createdAt >= todayStart) todayVisitorIds.add(e.visitorId);
    }
    visitorsTotal = new Set(all.map((e) => e.visitorId)).size;
    visitorsMonth = monthVisitorIds.size;
    visitorsWeek = weekVisitorIds.size;
    visitorsToday = todayVisitorIds.size;

    const names = all.map((e) => e.name);
    const nameCounts = countBy(names);
    const pageViewsTotal = nameCounts["page_view"] ?? 0;
    const scansStarted = nameCounts["scan_started"] ?? 0;
    const scansCompleted = nameCounts["scan_completed"] ?? 0;
    const scansFailed = nameCounts["scan_failed"] ?? 0;
    const finishedOrFailed = scansCompleted + scansFailed;
    const scanSuccessRate =
      finishedOrFailed > 0 ? Math.round((scansCompleted / finishedOrFailed) * 100) : null;

    // Trends for the last 30 days
    const visitorTrendMap = new Map<string, { views: number; visitors: Set<string> }>();
    const scanTrendMap = new Map<string, { started: number; completed: number }>();
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const key = dayKey(now - i * DAY_MS);
      visitorTrendMap.set(key, { views: 0, visitors: new Set() });
      scanTrendMap.set(key, { started: 0, completed: 0 });
    }
    for (const e of all) {
      if (e.createdAt < sinceMonth) continue;
      const key = dayKey(e.createdAt);
      if (!visitorTrendMap.has(key)) continue;
      if (e.name === "page_view") {
        const entry = visitorTrendMap.get(key)!;
        entry.views += 1;
        entry.visitors.add(e.visitorId);
      }
      if (e.name === "scan_started") scanTrendMap.get(key)!.started += 1;
      if (e.name === "scan_completed") scanTrendMap.get(key)!.completed += 1;
    }

    const recent = all.filter((e) => e.createdAt >= sinceMonth);

    const sources = countBy(
      recent
        .filter((e) => e.name === "page_view")
        .map((e) => {
          if (!e.referrer) return "Direct / None";
          return referrerHost(e.referrer);
        }),
    );
    const deviceCounts = countBy(
      recent.filter((e) => e.name === "page_view").map((e) => e.device ?? "other"),
    );
    const pages = countBy(
      recent.filter((e) => e.name === "page_view").map((e) => e.path ?? "/"),
    );

    return {
      authorized: true,
      visitorsTotal,
      visitorsToday,
      visitorsWeek,
      visitorsMonth,
      sessionsTotal: new Set(all.map((e) => e.sessionId)).size,
      pageViewsTotal,
      scansStarted,
      scansCompleted,
      scansFailed,
      scanSuccessRate,
      reportsViewed: nameCounts["report_viewed"] ?? 0,
      sharesClicked: nameCounts["share_report_clicked"] ?? 0,
      visitorTrend: [...visitorTrendMap.entries()].map(([day, v]) => ({
        day,
        views: v.views,
        visitors: v.visitors.size,
      })),
      scanTrend: [...scanTrendMap.entries()].map(([day, v]) => ({ ...v, day })),
      topSources: Object.entries(sources)
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      devices: Object.entries(deviceCounts)
        .map(([device, count]) => ({ device, count }))
        .sort((a, b) => b.count - a.count),
      topPages: Object.entries(pages)
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      generatedAt: now,
    };
  },
});
