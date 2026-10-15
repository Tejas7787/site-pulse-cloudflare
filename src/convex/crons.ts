import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Automatic scan retention: delete reports older than SCAN_RETENTION_DAYS
// (src/convex/retention.ts) in bounded batches. Runs every minute; when
// nothing is expired the indexed `by_scanned_at` query is an immediate
// no-op, so the steady-state cost is negligible.
crons.interval(
  "delete expired scans",
  { minutes: 1 },
  internal.scans.deleteExpiredScans,
  { maxDeletes: 200 },
);

// Sweep rate-limit counters that stopped being used, so the table cannot grow
// without bound as visitors come and go.
crons.interval(
  "delete stale rate limits",
  { hours: 1 },
  internal.rateLimit.cleanup,
  { maxDeletes: 200 },
);

// ── Phase 2: automatic uptime monitoring ────────────────────────────────────
// Every minute, schedule one probe per due monitor (src/convex/monitors.ts →
// src/convex/probe.ts). Runs entirely server-side — no browser needed.
// The dispatcher is a bounded batch, advances `nextCheckAt` BEFORE scheduling
// (so an overlapping tick can never double-probe), and spreads probes with a
// per-monitor jitter. When nothing is due, the indexed by_due query is an
// immediate no-op.
crons.interval(
  "dispatch due uptime monitors",
  { minutes: 1 },
  internal.monitors.dispatchDue,
  {},
);

// Delete expired probe history, incidents and alert rows in bounded batches
// (windows defined in src/convex/retention.ts). Steady-state cost is one
// indexed no-op per hour.
crons.interval(
  "delete expired uptime data",
  { hours: 1 },
  internal.monitors.deleteExpiredUptimeData,
  { maxDeletes: 200 },
);

export default crons;
