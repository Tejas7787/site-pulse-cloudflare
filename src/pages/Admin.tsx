import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Link } from "react-router";
import {
  Activity, BarChart3, CheckCircle2, Eye, Globe, Lock, Monitor,
  MousePointerClick, ScanSearch, Smartphone, Tablet, TrendingUp, Users, XCircle,
} from "lucide-react";

const PC_KEY = "sp_admin_pc";

function StatCard({
  label, value, icon: Icon, accent = "bg-white",
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: string;
}) {
  return (
    <div className={`border-2 border-[#1a1a1a] ${accent} p-4 shadow-[4px_4px_0px_0px_#1a1a1a]`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-[#1a1a1a]/60">{label}</span>
        <Icon className="size-4 text-[#1a1a1a]/60" aria-hidden="true" />
      </div>
      <p className="mt-2 text-3xl font-black tabular-nums">{value}</p>
    </div>
  );
}

function BarChart({
  data, colorClass, labelA, labelB,
}: {
  data: { day: string; a: number; b: number }[];
  colorClass: string;
  labelA: string;
  labelB: string;
}) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));
  const hasData = data.some((d) => d.a > 0 || d.b > 0);
  return (
    <div className="border-2 border-[#1a1a1a] bg-white p-4 shadow-[4px_4px_0px_0px_#1a1a1a]">
      <div className="mb-3 flex items-center gap-4 text-xs font-bold">
        <span className="flex items-center gap-1.5"><span className={`inline-block size-3 border border-[#1a1a1a] ${colorClass}`} />{labelA}</span>
        <span className="flex items-center gap-1.5"><span className="inline-block size-3 border border-[#1a1a1a] bg-[#E5E7EB]" />{labelB}</span>
      </div>
      {!hasData ? (
        <p className="py-8 text-center text-sm font-medium text-[#1a1a1a]/50">No data yet</p>
      ) : (
        <div className="flex h-36 items-end gap-1" role="img" aria-label={`${labelA} and ${labelB} per day`}>
          {data.map((d) => (
            <div key={d.day} className="group relative flex h-full flex-1 items-end gap-px" title={`${d.day}: ${labelA} ${d.a}, ${labelB} ${d.b}`}>
              <div className={`w-full border-t border-[#1a1a1a] ${colorClass}`} style={{ height: `${(d.a / max) * 100}%` }} />
              <div className="w-full border-t border-[#1a1a1a] bg-[#E5E7EB]" style={{ height: `${(d.b / max) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BreakdownList({
  title, icon: Icon, rows, emptyLabel = "No data yet",
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  rows: { key: string; count: number }[];
  emptyLabel?: string;
}) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="border-2 border-[#1a1a1a] bg-white p-4 shadow-[4px_4px_0px_0px_#1a1a1a]">
      <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide"><Icon className="size-4" aria-hidden="true" />{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-3 py-4 text-center text-sm font-medium text-[#1a1a1a]/50">{emptyLabel}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm font-bold">
                <span className="truncate">{r.key}</span>
                <span className="tabular-nums text-[#1a1a1a]/60">{r.count}{total > 0 && ` (${Math.round((r.count / total) * 100)}%)`}</span>
              </div>
              <div className="mt-1 h-2 border border-[#1a1a1a]" >
                <div className="h-full bg-[#FDE68A]" style={{ width: `${total > 0 ? (r.count / total) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Admin() {
  const [passcode, setPasscode] = useState<string>(() => {
    try { return window.sessionStorage.getItem(PC_KEY) ?? ""; } catch { return ""; }
  });
  const [input, setInput] = useState("");

  const dashboard = useQuery(
    api.analytics.getDashboard,
    passcode ? { passcode } : "skip",
  );

  const tryUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    try { window.sessionStorage.setItem(PC_KEY, input); } catch { /* ignore */ }
    setPasscode(input);
  };

  if (!passcode) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FFFBF0] px-4 text-[#1a1a1a]">
        <form onSubmit={tryUnlock} className="w-full max-w-sm border-2 border-[#1a1a1a] bg-white p-6 shadow-[6px_6px_0px_0px_#1a1a1a]">
          <div className="mb-4 flex size-12 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A]">
            <Lock className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-xl font-black">SitePulse Admin</h1>
          <p className="mt-1 mb-4 text-sm text-[#1a1a1a]/60">Enter the analytics admin passcode to view usage statistics.</p>
          <label htmlFor="admin-passcode" className="mb-1 block text-xs font-bold uppercase tracking-wide">Passcode</label>
          <input
            id="admin-passcode"
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="current-password"
            required
            className="mb-4 w-full border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-2 font-mono text-sm focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a1a]"
          />
          <button type="submit" className="w-full border-2 border-[#1a1a1a] bg-[#FDE68A] px-4 py-2.5 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]">
            Unlock Dashboard
          </button>
          <Link to="/" className="mt-4 block text-center text-xs font-bold text-[#1a1a1a]/50 hover:text-[#1a1a1a]">← Back to SitePulse</Link>
        </form>
      </div>
    );
  }

  if (dashboard === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FFFBF0] text-[#1a1a1a]">
        <Activity className="size-8 animate-spin text-[#1a1a1a]/40" />
      </div>
    );
  }

  if (dashboard === null || !("authorized" in dashboard) || !dashboard.authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FFFBF0] px-4 text-[#1a1a1a]">
        <div className="max-w-sm border-2 border-[#1a1a1a] bg-white p-6 text-center shadow-[6px_6px_0px_0px_#1a1a1a]">
          <XCircle className="mx-auto mb-3 size-10 text-red-600" aria-hidden="true" />
          <h1 className="text-lg font-black">Access denied</h1>
          <p className="mt-1 mb-4 text-sm text-[#1a1a1a]/60">
            That passcode is not valid, or the SITEPULSE_ADMIN_PASSWORD environment variable is not configured on the Convex deployment.
          </p>
          <button
            onClick={() => { try { window.sessionStorage.removeItem(PC_KEY); } catch { /* ignore */ } setPasscode(""); }}
            className="border-2 border-[#1a1a1a] bg-[#FDE68A] px-4 py-2 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const d = dashboard;

  return (
    <div className="min-h-screen bg-[#FFFBF0] pb-16 text-[#1a1a1a]">
      <nav className="sticky top-0 z-10 border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <h1 className="flex items-center gap-2 text-lg font-black"><BarChart3 className="size-5" aria-hidden="true" />Analytics — Admin</h1>
          <Link to="/" className="flex items-center gap-2 text-sm font-bold text-[#1a1a1a]/60 transition-colors hover:text-[#1a1a1a]">
            ← Back to SitePulse
          </Link>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl space-y-8 px-4 pt-8 sm:px-6">
        {/* Visitors */}
        <section aria-labelledby="visitors-h">
          <h2 id="visitors-h" className="mb-3 flex items-center gap-2 text-base font-black uppercase tracking-wide"><Users className="size-5" aria-hidden="true" />Visitors &amp; Traffic</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Total visitors" value={String(d.visitorsTotal)} icon={Users} accent="bg-[#FDE68A]" />
            <StatCard label="Today" value={String(d.visitorsToday)} icon={Users} />
            <StatCard label="This week" value={String(d.visitorsWeek)} icon={Users} />
            <StatCard label="This month" value={String(d.visitorsMonth)} icon={Users} />
            <StatCard label="Sessions" value={String(d.sessionsTotal)} icon={Activity} />
            <StatCard label="Page views" value={String(d.pageViewsTotal)} icon={Eye} />
          </div>
        </section>

        {/* Scans */}
        <section aria-labelledby="scans-h">
          <h2 id="scans-h" className="mb-3 flex items-center gap-2 text-base font-black uppercase tracking-wide"><ScanSearch className="size-5" aria-hidden="true" />Scans</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Scans started" value={String(d.scansStarted)} icon={ScanSearch} accent="bg-[#DBEAFE]" />
            <StatCard label="Completed" value={String(d.scansCompleted)} icon={CheckCircle2} accent="bg-[#D1FAE5]" />
            <StatCard label="Failed" value={String(d.scansFailed)} icon={XCircle} accent="bg-[#FEE2E2]" />
            <StatCard
              label="Success rate"
              value={d.scanSuccessRate === null ? "No data yet" : `${d.scanSuccessRate}%`}
              icon={TrendingUp}
            />
            <StatCard label="Reports viewed" value={String(d.reportsViewed)} icon={Eye} />
            <StatCard label="Share clicks" value={String(d.sharesClicked)} icon={MousePointerClick} />
          </div>
        </section>

        {/* Trends */}
        <section aria-labelledby="trends-h">
          <h2 id="trends-h" className="mb-3 flex items-center gap-2 text-base font-black uppercase tracking-wide"><TrendingUp className="size-5" aria-hidden="true" />Last 30 days</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <BarChart
              data={d.visitorTrend.map((v) => ({ day: v.day, a: v.views, b: v.visitors }))}
              colorClass="bg-[#FDE68A]"
              labelA="Page views"
              labelB="Unique visitors"
            />
            <BarChart
              data={d.scanTrend.map((v) => ({ day: v.day, a: v.started, b: v.completed }))}
              colorClass="bg-[#DBEAFE]"
              labelA="Scans started"
              labelB="Scans completed"
            />
          </div>
        </section>

        {/* Breakdowns */}
        <section aria-labelledby="breakdown-h">
          <h2 id="breakdown-h" className="mb-3 flex items-center gap-2 text-base font-black uppercase tracking-wide"><Globe className="size-5" aria-hidden="true" />Breakdowns</h2>
          <div className="grid gap-3 lg:grid-cols-3">
            <BreakdownList title="Top traffic sources" icon={Globe}
              rows={d.topSources.map((s) => ({ key: s.source, count: s.count }))} />
            <BreakdownList title="Devices" icon={Smartphone}
              rows={d.devices.map((dev) => ({ key: dev.device, count: dev.count }))} />
            <BreakdownList title="Most visited pages" icon={Eye}
              rows={d.topPages.map((p) => ({ key: p.path, count: p.count }))} />
          </div>
          <p className="mt-3 text-xs font-medium text-[#1a1a1a]/50">
            Country/region is not collected: the first-party tracker stores no IP addresses or geo data.
            Last updated {new Date(d.generatedAt).toLocaleString()}.
          </p>
        </section>
      </main>
    </div>
  );
}
