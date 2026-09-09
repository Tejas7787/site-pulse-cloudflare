import { useParams, Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { trackEvent } from "../lib/analytics";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import FixRecommendations from "../components/FixRecommendations";
import AIAssistant from "../components/AIAssistant";
import type { Id } from "../convex/_generated/dataModel";
import type { Priority, Severity } from "../types/scan";
import {
  ArrowLeft, CheckCircle, AlertTriangle, XCircle, Info, ChevronDown, ChevronUp,
  ExternalLink, Activity, Share2, Loader2, Globe, Shield, Search, Zap, Eye,
  BarChart3, TrendingUp, TrendingDown, Minus, Target, Lightbulb, Lock, Cookie,
  Image, Server, FileText, BadgeCheck, AlertOctagon, ShieldAlert, BookOpen,
} from "lucide-react";

const gradeColors: Record<string, string> = { A: "bg-emerald-400", B: "bg-lime-400", C: "bg-yellow-400", D: "bg-orange-400", F: "bg-red-400" };
const scoreBarColors: Record<string, string> = { A: "bg-emerald-500", B: "bg-lime-500", C: "bg-yellow-500", D: "bg-orange-500", F: "bg-red-500" };
const severityConfig: Record<Severity, { icon: typeof CheckCircle; color: string; bg: string; label: string }> = {
  critical: { icon: XCircle, color: "text-red-600", bg: "bg-red-100", label: "Critical" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-100", label: "Warning" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-100", label: "Info" },
};
const priorityConfig: Record<Priority, { label: string; color: string; bg: string; border: string }> = {
  critical: { label: "Critical", color: "text-red-700", bg: "bg-red-100", border: "border-red-300" },
  important: { label: "Important", color: "text-amber-700", bg: "bg-amber-100", border: "border-amber-300" },
  recommended: { label: "Recommended", color: "text-blue-700", bg: "bg-blue-100", border: "border-blue-300" },
  "nice-to-have": { label: "Nice to have", color: "text-gray-600", bg: "bg-gray-100", border: "border-gray-300" },
};
const categoryMeta: Record<string, { icon: typeof Shield; color: string; bg: string }> = {
  Performance: { icon: Zap, color: "text-emerald-700", bg: "bg-[#D1FAE5]" },
  SEO: { icon: Search, color: "text-amber-700", bg: "bg-[#FEF3C7]" },
  Security: { icon: Shield, color: "text-blue-700", bg: "bg-[#DBEAFE]" },
  Accessibility: { icon: Eye, color: "text-pink-700", bg: "bg-[#FCE7F3]" },
  "Technical Health": { icon: Globe, color: "text-indigo-700", bg: "bg-[#E0E7FF]" },
};
const categoryOrder = ["Performance", "SEO", "Security", "Accessibility", "Technical Health"];
const scoreWeightLabels: Record<string, string> = { Security: "30%", Performance: "25%", SEO: "25%", "Technical Health": "10%", Accessibility: "10%" };

function formatDate(ts: number) { return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
function scoreToGrade(s: number) { return s >= 90 ? "A" : s >= 80 ? "B" : s >= 65 ? "C" : s >= 50 ? "D" : "F"; }
function scoreToColor(s: number) { return scoreBarColors[scoreToGrade(s)] || "bg-gray-400"; }

// Score history (localStorage)
interface ScoreEntry { score: number; scannedAt: number; url: string; }
function getDomainFromUrl(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function getScoreHistory(domain: string): ScoreEntry[] {
  try { const raw = localStorage.getItem("sitepulse_history"); if (!raw) return []; const all = JSON.parse(raw) as Record<string, ScoreEntry[]>; return all[domain] || []; } catch { return []; }
}
function saveScoreToHistory(domain: string, entry: ScoreEntry) {
  try { const raw = localStorage.getItem("sitepulse_history"); const all = raw ? JSON.parse(raw) as Record<string, ScoreEntry[]> : {}; const existing = all[domain] || []; all[domain] = [entry, ...existing.filter((e) => e.scannedAt !== entry.scannedAt)].slice(0, 5); localStorage.setItem("sitepulse_history", JSON.stringify(all)); } catch {}
}

interface ScanDoc {
  _id: Id<"scans">; url: string; finalUrl: string; status: number; https: boolean;
  redirects: number; redirectChain?: string[]; responseTime: number; pageSize: number;
  pageSizeFormatted: string; title?: string; titleLength?: number; description?: string;
  descriptionLength?: number; hasViewport: boolean; hasCharset: boolean; hasLanguage: boolean;
  hasH1: boolean; h1Count: number; headingStructure?: string; canonicalUrl?: string;
  hasRobotsMeta?: boolean; robotsTxtAvailable?: boolean; sitemapXmlAvailable?: boolean;
  imageCount: number; imagesWithoutAlt: number; linkCount: number; scriptCount: number;
  styleCount: number; internalLinkCount: number; externalLinkCount: number;
  formInputCount?: number; inputsWithoutLabels?: number; hasCSP: boolean;
  hasXFrameOptions: boolean; hasXContentTypeOptions: boolean; hasStrictTransportSecurity: boolean;
  hasXPermittedCrossDomainPolicies: boolean; hasReferrerPolicy: boolean;
  hasPermissionsPolicy: boolean; score: number; grade: string;
  riskLevel?: "low" | "medium" | "high" | "critical"; betterThanPercent?: number;
  ssl?: { valid: boolean; issuer: string; expiryDate: string; daysUntilExpiry: number; serialNumber: string; subjectAltNames: string[] } | null;
  cookies?: Array<{ name: string; httpOnly: boolean; secure: boolean; sameSite: string | null; domain: string | null }>;
  cookiesWithIssues?: number;
  mixedContent?: Array<{ url: string; type: "script" | "image" | "stylesheet" | "other"; lineNumber: number }>;
  mixedContentCount?: number;
  serverInfo?: { server: string | null; poweredBy: string | null; technology: string[]; framework: string | null };
  siteIdentity?: { hasPrivacyPolicy: boolean; hasTermsOfService: boolean; hasContactInfo: boolean; hasOrganization: boolean; organizationName: string | null };
  sslScore?: number; cookieScore?: number; mixedContentScore?: number;
  performanceScore?: number; seoScore?: number; securityScore?: number;
  accessibilityScore?: number; technicalHealthScore?: number;
  performanceChecks?: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  seoChecks?: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  securityChecks?: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  accessibilityChecks?: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  technicalHealthChecks?: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  issues: Array<{ category: string; severity: Severity; priority: Priority; message: string; whyItMatters: string; howToFix: string }>;
  topIssues?: Array<{ category: string; severity: Severity; priority: Priority; message: string; whyItMatters: string; howToFix: string }>;
  quickWins?: Array<{ category: string; message: string; potentialGain: number; priority: Priority }>;
  totalChecksCompleted?: number; totalPassed?: number; totalFailed?: number; totalWarnings?: number;
  scannedAt: number;
}

function ScoreBar({ label, score, icon: Icon, color, bg, checks, weight }: {
  label: string; score: number; icon: typeof Shield; color: string; bg: string;
  checks: { score: number; passed: number; failed: number; warnings: number; notChecked: number };
  weight?: string;
}) {
  const grade = scoreToGrade(score);
  return (
    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex size-9 items-center justify-center border-2 border-[#1a1a1a] ${bg}`}><Icon className={`size-4.5 ${color}`} strokeWidth={2.5} /></div>
          <div>
            <div className="text-sm font-black">{label}</div>
            <div className="text-[11px] text-[#1a1a1a]/45">
              {checks.passed} passed{checks.failed > 0 ? ` · ${checks.failed} failed` : ""}{checks.warnings > 0 ? ` · ${checks.warnings} warnings` : ""}{checks.notChecked > 0 ? ` · ${checks.notChecked} not checked` : ""}
              {weight && <span className="ml-1 text-[#1a1a1a]/30">({weight} of total)</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right"><span className="text-2xl font-black">{score}</span><span className="ml-0.5 text-xs font-bold text-[#1a1a1a]/40">/100</span></div>
          <div className={`flex size-8 items-center justify-center border-2 border-[#1a1a1a] text-xs font-black ${gradeColors[grade]}`}>{grade}</div>
        </div>
      </div>
      <div className="mt-3 h-3 w-full overflow-hidden border border-[#1a1a1a]/15 bg-white">
        <motion.div initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.8, ease: "easeOut" }} className={`h-full ${scoreToColor(score)}`} />
      </div>
    </div>
  );
}

function IssueDetail({ issue, index }: { issue: ScanDoc["issues"][0]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const sev = severityConfig[issue.severity];
  const pri = priorityConfig[issue.priority];
  const Icon = sev.icon;
  return (
    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0]">
      <button onClick={() => setExpanded(!expanded)} className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <div className="flex size-7 shrink-0 items-center justify-center border border-[#1a1a1a]/20 bg-white text-xs font-black mt-0.5">{index + 1}</div>
        <div className={`mt-0.5 flex size-6 shrink-0 items-center justify-center border border-[#1a1a1a]/20 ${sev.bg}`}><Icon className={`size-3.5 ${sev.color}`} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[10px] font-bold uppercase tracking-wider ${sev.color}`}>{sev.label}</span>
            <span className={`border ${pri.border} ${pri.bg} px-1.5 py-0.5 text-[10px] font-bold ${pri.color}`}>{pri.label}</span>
            <span className="text-[10px] font-bold text-[#1a1a1a]/30">{issue.category}</span>
          </div>
          <p className="mt-1 text-sm font-bold text-[#1a1a1a]">{issue.message}</p>
        </div>
        <ChevronDown className={`size-4 shrink-0 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden border-t-2 border-[#1a1a1a]">
            <div className="px-4 py-3 space-y-3">
              <div className="border-l-3 border-amber-400 bg-amber-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Why it matters</div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">{issue.whyItMatters}</p>
              </div>
              <div className="border-l-3 border-emerald-400 bg-emerald-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">How to fix</div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">{issue.howToFix}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Report() {
  const { id } = useParams<{ id: string }>();
  const [copied, setCopied] = useState(false);
  const [prevScore, setPrevScore] = useState<number | null>(null);
  const scan = useQuery(api.scans.getScan, id ? { id: id as Id<"scans"> } : "skip");

  // Analytics: report viewed (once per mounted report id)
  const [viewTracked, setViewTracked] = useState(false);
  useEffect(() => {
    if (id && !viewTracked) {
      setViewTracked(true);
      trackEvent("report_viewed", { path: `/report/${id}` });
    }
  }, [id, viewTracked]);

  useEffect(() => {
    if (scan && scan.url) {
      const domain = getDomainFromUrl(scan.url);
      const history = getScoreHistory(domain);
      if (history.length > 0) setPrevScore(history[0].score);
      else setPrevScore(null);
      saveScoreToHistory(domain, { score: scan.score, scannedAt: scan.scannedAt, url: scan.url });
    }
  }, [scan]);

  const handleShare = async () => { trackEvent("share_report_clicked", { path: window.location.pathname }); try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {} };

  if (scan === undefined) return (<div className="min-h-screen bg-[#FFFBF0] flex items-center justify-center"><div className="flex flex-col items-center gap-4"><Loader2 className="size-8 animate-spin text-[#1a1a1a]/40" /><p className="text-sm font-medium text-[#1a1a1a]/60">Loading report...</p></div></div>);
  if (scan === null) return (<div className="min-h-screen bg-[#FFFBF0] flex items-center justify-center px-4"><div className="text-center"><div className="mb-6 flex size-16 mx-auto items-center justify-center border-2 border-[#1a1a1a] bg-red-100"><XCircle className="size-8 text-red-600" /></div><h1 className="text-2xl font-black">Report Not Found</h1><p className="mt-2 text-sm text-[#1a1a1a]/60 max-w-sm">This scan report does not exist or may have been removed.</p><Link to="/" className="mt-6 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-5 py-2.5 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"><ArrowLeft className="size-4" />Back to SitePulse</Link></div></div>);

  const s = scan as ScanDoc;
  const grade = s.grade || scoreToGrade(s.score);
  const catScores: Record<string, number> = { Performance: s.performanceScore ?? 0, SEO: s.seoScore ?? 0, Security: s.securityScore ?? 0, Accessibility: s.accessibilityScore ?? 0, "Technical Health": s.technicalHealthScore ?? 0 };
  const catChecks: Record<string, { score: number; passed: number; failed: number; warnings: number; notChecked: number }> = {
    Performance: s.performanceChecks ?? { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 0 },
    SEO: s.seoChecks ?? { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 0 },
    Security: s.securityChecks ?? { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 0 },
    Accessibility: s.accessibilityChecks ?? { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 0 },
    "Technical Health": s.technicalHealthChecks ?? { score: 0, passed: 0, failed: 0, warnings: 0, notChecked: 0 },
  };
  const criticalIssues = s.topIssues?.filter((i) => i.priority === "critical") ?? s.issues.filter((i) => i.priority === "critical").slice(0, 5);
  const quickWins = s.quickWins ?? [];

  const riskConfig: Record<string, { color: string; bg: string; border: string; label: string }> = {
    low: { color: "text-emerald-700", bg: "bg-emerald-100", border: "border-emerald-300", label: "Low Risk" },
    medium: { color: "text-yellow-700", bg: "bg-yellow-100", border: "border-yellow-300", label: "Medium Risk" },
    high: { color: "text-orange-700", bg: "bg-orange-100", border: "border-orange-300", label: "High Risk" },
    critical: { color: "text-red-700", bg: "bg-red-100", border: "border-red-300", label: "Critical Risk" },
  };

  return (
    <div className="min-h-screen bg-[#FFFBF0] text-[#1a1a1a]">
      <nav className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 text-sm font-bold text-[#1a1a1a]/60 transition-colors hover:text-[#1a1a1a]"><ArrowLeft className="size-4" />SitePulse</Link>
          <button onClick={handleShare} className="flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#BFDBFE]"><Share2 className="size-3.5" />{copied ? "Copied!" : "Share Report"}</button>
        </div>
      </nav>

      {/* Header with Score + Trend + Trust Signals */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <div className="flex flex-col items-center">
              <div className={`relative flex size-28 items-center justify-center border-[3px] border-[#1a1a1a] ${gradeColors[grade]}`}><span className="text-5xl font-black text-[#1a1a1a]">{s.score}</span></div>
              <div className="mt-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-1 text-sm font-black text-white">Grade {grade}</div>
              {prevScore !== null && (
                <div className="mt-2 flex items-center gap-1.5">
                  {s.score > prevScore + 2 ? <TrendingUp className="size-4 text-emerald-600" /> : s.score < prevScore - 2 ? <TrendingDown className="size-4 text-red-600" /> : <Minus className="size-4 text-[#1a1a1a]/40" />}
                  <span className={`text-xs font-bold ${s.score > prevScore + 2 ? "text-emerald-600" : s.score < prevScore - 2 ? "text-red-600" : "text-[#1a1a1a]/40"}`}>
                    {s.score > prevScore + 2 ? `+${s.score - prevScore}` : s.score < prevScore - 2 ? `${s.score - prevScore}` : "Same"} vs last scan
                  </span>
                </div>
              )}
            </div>
            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-2xl font-black sm:text-3xl">Website Health Report</h1>
              <div className="mt-2 flex items-center gap-2 justify-center sm:justify-start"><Globe className="size-4 text-[#1a1a1a]/40" /><span className="text-sm text-[#1a1a1a]/60 break-all font-medium">{s.url}</span><a href={s.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[#1a1a1a]/40 hover:text-[#1a1a1a] transition-colors"><ExternalLink className="size-4" /></a></div>
              <p className="mt-1 text-xs text-[#1a1a1a]/40">Scanned {formatDate(s.scannedAt)}</p>
              {/* Trust signals row */}
              <div className="mt-3 flex flex-wrap items-center gap-2 justify-center sm:justify-start">
                <span className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-700"><BadgeCheck className="size-3.5" />Verified Scan</span>
                {s.riskLevel && (
                  <span className={`inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] ${riskConfig[s.riskLevel].bg} px-2.5 py-1 text-[11px] font-bold ${riskConfig[s.riskLevel].color}`}>
                    {s.riskLevel === "low" ? <Shield className="size-3.5" /> : <ShieldAlert className="size-3.5" />}{riskConfig[s.riskLevel].label}
                  </span>
                )}
                {s.betterThanPercent && <span className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-2.5 py-1 text-[11px] font-bold text-blue-700">Better than {s.betterThanPercent}% of scanned sites</span>}
                <span className="inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-2.5 py-1 text-[11px] font-bold text-[#1a1a1a]/50">Scan #{id?.slice(-6) || "—"}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 justify-center sm:justify-start">
                <StatusPill ok={s.status >= 200 && s.status < 400} label={`HTTP ${s.status}`} />
                <StatusPill ok={s.https} label={s.https ? "HTTPS" : "No HTTPS"} />
                <StatusPill ok={s.responseTime < 2000} label={`${s.responseTime}ms`} />
                <StatusPill ok={true} label={s.pageSizeFormatted} />
                {s.redirects > 0 && <StatusPill ok={s.redirects < 3} label={`${s.redirects} redirect${s.redirects > 1 ? "s" : ""}`} />}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Score Breakdown */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex items-center gap-2 mb-4"><BarChart3 className="size-5" /><h2 className="text-lg font-black">Score Breakdown</h2></div>
          <p className="text-xs text-[#1a1a1a]/50 mb-4">Your overall score is calculated using weighted category scores. Security matters most, followed by performance and SEO.</p>
          <div className="grid grid-cols-5 gap-0 border-2 border-[#1a1a1a]">
            {categoryOrder.map((cat) => (
              <div key={cat} className="border-r-2 border-[#1a1a1a] p-3 text-center last:border-r-0">
                <div className="text-xs font-bold text-[#1a1a1a]/50">{cat}</div>
                <div className="mt-1 text-2xl font-black">{catScores[cat] ?? "—"}</div>
                <div className="text-[10px] font-bold text-[#1a1a1a]/30 mt-0.5">{scoreWeightLabels[cat]}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Check Summary */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <h2 className="mb-4 text-lg font-black">Check Summary</h2>
          <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-4">
            {[
              { label: "Checks Run", value: String(s.totalChecksCompleted ?? 0), icon: BarChart3, color: "text-[#1a1a1a]" },
              { label: "Passed", value: String(s.totalPassed ?? 0), icon: CheckCircle, color: "text-emerald-600" },
              { label: "Failed", value: String(s.totalFailed ?? 0), icon: XCircle, color: "text-red-600" },
              { label: "Warnings", value: String(s.totalWarnings ?? 0), icon: AlertTriangle, color: "text-amber-600" },
            ].map((stat, i) => (
              <div key={stat.label} className={`border-b-2 border-[#1a1a1a] p-4 ${i < 3 ? "sm:border-r-2" : ""}`}>
                <div className="flex items-center gap-2"><stat.icon className={`size-4 ${stat.color}`} /><span className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">{stat.label}</span></div>
                <div className={`mt-2 text-3xl font-black ${stat.color}`}>{stat.value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Fix These First */}
      {criticalIssues.length > 0 && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Target className="size-5 text-red-600" /><h2 className="text-lg font-black">Fix These First</h2><span className="border-2 border-red-300 bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-600">Priority</span></div>
            <p className="text-xs text-[#1a1a1a]/50 mb-4">These issues have the highest impact on your health score and should be addressed immediately.</p>
            <div className="space-y-2">{criticalIssues.map((issue, i) => <IssueDetail key={i} issue={issue} index={i} />)}</div>
          </div>
        </section>
      )}

      {/* Fix Recommendations — actionable fixes for every failed/warning check */}
      <FixRecommendations issues={s.issues} />

      {/* Quick Wins */}
      {quickWins.length > 0 && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Lightbulb className="size-5 text-amber-500" /><h2 className="text-lg font-black">Quick Wins</h2></div>
            <p className="text-xs text-[#1a1a1a]/50 mb-4">Fix these for the biggest score improvement with the least effort.</p>
            <div className="space-y-2">
              {quickWins.map((qw, i) => {
                const pri = priorityConfig[qw.priority];
                return (
                  <div key={i} className="flex items-center gap-3 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                    <div className="flex size-7 shrink-0 items-center justify-center border border-[#1a1a1a]/20 bg-white text-xs font-black">{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[#1a1a1a]">{qw.message}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`border ${pri.border} ${pri.bg} px-1.5 py-0.5 text-[10px] font-bold ${pri.color}`}>{pri.label}</span>
                        <span className="text-[10px] font-bold text-emerald-600">+{qw.potentialGain} pts potential</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Category Scores */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <h2 className="mb-4 text-lg font-black">Category Scores</h2>
          <div className="space-y-3">
            {categoryOrder.map((cat) => {
              const meta = categoryMeta[cat];
              if (!meta) return null;
              return <ScoreBar key={cat} label={cat} score={catScores[cat] ?? 0} icon={meta.icon} color={meta.color} bg={meta.bg} checks={catChecks[cat]} weight={scoreWeightLabels[cat]} />;
            })}
          </div>
        </div>
      </section>

      {/* SSL Certificate Analysis */}
      {s.ssl && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Lock className="size-5 text-blue-600" /><h2 className="text-lg font-black">SSL Certificate</h2></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4">
                <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Status</div>
                <div className={`mt-1 text-lg font-black ${s.ssl.valid ? "text-emerald-600" : "text-red-600"}`}>{s.ssl.valid ? "Valid" : "Invalid"}</div>
              </div>
              <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4">
                <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Issuer</div>
                <div className="mt-1 text-sm font-bold">{s.ssl.issuer || "Unknown"}</div>
              </div>
              <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4">
                <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Expires</div>
                <div className={`mt-1 text-sm font-bold ${s.ssl.daysUntilExpiry < 30 ? "text-red-600" : s.ssl.daysUntilExpiry < 60 ? "text-amber-600" : "text-[#1a1a1a]"}`}>{s.ssl.expiryDate || "Unknown"}</div>
                <div className={`text-[11px] font-bold mt-0.5 ${s.ssl.daysUntilExpiry < 30 ? "text-red-600" : s.ssl.daysUntilExpiry < 60 ? "text-amber-600" : "text-[#1a1a1a]/50"}`}>
                  {s.ssl.daysUntilExpiry < 0 ? `Expired ${Math.abs(s.ssl.daysUntilExpiry)} days ago` : `${s.ssl.daysUntilExpiry} days remaining`}
                  {s.ssl.daysUntilExpiry < 30 && s.ssl.daysUntilExpiry >= 0 && " — renew soon"}
                </div>
              </div>
              <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4">
                <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">SSL Score</div>
                <div className="mt-1 text-lg font-black">{s.sslScore ?? "—"}/100</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Cookie Security */}
      {s.cookies && s.cookies.length > 0 && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Cookie className="size-5 text-purple-600" /><h2 className="text-lg font-black">Cookie Security</h2><span className="text-xs font-bold text-[#1a1a1a]/40">({s.cookies.length} cookie{s.cookies.length !== 1 ? "s" : ""})</span></div>
            <div className="space-y-2">
              {s.cookies.map((cookie, i) => (
                <div key={i} className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">{cookie.name}</span>
                    <div className="flex gap-1.5">
                      <span className={`border px-2 py-0.5 text-[10px] font-bold ${cookie.httpOnly ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-red-300 bg-red-100 text-red-600"}`}>
                        HttpOnly {cookie.httpOnly ? "✓" : "✗"}
                      </span>
                      <span className={`border px-2 py-0.5 text-[10px] font-bold ${cookie.secure ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-red-300 bg-red-100 text-red-600"}`}>
                        Secure {cookie.secure ? "✓" : "✗"}
                      </span>
                      <span className={`border px-2 py-0.5 text-[10px] font-bold ${cookie.sameSite ? "border-emerald-300 bg-emerald-100 text-emerald-700" : "border-red-300 bg-red-100 text-red-600"}`}>
                        SameSite {cookie.sameSite || "✗"}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {s.cookiesWithIssues && s.cookiesWithIssues > 0 && (
              <p className="mt-3 text-xs text-red-600 font-medium">{s.cookiesWithIssues} cookie{s.cookiesWithIssues !== 1 ? "s" : ""} missing security flags — see recommendations below.</p>
            )}
          </div>
        </section>
      )}

      {/* Mixed Content */}
      {s.mixedContent && s.mixedContent.length > 0 && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Image className="size-5 text-orange-600" /><h2 className="text-lg font-black">Mixed Content</h2><span className="border-2 border-orange-300 bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">{s.mixedContent.length} resource{s.mixedContent.length !== 1 ? "s" : ""}</span></div>
            <p className="text-xs text-[#1a1a1a]/50 mb-3">These HTTP resources are loaded on your HTTPS page, which can compromise security.</p>
            <div className="space-y-1.5">
              {s.mixedContent.slice(0, 10).map((mc, i) => (
                <div key={i} className="flex items-center gap-3 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-2">
                  <span className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-bold ${mc.type === "script" ? "border-red-300 bg-red-100 text-red-600" : mc.type === "stylesheet" ? "border-amber-300 bg-amber-100 text-amber-600" : "border-blue-300 bg-blue-100 text-blue-600"}`}>{mc.type}</span>
                  <span className="text-xs text-[#1a1a1a]/70 truncate flex-1">{mc.url}</span>
                  <span className="text-[10px] text-[#1a1a1a]/30 shrink-0">L{mc.lineNumber}</span>
                </div>
              ))}
              {s.mixedContent.length > 10 && <p className="text-xs text-[#1a1a1a]/40">…and {s.mixedContent.length - 10} more</p>}
            </div>
          </div>
        </section>
      )}

      {/* Server Information */}
      {s.serverInfo && (s.serverInfo.technology.length > 0 || s.serverInfo.server || s.serverInfo.framework) && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><Server className="size-5 text-indigo-600" /><h2 className="text-lg font-black">Server Information</h2></div>
            <p className="text-xs text-[#1a1a1a]/50 mb-3">Publicly visible information about the server and technology stack.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {s.serverInfo.server && (
                <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                  <div className="text-[10px] font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Web Server</div>
                  <div className="mt-1 text-sm font-bold">{s.serverInfo.server}</div>
                </div>
              )}
              {s.serverInfo.framework && (
                <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                  <div className="text-[10px] font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Framework</div>
                  <div className="mt-1 text-sm font-bold">{s.serverInfo.framework}</div>
                </div>
              )}
              {s.serverInfo.technology.length > 0 && (
                <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3 sm:col-span-2">
                  <div className="text-[10px] font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Detected Technologies</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {s.serverInfo.technology.map((tech, i) => (
                      <span key={i} className="border-2 border-[#1a1a1a] bg-white px-2 py-0.5 text-xs font-bold">{tech}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Site Identity */}
      {s.siteIdentity && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
            <div className="flex items-center gap-2 mb-4"><FileText className="size-5 text-teal-600" /><h2 className="text-lg font-black">Site Identity</h2></div>
            <p className="text-xs text-[#1a1a1a]/50 mb-3">Trust indicators and legal pages detected on the website.</p>
            <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-3">
              {[
                { label: "Privacy Policy", present: s.siteIdentity.hasPrivacyPolicy },
                { label: "Terms of Service", present: s.siteIdentity.hasTermsOfService },
                { label: "Contact Info", present: s.siteIdentity.hasContactInfo },
                { label: "Organization", present: s.siteIdentity.hasOrganization },
              ].map((item, i) => (
                <div key={item.label} className={`border-b-2 border-[#1a1a1a] p-3 ${i < 3 ? "sm:border-r-2" : ""} ${i >= 2 ? "sm:border-b-0" : ""}`}>
                  <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">{item.label}</div>
                  <div className={`mt-1 flex items-center gap-1.5 text-sm font-bold ${item.present ? "text-emerald-600" : "text-red-600"}`}>
                    {item.present ? <CheckCircle className="size-3.5" /> : <XCircle className="size-3.5" />}
                    {item.present ? "Found" : "Not found"}
                  </div>
                </div>
              ))}
              {s.siteIdentity.organizationName && (
                <div className="border-b-2 border-[#1a1a1a] p-3 sm:border-b-0">
                  <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">Organization Name</div>
                  <div className="mt-1 text-sm font-bold">{s.siteIdentity.organizationName}</div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Security Headers */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <h2 className="mb-4 text-lg font-black">Security Headers</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { label: "Content-Security-Policy", present: s.hasCSP, hint: "Protects against XSS and injection attacks" },
              { label: "X-Frame-Options", present: s.hasXFrameOptions, hint: "Prevents clickjacking" },
              { label: "X-Content-Type-Options", present: s.hasXContentTypeOptions, hint: "Prevents MIME-type sniffing" },
              { label: "Strict-Transport-Security", present: s.hasStrictTransportSecurity, hint: "Enforces HTTPS connections" },
              { label: "Referrer-Policy", present: s.hasReferrerPolicy, hint: "Controls referrer information sharing" },
              { label: "Permissions-Policy", present: s.hasPermissionsPolicy, hint: "Controls browser feature access" },
            ].map((header) => (
              <div key={header.label} className="flex items-center justify-between border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                <div><span className="text-sm font-bold">{header.label}</span><p className="mt-0.5 text-[11px] text-[#1a1a1a]/40">{header.hint}</p></div>
                {header.present ? (<span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-emerald-600"><CheckCircle className="size-3.5" /> Present</span>) : (<span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-red-600"><XCircle className="size-3.5" /> Missing</span>)}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* All Recommendations */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex items-center justify-between"><h2 className="text-lg font-black">All Recommendations</h2><span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">{s.issues.length} issue{s.issues.length !== 1 ? "s" : ""} found</span></div>
          <div className="mt-4 space-y-2">{s.issues.map((issue, i) => <IssueDetail key={i} issue={issue} index={i} />)}</div>
        </div>
      </section>

      {/* Why Trust This Report? */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex items-center gap-2 mb-4"><BookOpen className="size-5 text-[#1a1a1a]" /><h2 className="text-lg font-black">Why Trust This Report?</h2></div>
          <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] p-4 space-y-3">
            <div className="border-l-3 border-blue-400 pl-3">
              <h3 className="text-sm font-black">How This Scan Works</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/65">SitePulse connects to your website from a secure server, fetches the publicly accessible HTML and HTTP headers, then analyzes the response against established web standards. Every check is performed on real data — no simulated or estimated results.</p>
            </div>
            <div className="border-l-3 border-emerald-400 pl-3">
              <h3 className="text-sm font-black">What We Check</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/65">We perform {s.totalChecksCompleted ?? 0} checks across performance (response time, page size), SEO (title, meta description, headings), security (HTTPS, headers, SSL certificate, cookies, mixed content), accessibility (alt text, labels, language), and technical health (HTTP status, redirects, markup). Only checks that could be completed are counted in your score.</p>
            </div>
            <div className="border-l-3 border-amber-400 pl-3">
              <h3 className="text-sm font-black">Scoring Methodology</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/65">Each category is scored independently on a 0–100 scale. Your overall score weights categories by impact: Security (30%), Performance (25%), SEO (25%), Technical Health (10%), and Accessibility (10%). SSL, cookies, and mixed content contribute to the overall score as supplementary signals. Missing checks are excluded from the score calculation — they neither help nor hurt.</p>
            </div>
            <div className="border-l-3 border-purple-400 pl-3">
              <h3 className="text-sm font-black">Privacy & Safety</h3>
              <p className="mt-1 text-xs leading-relaxed text-[#1a1a1a]/65">We never request passwords, API keys, or private credentials. Only publicly accessible pages are analyzed. No cookies are set, no tracking scripts are injected, and no modifications are made to your website. Scans are stored anonymously for 30 days so you can share and revisit reports.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Scan ID */}
      <section className="bg-[#FFFBF0]">
        <div className="mx-auto max-w-5xl px-4 py-6 text-center sm:px-6">
          <p className="text-[10px] text-[#1a1a1a]/30 mb-1">Scan ID: {id || "—"} · Generated {formatDate(s.scannedAt)}</p>
          <p className="mb-4 text-sm font-medium text-[#1a1a1a]/60">Want to check another website?</p>
          <Link to="/" className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"><Activity className="size-4" />Run a New Scan</Link>
        </div>
      </section>

      {/* AI Assistant — LAST SECTION before footer */}
      <AIAssistant
        scan={{
          url: s.url,
          score: s.score,
          grade: s.grade || scoreToGrade(s.score),
          performanceScore: s.performanceScore ?? 0,
          seoScore: s.seoScore ?? 0,
          securityScore: s.securityScore ?? 0,
          accessibilityScore: s.accessibilityScore ?? 0,
          technicalHealthScore: s.technicalHealthScore ?? 0,
          issues: s.issues,
          totalPassed: s.totalPassed ?? 0,
          totalFailed: s.totalFailed ?? 0,
          totalWarnings: s.totalWarnings ?? 0,
          https: s.https,
          status: s.status,
          responseTime: s.responseTime,
        }}
      />

      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] text-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2"><Activity className="size-4" /><span className="text-sm font-bold">SitePulse</span></div>
          <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium">
            <Link to="/about" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">About</Link>
            <Link to="/privacy" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Privacy Policy</Link>
            <Link to="/terms" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Terms of Service</Link>
            <a href="mailto:sitepulse@freebuff.app" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Contact</a>
          </nav>
          <p className="text-xs text-white/50">Free website health checker. No tracking. No sign-up required.</p>
        </div>
      </footer>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (<span className={`inline-flex items-center gap-1 border-2 border-[#1a1a1a] px-2.5 py-0.5 text-xs font-bold ${ok ? "bg-[#D1FAE5]" : "bg-red-100"}`}>{ok ? <CheckCircle className="size-3" /> : <AlertTriangle className="size-3" />}{label}</span>);
}
