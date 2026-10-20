import { useState, useRef } from "react";
import { useAction, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { trackEvent, getVisitorId } from "../lib/analytics";
import FeedbackModal from "../components/FeedbackModal";
import { addScanToHistory, getScanHistory, type ScanHistoryEntry } from "../lib/scanHistory";
import { ScoreTrend } from "../components/ScoreTrend";
import { StatusPill } from "../components/ui/status-pill";
import { dedupeIssues } from "../lib/recommendations";
import { honestQuickWinGains } from "../lib/scoring";
import { History, LogIn, Activity, Monitor, CheckCircle2, AlertTriangle, ArrowRight, XCircle, Zap, Search, Globe, Loader2, Mail, ExternalLink, Share2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, Link } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { MAX_MONITORS_PER_OWNER } from "@/lib/monitoring";

type Severity = "critical" | "warning" | "info";
type Priority = "critical" | "important" | "recommended" | "nice-to-have";

interface ScanResult {
  url: string;
  finalUrl: string;
  status: number;
  https: boolean;
  redirects: number;
  redirectChain: string[];
  responseTime: number;
  pageSize: number;
  pageSizeFormatted: string;
  title?: string;
  titleLength: number;
  description?: string;
  descriptionLength: number;
  hasViewport: boolean;
  hasCharset: boolean;
  hasLanguage: boolean;
  hasH1: boolean;
  h1Count: number;
  headingStructure: string;
  canonicalUrl?: string;
  hasRobotsMeta: boolean;
  robotsTxtAvailable?: boolean;
  sitemapXmlAvailable?: boolean;
  imageCount: number;
  imagesWithoutAlt: number;
  linkCount: number;
  scriptCount: number;
  styleCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
  formInputCount: number;
  inputsWithoutLabels: number;
  hasCSP: boolean;
  hasXFrameOptions: boolean;
  hasXContentTypeOptions: boolean;
  hasStrictTransportSecurity: boolean;
  hasXPermittedCrossDomainPolicies: boolean;
  hasReferrerPolicy: boolean;
  hasPermissionsPolicy: boolean;
  ssl: { valid: boolean; issuer: string; expiryDate: string; daysUntilExpiry: number; serialNumber: string; subjectAltNames: string[] } | null | undefined;
  cookies: Array<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string | null; domain: string | null }>;
  cookiesWithIssues: number;
  mixedContent: Array<{ url: string; type: "script" | "image" | "stylesheet" | "other"; lineNumber: number }>;
  mixedContentCount: number;
  serverInfo: { server: string | null; poweredBy: string | null; technology: string[]; framework: string | null };
  siteIdentity: { hasPrivacyPolicy: boolean; hasTermsOfService: boolean; hasContactInfo: boolean; hasOrganization: boolean; organizationName: string | null };
  score: number;
  grade: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  betterThanPercent: number;
  sslScore: number;
  cookieScore: number;
  mixedContentScore: number;
  performanceScore: number;
  seoScore: number;
  securityScore: number;
  accessibilityScore: number;
  technicalHealthScore: number;
  performanceChecks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  seoChecks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  securityChecks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  accessibilityChecks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  technicalHealthChecks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  issues: Array<{ category: string; severity: Severity; priority: Priority; message: string; whyItMatters: string; howToFix: string }>;
  topIssues: Array<{ category: string; severity: Severity; priority: Priority; message: string; whyItMatters: string; howToFix: string }>;
  quickWins: Array<{ category: string; message: string; potentialGain: number; priority: Priority }>;
  totalChecksCompleted: number;
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  scannedAt: number;
  summary?: { completeness?: "complete" | "partial" | "blocked"; blocked?: boolean; notHtml?: boolean; incomplete?: boolean; status?: number; overallScored?: boolean; blockReason?: string } | null;
}

const gradeColors: Record<string, string> = {
  A: "bg-emerald-400", B: "bg-lime-400", C: "bg-yellow-400", D: "bg-orange-400", F: "bg-red-400",
};

const severityConfig: Record<Severity, { icon: typeof CheckCircle2; color: string; bg: string; label: string }> = {
  critical: { icon: XCircle, color: "text-red-600", bg: "bg-red-100", label: "Critical" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-100", label: "Warning" },
  info: { icon: Activity, color: "text-blue-600", bg: "bg-blue-100", label: "Info" },
};

const priorityConfig: Record<Priority, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: "Critical", color: "text-red-700", bg: "bg-red-100", border: "border-red-300" },
  important: { label: "Important", color: "text-amber-700", bg: "bg-amber-100", border: "border-amber-300" },
  recommended: { label: "Recommended", color: "text-blue-700", bg: "bg-blue-100", border: "border-blue-300" },
  "nice-to-have": { label: "Nice to have", color: "text-gray-600", bg: "bg-gray-100", border: "border-gray-300" },
};

const categoryOrder = ["Performance", "SEO", "Security", "Accessibility", "Technical Health"];

function nullsToUndefined<T>(value: T): T {
  if (value === null) return undefined as T;
  if (Array.isArray(value)) return value.map((item) => nullsToUndefined(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = nullsToUndefined(val);
    return out as T;
  }
  return value;
}

// ── Inline recommendations group ────────────────────────────────────────
// One group per category in the on-page results: severity and priority chips,
// the issue message, why it matters and how to fix — the same data the full
// report page renders, kept inline so a scan result is readable on the spot.
function IssueGroup({ category, issues }: { category: string; issues: ScanResult["issues"] }) {
  return (
    <div className="border-2 border-[#1a1a1a] bg-white">
      <div className="flex items-center justify-between border-b-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-2.5">
        <h4 className="text-sm font-black">{category}</h4>
        <span className="text-xs font-bold text-[#1a1a1a]/50">
          {issues.length} issue{issues.length !== 1 ? "s" : ""}
        </span>
      </div>
      <ul>
        {issues.map((issue, i) => {
          const sev = severityConfig[issue.severity];
          const pri = priorityConfig[issue.priority];
          return (
            <li key={i} className="border-b border-[#1a1a1a]/10 px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] font-bold ${pri.border} ${sev.bg} ${sev.color}`}>
                  <sev.icon className="size-3" aria-hidden="true" /> {sev.label}
                </span>
                <span className={`border px-1.5 py-0.5 text-[10px] font-bold ${pri.border} ${pri.bg} ${pri.color}`}>{pri.label}</span>
              </div>
              <p className="mt-1.5 text-sm font-bold">{issue.message}</p>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/60">
                <span className="font-bold text-[#1a1a1a]/80">Why it matters:</span> {issue.whyItMatters}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/60">
                <span className="font-bold text-[#1a1a1a]/80">How to fix:</span> {issue.howToFix}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Website Monitoring ──────────────────────────────────────────────────────────
// The product is now a first-class service: an onboarding section on the
// landing page, a prominent CTA from the authenticated dashboard, and a
// free-monitor limit the UI reads from MAX_MONITORS_PER_OWNER — the exact
// constant src/convex/monitors.ts enforces when a monitor is created — so
// the displayed cap can never disagree with the backend.

const MONITORING_INTRO =
  "SitePulse monitors your live websites from its own servers on a schedule — no browser open, no setup on your side. Every check records uptime history, and downtime is confirmed only after two consecutive failed checks before we open an incident.";

const GET_STARTED = [
  { step: "1", title: "Open Monitoring", desc: "Sign in and launch Uptime monitoring from your dashboard or the /monitors page." },
  { step: "2", title: "Add a website URL", desc: "Enter the public URL you want watched — it is checked over HTTPS from our servers." },
  { step: "3", title: "Choose a check interval", desc: "Pick 5 min, 15 min, 30 min or 1 hour to match how critical the site is." },
  { step: "4", title: "View status and incidents", desc: "See live state, availability, the last checks and open/resolved incidents — with email alerts on downtime and recovery." },
];

const MONITORING_SECTIONS = [
  {
    eyebrow: "Auto-check",
    title: "Uptime monitoring, automatically",
    desc: "Each monitor is probed from a server on your schedule. Failed checks are recorded, and the service confirms a real outage before alerting you.",
    icon: Activity,
    color: "bg-[#DBEAFE]",
  },
  {
    eyebrow: "Incidents",
    title: "Downtime incidents with confirmation",
    desc: "Two consecutive failed checks open an incident and set a recovery path. One blip never pages you.",
    icon: AlertTriangle,
    color: "bg-[#FEF3C7]",
  },
  {
    eyebrow: "Alerts",
    title: "Email alerts for incidents and recovery",
    desc: "Downtime and recovery emails include the host, what the probe observed, the dates and how long the outage lasted.",
    icon: Mail,
    color: "bg-[#FCE7F3]",
  },
];

export default function Landing() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [history, setHistory] = useState<ScanHistoryEntry[]>(() => getScanHistory());
  const scanWebsite = useAction(api.scan.scanWebsite);
  const saveScan = useMutation(api.scans.saveScan);
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const handleScan = async () => {
    if (!url.trim()) return;
    trackEvent("scan_started", { targetUrl: url.trim() });
    setScanning(true); setError(null); setResult(null); setScanId(null);
    try {
      const res = await scanWebsite({ url: url.trim(), visitorId: getVisitorId() });
      const scanResult = res as ScanResult;
      setResult(scanResult);
      try {
        const forSave = nullsToUndefined(scanResult) as Parameters<typeof saveScan>[0];
        const id = await saveScan({ ...forSave, visitorId: getVisitorId() });
        setScanId(id);
        const historyEntry: ScanHistoryEntry = {
          scanId: id,
          url: scanResult.url,
          score: scanResult.score,
          grade: scanResult.grade,
          performanceScore: scanResult.performanceScore,
          seoScore: scanResult.seoScore,
          securityScore: scanResult.securityScore,
          accessibilityScore: scanResult.accessibilityScore,
          technicalHealthScore: scanResult.technicalHealthScore,
          scannedAt: scanResult.scannedAt,
          overallScored: scanResult.summary ? scanResult.summary.overallScored !== false : true,
        };
        addScanToHistory(historyEntry);
        setHistory(getScanHistory());
        trackEvent("scan_completed", { targetUrl: scanResult.url });
        navigate(`/report/${id}`);
      } catch (err) {
        // The scan itself succeeded — only persisting the shareable report was
        // refused (server-side storage quota). Say so plainly instead of
        // failing silently; the results above stay on screen.
        if (err instanceof ConvexError && (err.data as { code?: string } | undefined)?.code === "rate_limited") {
          setError("Your scan finished and the results are shown above, but saving the shareable report reached this browser's hourly save limit. Please try again in a few minutes.");
        }
        setTimeout(() => { resultsRef.current?.scrollIntoView({ behavior: "smooth" }); }, 100);
      }
    } catch (err) {
      trackEvent("scan_failed");
      setError(err instanceof Error ? err.message : "Scan failed. Please check the URL and try again.");
    } finally { setScanning(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !scanning) handleScan(); };
  const handleShare = async () => { if (!scanId) return; trackEvent("share_report_clicked"); try { await navigator.clipboard.writeText(`${window.location.origin}/report/${scanId}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard unavailable (permissions / non-secure context) */ } };
  const handleViewFullReport = () => { if (scanId) navigate(`/report/${scanId}`); };

  const dedupedIssues = dedupeIssues(result?.issues ?? []);
  const issuesByCategory: Record<string, ScanResult["issues"]> = dedupedIssues.reduce(
    (acc: Record<string, ScanResult["issues"]>, issue) => { if (!acc[issue.category]) acc[issue.category] = []; acc[issue.category].push(issue); return acc; }, {},
  );
  const sortedCategories = Object.keys(issuesByCategory).sort(
    (a, b) => categoryOrder.indexOf(a) === -1 ? 1 : categoryOrder.indexOf(b) === -1 ? -1 : categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
  );

  const scanSummary = result?.summary;
  const scanBlocked = scanSummary?.blocked === true;
  const contentUsable = result ? !scanBlocked && !scanSummary?.notHtml && !scanSummary?.incomplete && result.status >= 200 && result.status < 400 : false;
  const overallScored = scanSummary ? scanSummary.overallScored !== false : true;
  const quickWinGains = result ? honestQuickWinGains(result, result.quickWins ?? []) : [];

  return (
    <div className="min-h-screen bg-[#FFFBF0] text-[#1a1a1a]">
      <nav className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A]"><Activity className="size-5" strokeWidth={2.5} /></div>
            <span className="text-xl font-black tracking-tight">SitePulse</span>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to={isAuthenticated ? "/dashboard" : "/auth"}
              className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#FDE68A] px-3 py-1.5 text-xs font-bold shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"
            >
              <LogIn className="size-3.5" aria-hidden="true" />
              {isAuthenticated ? "Dashboard" : "Sign In"}
            </Link>
            {history.length > 0 && (
              <button onClick={() => { if (result) { setResult(null); setScanId(null); } setTimeout(() => document.getElementById('scan-history')?.scrollIntoView({ behavior: 'smooth' }), 50); }} className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#E0E7FF]" aria-label="View scan history">
                <History className="size-3.5" aria-hidden="true" />History {history.length > 0 && <span className="ml-0.5 border border-[#1a1a1a]/20 bg-[#FFFBF0] px-1.5 py-0.5 text-[10px] font-black">{history.length}</span>}
              </button>
            )}
            <span className="hidden text-sm font-medium text-[#1a1a1a]/50 sm:block">Free website health checker</span>
          </div>
        </div>
      </nav>

      <section className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <div className="mb-6 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-3 py-1.5 text-sm font-bold"><Zap className="size-4" />Instant Website Analysis</div>
            <h1 className="text-4xl font-black leading-[1.1] tracking-tight sm:text-6xl"><span className="mb-3 block text-sm font-bold uppercase tracking-[0.2em] text-[#1a1a1a]/60 sm:text-base">SitePulse — Free Website Health Checker</span>How healthy is<br />your website?</h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-[#1a1a1a]/60 sm:text-lg">Enter any public URL and get a clear health report with prioritized recommendations to improve performance, SEO, security, and accessibility.</p>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.15 }} className="mt-10">
            <div className="mx-auto flex max-w-xl flex-col gap-0 border-2 border-[#1a1a1a] shadow-[4px_4px_0px_0px_#1a1a1a] sm:flex-row">
              <div className="relative flex-1">
                <Globe className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-[#1a1a1a]/40" />
                <label htmlFor="website-url" className="sr-only">Website URL to scan</label>
                <input id="website-url" type="url" autoComplete="url" inputMode="url" aria-label="Website URL to scan" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={handleKeyDown} disabled={scanning} className="h-14 w-full border-b-2 border-[#1a1a1a] bg-white px-4 pl-11 text-base font-medium outline-none placeholder:text-[#1a1a1a]/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#FDE68A] sm:border-b-0 sm:border-r-2 sm:border-l-0" />
              </div>
              <button onClick={handleScan} disabled={scanning || !url.trim()} className="flex h-14 items-center justify-center gap-2 border-0 bg-[#FDE68A] px-6 text-base font-black text-[#1a1a1a] transition-colors hover:bg-[#FCD34D] disabled:cursor-not-allowed disabled:opacity-50">
                {scanning ? (<><Loader2 className="size-5 animate-spin" />Scanning...</>) : (<><Search className="size-5" />Scan Website</>)}
              </button>
            </div>
            {error && <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 text-sm font-medium text-red-600">{error}</motion.p>}
          </motion.div>
        </div>
      </section>

      {/* ── Website Monitoring onboarding ───────────────────────────────────────── */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#D1FAE5] px-3 py-1.5 text-sm font-bold text-emerald-700">
              <Monitor className="size-4" /> Website Monitoring
            </div>
            <h2 className="text-2xl font-black tracking-tight sm:text-3xl">Watch your websites around the clock</h2>
            <p className="mt-4 text-base leading-relaxed text-[#1a1a1a]/65">{MONITORING_INTRO}</p>
          </div>

          <div className="mt-10 grid gap-0 sm:grid-cols-3">
            {MONITORING_SECTIONS.map((s) => (
              <div key={s.eyebrow} className="border-b-2 border-[#1a1a1a] p-6 last:border-b-0 sm:border-b-0 sm:border-r-2 sm:last:border-r-0">
                <div className={`mb-3 flex size-10 items-center justify-center border-2 border-[#1a1a1a] ${s.color}`}><s.icon className="size-5" strokeWidth={2.5} /></div>
                <h3 className="text-base font-black">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[#1a1a1a]/55">{s.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-10">
            <h3 className="mb-5 text-sm font-black uppercase tracking-[0.18em] text-[#1a1a1a]/50">How to get started</h3>
            <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-4">
              {GET_STARTED.map((item) => (
                <div key={item.step} className="border-b-2 border-[#1a1a1a] p-5 last:border-b-0 sm:border-b-0 sm:border-r-2 sm:last:border-r-0">
                  <div className="mb-2 flex size-9 items-center justify-center rounded-full border-2 border-[#1a1a1a] bg-[#FDE68A]"><span className="text-xs font-black text-[#1a1a1a]">{item.step}</span></div>
                  <h4 className="text-sm font-black">{item.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/55">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Free-monitor limit — the same constant the monitor-creation gate enforces */}
          <div className="mt-8 flex items-center gap-3 rounded-lg border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3 text-sm">
            <AlertTriangle className="size-4 text-amber-600" />
            <span className="font-medium text-[#1a1a1a]">Free plan</span>
            <span className="text-[#1a1a1a]/60">up to {MAX_MONITORS_PER_OWNER} monitors per account — this is the cap SitePulse enforces when a monitor is added.</span>
          </div>
        </div>
      </section>

      <AnimatePresence>
        {scanning && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="border-b-2 border-[#1a1a1a] bg-white">
            <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-16 sm:px-6">
              <div className="mb-6 flex size-16 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A] shadow-[3px_3px_0px_0px_#1a1a1a]"><Loader2 className="size-8 animate-spin" /></div>
              <h2 className="text-2xl font-black">Analyzing your website...</h2>
              <p className="mt-2 text-sm text-[#1a1a1a]/60">Running checks across performance, SEO, security, accessibility, and technical health</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[{ l: "Performance", c: "bg-[#D1FAE5]" }, { l: "SEO", c: "bg-[#FEF3C7]" }, { l: "Security", c: "bg-[#DBEAFE]" }, { l: "Accessibility", c: "bg-[#FCE7F3]" }, { l: "Technical", c: "bg-[#E0E7FF]" }].map((s, i) => (
                  <motion.div key={s.l} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.3, duration: 0.3 }} className={`border-2 border-[#1a1a1a] ${s.c} px-3 py-1 text-xs font-bold`}>{s.l}</motion.div>
                ))}
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {result && (
          <motion.section ref={resultsRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="bg-[#FFFBF0]">
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
                <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
                  <div className="flex flex-col items-center">
                    <div className={`relative flex size-28 items-center justify-center border-[3px] border-[#1a1a1a] ${overallScored ? gradeColors[result.grade] || "bg-gray-300" : "bg-gray-200"}`}><span className="text-5xl font-black text-[#1a1a1a]">{overallScored ? result.score : "—"}</span></div>
                    <div className="mt-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-1 text-sm font-black text-white">{overallScored ? `Grade ${result.grade}` : "Insufficient data"}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 border-2 border-[#1a1a1a] bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">✓ Verified Scan</span>
                      {overallScored && <span className={`inline-flex items-center gap-1 border-2 border-[#1a1a1a] px-2 py-0.5 text-[10px] font-bold ${result.riskLevel === "low" ? "bg-emerald-100 text-emerald-700" : result.riskLevel === "medium" ? "bg-yellow-100 text-yellow-700" : result.riskLevel === "high" ? "bg-orange-100 text-orange-700" : "bg-red-100 text-red-700"}`}>{result.riskLevel === "low" ? "Low Risk" : result.riskLevel === "medium" ? "Medium Risk" : result.riskLevel === "high" ? "High Risk" : "Critical Risk"}</span>}
                    </div>
                    {overallScored && <p className="mt-1 text-[10px] text-[#1a1a1a]/40">Better than {result.betterThanPercent}% of scanned sites</p>}
                    {overallScored && <ScoreTrend key={result.scannedAt} scan={result} />}
                  </div>
                  <div className="flex-1 text-center sm:text-left">
                    <h2 className="text-2xl font-black sm:text-3xl">Your Health Report</h2>
                    <div className="mt-1.5 flex items-center gap-2 justify-center sm:justify-start"><Globe className="size-4 text-[#1a1a1a]/40" /><span className="text-sm text-[#1a1a1a]/60 break-all font-medium">{result.url}</span><a href={result.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${result.url} in a new tab`} className="shrink-0 rounded-sm text-[#1a1a1a]/40 transition-colors hover:text-[#1a1a1a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a1a]"><ExternalLink className="size-4" aria-hidden="true" /></a></div>
                    <div className="mt-4 flex flex-wrap gap-2 justify-center sm:justify-start">
                      <StatusPill ok={result.status >= 200 && result.status < 400} label={`HTTP ${result.status}`} />
                      <StatusPill ok={result.https} label={result.https ? "HTTPS" : "No HTTPS"} />
                      <StatusPill ok={result.responseTime < 2000} label={`${result.responseTime}ms`} />
                      {contentUsable && <StatusPill ok={true} label={result.pageSizeFormatted} />}
                      {result.redirects > 0 && <StatusPill ok={result.redirects < 3} label={`${result.redirects} redirect${result.redirects > 1 ? "s" : ""}`} />}
                    </div>
                    <div className="mt-5 flex flex-wrap gap-2 justify-center sm:justify-start">
                      {scanId && <button onClick={handleViewFullReport} className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-2 text-xs font-black text-white transition-colors hover:bg-[#333]"><ArrowRight className="size-3.5" />View Full Report</button>}
                      {scanId && <button onClick={handleShare} className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-4 py-2 text-xs font-black transition-colors hover:bg-[#BFDBFE]"><Share2 className="size-3.5" />{copied ? "Link Copied!" : "Share Report"}</button>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <h3 className="mb-4 text-lg font-black">Page Overview</h3>
                {contentUsable ? (
                  <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-4">
                    {[
                      { label: "Title", value: result.title ? (result.title.length > 40 ? result.title.slice(0, 40) + "…" : result.title) : "Missing", ok: !!result.title },
                      { label: "Meta Description", value: result.description ? (result.description.length > 40 ? result.description.slice(0, 40) + "…" : result.description) : "Missing", ok: !!result.description },
                      { label: "Viewport", value: result.hasViewport ? "Configured" : "Missing", ok: result.hasViewport },
                      { label: "Language", value: result.hasLanguage ? "Configured" : "Missing", ok: result.hasLanguage },
                      { label: "Headings (H1)", value: String(result.h1Count), ok: result.h1Count === 1 },
                      { label: "Images", value: result.imagesWithoutAlt > 0 ? `${result.imageCount} total (${result.imagesWithoutAlt} without alt)` : `${result.imageCount} total`, ok: result.imagesWithoutAlt === 0 },
                      { label: "Links", value: `${result.internalLinkCount} internal / ${result.externalLinkCount} external`, ok: true },
                      { label: "Scripts & Styles", value: `${result.scriptCount} scripts / ${result.styleCount} styles`, ok: result.scriptCount < 15 },
                    ].map((stat, i) => (
                      <div key={stat.label} className={`border-b-2 border-[#1a1a1a] p-3 ${i < 4 ? "sm:border-r-2" : ""}`}>
                        <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">{stat.label}</div>
                        <div className={`mt-1 text-sm font-bold ${stat.ok ? "text-[#1a1a1a]" : "text-red-600"}`}>{stat.value}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-5">
                    <p className="text-sm font-black text-[#1a1a1a]">Page metadata was not collected.</p>
                    <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/60">{scanBlocked
                      ? "The scan was blocked before the website's own content could be fetched — none of this data belongs to the website."
                      : `The final response (HTTP ${result.status}${scanSummary?.notHtml ? ", not an HTML document" : ""}${scanSummary?.incomplete ? ", incomplete body" : ""}) was not the site's own complete page, so title, description, headings and images were not analyzed.`}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <h3 className="mb-4 text-lg font-black">Security Headers</h3>
                {scanBlocked ? (
                  <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-5">
                    <p className="text-sm font-black text-[#1a1a1a]">Security headers could not be verified.</p>
                    <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/60">The response came from the site's bot protection, not from its server configuration — nothing here is reported as present or missing.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                      { label: "Content-Security-Policy", present: result.hasCSP, hint: "Protects against XSS and injection attacks" },
                      { label: "X-Frame-Options", present: result.hasXFrameOptions, hint: "Prevents clickjacking" },
                      { label: "X-Content-Type-Options", present: result.hasXContentTypeOptions, hint: "Prevents MIME-type sniffing" },
                      { label: "Strict-Transport-Security", present: result.hasStrictTransportSecurity, hint: "Enforces HTTPS connections" },
                      { label: "Referrer-Policy", present: result.hasReferrerPolicy, hint: "Controls referrer information sharing" },
                      { label: "Permissions-Policy", present: result.hasPermissionsPolicy, hint: "Controls browser feature access" },
                    ].map((header) => (
                      <div key={header.label} className="flex items-center justify-between border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                        <div><span className="text-sm font-bold">{header.label}</span><p className="mt-0.5 text-[11px] text-[#1a1a1a]/40">{header.hint}</p></div>
                        {header.present ? (<span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-emerald-600"><CheckCircle2 className="size-3.5" /> Present</span>) : (<span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-red-600"><XCircle className="size-3.5" /> Missing</span>)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-black">Quick Wins</h3>
                  <span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">{dedupedIssues.length} issue{dedupedIssues.length !== 1 ? "s" : ""} found</span>
                </div>
                <p className="text-xs text-[#1a1a1a]/50 mb-3">Fix these for the biggest score improvement with the least effort. Each one is explained once, in the full Recommendations list further down.</p>
                <div className="space-y-2">
                  {(result.quickWins ?? []).map((qw, i) => {
                    const pri = priorityConfig[qw.priority];
                    return (
                      <div key={i} className="flex items-center gap-3 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                        <div className="flex size-7 shrink-0 items-center justify-center border border-[#1a1a1a]/20 bg-white text-xs font-black">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-[#1a1a1a]">{qw.message}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className={`border ${pri.border} ${pri.bg} px-1.5 py-0.5 text-[10px] font-bold ${pri.color}`}>{pri.label}</span>
                            <span className="text-[10px] font-bold text-emerald-600">{(quickWinGains[i] ?? 0) > 0 ? `≈+${quickWinGains[i]} pts overall` : "Best practice — no direct score change"}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-black">Recommendations</h3>
                  <span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">{dedupedIssues.length} issue{dedupedIssues.length !== 1 ? "s" : ""} found</span>
                </div>
                <div className="mt-4 space-y-2">
                  {sortedCategories.map((category) => <IssueGroup key={category} category={category} issues={issuesByCategory[category]} />)}
                </div>
              </div>
            </div>

            <div className="bg-[#FFFBF0]">
              <div className="mx-auto max-w-6xl px-4 py-10 text-center sm:px-6">
                <p className="mb-4 text-sm font-medium text-[#1a1a1a]/60">Want to check another website?</p>
                <button onClick={() => { setResult(null); setScanId(null); setUrl(""); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"><Search className="size-4" />Scan Another Website</button>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2"><Activity className="size-4" /><span className="text-sm font-bold">SitePulse</span></div>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium">
            <Link to="/about" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">About</Link>
            <Link to="/privacy" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Privacy Policy</Link>
            <Link to="/terms" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Terms of Service</Link>
            <a href="mailto:sitepulse@freebuff.app" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Contact</a>
          </nav>
          <button type="button" onClick={() => setFeedbackOpen(true)} className="inline-flex items-center gap-1.5 border-2 border-white bg-transparent px-3 py-1.5 text-sm font-bold text-white shadow-[2px_2px_0px_0px_rgba(255,255,255,0.4)] transition-all hover:bg-white hover:text-[#1a1a1a]">
            💬 Give Feedback
          </button>
          <p className="text-xs text-white/50">Free website health checker. First-party analytics only — no ads, no cross-site tracking. No sign-up required.</p>
        </div>
      </footer>

      {feedbackOpen && <FeedbackModal onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}
