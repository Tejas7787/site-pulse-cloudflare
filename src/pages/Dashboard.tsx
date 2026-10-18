import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { MAX_MONITORS_PER_OWNER } from "@/lib/monitoring";
import { Activity, CheckCircle2, Clock, Gauge, LogOut, Monitor, AlertTriangle } from "lucide-react";
import { Link, useNavigate } from "react-router";


// ── Website Monitoring (uptime monitoring) — first-class product section ──────
// Mirrors the Landing page onboarding: the explanation, the action, the
// getting-started steps and the free-monitor limit. The limit is read from
// MAX_MONITORS_PER_OWNER — the same constant src/convex/monitors.ts throws on
// when a monitor is created — so the UI can never claim a cap the backend does
// not enforce. Nothing here touches scanner scoring, reports, PDF, weights or
// the monitoring backend.

const MONITORING_INTRO =
  "SitePulse checks your live websites from its own servers on a schedule — no browser open, no setup on your side. Every check feeds uptime history and incident tracking: downtime opens an incident only after two consecutive failed checks, the site is marked recovered only after two consecutive successful checks, and both events send an email alert.";

const GET_STARTED = [
  {
    step: "1",
    title: "Open Monitoring",
    desc: "Press Open Monitoring (or the Monitoring link above) to launch the /monitors page.",
  },
  {
    step: "2",
    title: "Add your website URL",
    desc: "Paste the public URL you want watched — https:// is added for you and the first check runs within minutes.",
  },
  {
    step: "3",
    title: "Choose a check interval",
    desc: "Every 5, 15 or 30 minutes, or hourly — match it to how critical the site is.",
  },
  {
    step: "4",
    title: "Configure alerts",
    desc: "Set an alert email while adding the monitor (it defaults to your account address) to get downtime and recovery emails, then follow live status and incidents on the page.",
  },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Authenticated workspace</p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Welcome{user?.email ? `, ${user.email}` : ""}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start">
            <Button type="button" className="cursor-pointer gap-2" asChild>
              <Link to="/monitors"><Activity className="size-4" /> Monitoring</Link>
            </Button>
            <Button type="button" variant="outline" className="cursor-pointer gap-2" onClick={handleSignOut}>
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
        </header>

        {/* ── Website Monitoring onboarding ───────────────────────────────────── */}
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Monitor className="size-5" />
            </div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="size-5" aria-hidden="true" /> Website Monitoring
            </CardTitle>
            <CardDescription>
              Automated uptime checks, downtime incident tracking, recovery detection and email alerts — SitePulse watches your sites so you don&rsquo;t have to.
            </CardDescription>
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="font-medium">Free plan:</span> up to {MAX_MONITORS_PER_OWNER} monitors per account — the same cap the app enforces when a monitor is added.
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm leading-6 text-muted-foreground">
            <p className="leading-relaxed">{MONITORING_INTRO}</p>

            <Button type="button" className="gap-2 self-start" onClick={() => navigate("/monitors")}>
              <Activity className="size-4" /> Open Monitoring
            </Button>

            <div>
              <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Getting started
              </h3>
              <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-4">
                {GET_STARTED.map((item) => (
                  <div
                    key={item.step}
                    className="border-b border-border/60 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
                  >
                    <div className="mb-2 flex size-7 items-center justify-center rounded-full border-2 border-[#1a1a1a] bg-[#FDE68A]">
                      <span className="text-xs font-black text-[#1a1a1a]">{item.step}</span>
                    </div>
                    <h4 className="text-sm font-black text-foreground">{item.title}</h4>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Gauge className="size-5" />
            </div>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5" aria-hidden="true" /> Health overview
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm leading-6 text-muted-foreground">
            <p className="leading-relaxed">
              Your monitors, your dashboards, your data — everything you need to keep every site you ship healthy. Open Uptime monitoring to see live status and incidents, or head back to the landing page to scan another website.
            </p>
            <Button type="button" className="gap-2 self-start" onClick={() => navigate("/monitors")}>
              <Clock className="size-4" /> Open Monitoring
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
