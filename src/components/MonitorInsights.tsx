import { useState } from "react";
import { useQuery } from "convex/react";
import { AlertTriangle, CheckCircle2, Clock, TrendingDown } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { formatDuration, type UptimeWindowDays } from "@/lib/uptime";

// ── Phase 8: monitoring insights panel ──────────────────────────────────────
// Uptime (7/30 days), response-time trend and incident history for one
// monitor. Every metric is server-computed (getUptimeInsights /
// getIncidentHistory, which enforce ownership), so this component only
// renders — it never invents numbers. Insufficient data is labeled as such
// instead of showing a fabricated percentage or a zero-height chart.
//
// The sparkline is hand-rolled SVG (same spirit as ScoreTrend): recharts is
// installed but heavy for a small panel, and a 60-line SVG stays crisp and
// mobile-friendly without pulling a charting runtime into the bundle.

/** Response-time sparkline: median ms per bucket, gaps where there is no data. */
function TrendChart({
  points,
}: {
  points: { start: number; medianMs: number | null }[];
}) {
  const timed = points.filter((p) => p.medianMs !== null);
  if (timed.length === 0) return null;

  const max = Math.max(...timed.map((p) => p.medianMs!), 1);
  const width = 600;
  const height = 96;
  const pad = 6;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;

  const x = (i: number) => pad + i * step;
  const y = (ms: number) => height - pad - (ms / max) * (height - pad * 2);

  // Build the polyline in segments so a null bucket becomes a visible gap
  // (never a fake 0 ms reading).
  const segments: string[] = [];
  let open = false;
  points.forEach((p, i) => {
    if (p.medianMs === null) {
      open = false;
      return;
    }
    const cmd = open ? "L" : "M";
    segments.push(`${cmd}${x(i).toFixed(1)},${y(p.medianMs).toFixed(1)}`);
    open = true;
  });
  const path = segments.join(" ");

  const first = new Date(points[0].start);
  const last = new Date(points[points.length - 1].start);
  const label = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Response time trend, median up to ${Math.round(max)} ms`}
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className="text-emerald-600"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{label(first)}</span>
        <span>peak {Math.round(max)} ms</span>
        <span>{label(last)}</span>
      </div>
    </div>
  );
}

/** One uptime window stat: percentage, or an honest "no data" label. */
function UptimeStat({
  window,
}: {
  window: {
    days: UptimeWindowDays;
    uptime: number | null;
    checks: number;
    partial: boolean;
    insufficient: boolean;
  };
}) {
  const noData = window.uptime === null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`text-2xl font-bold ${noData ? "text-muted-foreground" : ""}`}>
        {noData ? "—" : `${window.uptime}%`}
      </div>
      <div className="text-xs font-medium text-muted-foreground">
        uptime · last {window.days} days
      </div>
      <div className="text-[11px] text-muted-foreground">
        {noData
          ? window.checks === 0
            ? "no checks yet"
            : "no conclusive checks"
          : window.partial
            ? `partial coverage (${window.checks} checks)`
            : window.insufficient
              ? `only ${window.checks} checks`
              : `${window.checks} checks`}
      </div>
    </div>
  );
}

export function MonitorInsights({ monitorId }: { monitorId: Id<"monitors"> }) {
  const [trendDays, setTrendDays] = useState<UptimeWindowDays>(7);
  const insights = useQuery(api.monitors.getUptimeInsights, { monitorId });
  const incidents = useQuery(api.monitors.getIncidentHistory, { monitorId });

  if (insights === undefined || incidents === undefined) {
    return <p className="text-xs text-muted-foreground">Loading insights…</p>;
  }

  const trend = insights.trends.find((tr) => tr.days === trendDays)!;

  return (
    <div className="space-y-5">
      {/* ── Uptime windows ─────────────────────────────────────────── */}
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          Uptime
        </div>
        <div className="grid grid-cols-2 gap-4">
          {insights.windows.map((window) => (
            <UptimeStat key={window.days} window={window} />
          ))}
        </div>
        {insights.truncated && (
          <p className="mt-2 text-[11px] text-amber-600">
            Recent checks only — older data was trimmed for this view.
          </p>
        )}
      </div>

      {/* ── Response-time trend ────────────────────────────────────── */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">
            Response time
          </div>
          <div className="flex gap-1">
            {([7, 30] as UptimeWindowDays[]).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setTrendDays(days)}
                className={`rounded border px-2 py-0.5 text-[11px] font-medium ${
                  trendDays === days
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-border/70 text-muted-foreground hover:text-foreground"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>
        {trend.samples === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingDown className="size-3.5" />
            No response-time data in this window yet.
          </p>
        ) : (
          <TrendChart points={trend.points} />
        )}
      </div>

      {/* ── Incident timeline ──────────────────────────────────────── */}
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          Incident history
        </div>
        {incidents.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-600">
            <CheckCircle2 className="size-3.5" />
            No incidents recorded — this site has been up.
          </p>
        ) : (
          <ul className="space-y-2">
            {incidents.map((incident) => (
              <li
                key={incident._id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border/70 px-3 py-2 text-xs"
              >
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-bold uppercase ${
                    incident.open
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-emerald-300 bg-emerald-50 text-emerald-700"
                  }`}
                >
                  {incident.open ? "ongoing" : "resolved"}
                </span>
                <span className="font-medium">{incident.reason}</span>
                <span className="text-muted-foreground">
                  {new Date(incident.openedAt).toLocaleString()}
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Clock className="size-3" />
                  {incident.durationMs !== null
                    ? formatDuration(incident.durationMs)
                    : "—"}
                </span>
                {incident.open && (
                  <span className="inline-flex items-center gap-1 text-red-600">
                    <AlertTriangle className="size-3" />
                    ongoing
                  </span>
                )}
                {incident.alertedAt && (
                  <span className="text-[10px] text-muted-foreground">
                    downtime alert sent
                  </span>
                )}
                {incident.recoveryAlertedAt && (
                  <span className="text-[10px] text-emerald-600">
                    recovery alert sent
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
