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

export default crons;
