import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { Activity, CheckCircle2, Clock, Gauge, LogOut, Monitor, AlertTriangle } from "lucide-react";
import { Link, useNavigate } from "react-router";

// ── Website Monitoring (uptime monitoring) — first-class product section ──────
// Mirrors the Landing page onboarding: the explanation, the action, the
// get-started steps and the free-monitor limit. Nothing here touches scanner
// scoring, reports, PDF, weights or the monitoring backend.
const MONITORING_INTRO =
  "SitePulse monitors your live websites from its own servers on a schedule — no browser open, no setup on your side. Every check records uptime history, and downtime is confirmed only after two consecutive failed checks before we open an incident.";

const GET_STARTED = [
  { step: "1", title: "Open Monitoring", desc: "Sign in and launch Uptime monitoring from your dashboard or the /monitors page." },
  { step: "2", title: "Add a website URL", desc: "Enter the public URL you want watched — it is checked over HTTPS from our servers." },
  { step: "3", title: "Choose a check interval", desc: "Pick 5 min, 15 min, 30 min or 1 hour to match how critical the site is." },
  { step: "4", title: "View status and incidents", desc: "See live state, availability, the last checks and open/resolved incidents — with email alerts on downtime and recovery." },
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
            <h1 className="mt-1 text-3xl font-bold tracking-tight">Welcome{user?.name ? `, ${user.name}` : ""}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start">
            <Button type="button" className="cursor-pointer gap-2" aria-current="page" asChild>
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
              Turn your website into a watched service: automated uptime checks, downtime incidents and email alerts.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 text-sm leading-6 text-muted-foreground">
            <p className="leading-relaxed">{MONITORING_INTRO}</p>

            <Button type="button" className="gap-2 self-start" onClick={() => navigate("/monitors")}>
              <Activity className="size-4" /> Open Monitoring
            </Button>

            <div className="grid gap-0 border-b-2 border-[#1a1a1a] sm:grid-cols-2 lg:grid-cols-4">
              {GET_STARTED.map((item) => (
                <div key={item.step} className="pb-4 text-left sm:pb-0 sm:border-b-2 sm:border-[#1a1a1a]">
                  <div className="mb-2 flex size-5 items-center justify-center rounded-full border-2 border-[#1a1a1a] bg-[#FDE68A]">
                    <span className="text-xs font-black text-[#1a1a1a]">{item.step}</span>
                  </div>
                  <h4 className="text-sm font-black">{item.title}</h4>
                  <p className="mt-0.5 text-xs leading-relaxed text-[#1a1a1a]/55">{item.desc}</p>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="font-medium">Free plan:</span> up to 10 monitors per account. Add more websites once a paid plan is active.
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
            <p>
              Your monitors, your dashboards, your data — everything you need to keep every site you ship healthy. Open Uptime monitoring or scan another website to see live status and incidents.
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
