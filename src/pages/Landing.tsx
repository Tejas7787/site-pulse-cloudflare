import { useState, useRef } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router";
import {
  Shield,
  Search,
  Zap,
  Globe,
  Loader2,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Info,
  ChevronDown,
  ExternalLink,
  Activity,
  Eye,
  Share2,
  ArrowRight,
} from "lucide-react";

type Severity = "critical" | "warning" | "info";

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
  description?: string;
  hasViewport: boolean;
  hasCharset: boolean;
  hasLanguage: boolean;
  hasH1: boolean;
  h1Count: number;
  imageCount: number;
  imagesWithoutAlt: number;
  linkCount: number;
  scriptCount: number;
  styleCount: number;
  internalLinkCount: number;
  externalLinkCount: number;
  hasCSP: boolean;
  hasXFrameOptions: boolean;
  hasXContentTypeOptions: boolean;
  hasStrictTransportSecurity: boolean;
  hasXPermittedCrossDomainPolicies: boolean;
  hasReferrerPolicy: boolean;
  hasPermissionsPolicy: boolean;
  score: number;
  grade: string;
  issues: Array<{
    category: string;
    severity: Severity;
    message: string;
  }>;
  scannedAt: number;
}

const gradeColors: Record<string, string> = {
  A: "bg-emerald-400",
  B: "bg-lime-400",
  C: "bg-yellow-400",
  D: "bg-orange-400",
  F: "bg-red-400",
};

const severityConfig: Record<
  Severity,
  { icon: typeof CheckCircle; color: string; bg: string; label: string }
> = {
  critical: {
    icon: XCircle,
    color: "text-red-600",
    bg: "bg-red-100",
    label: "Critical",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-amber-600",
    bg: "bg-amber-100",
    label: "Warning",
  },
  info: {
    icon: Info,
    color: "text-blue-600",
    bg: "bg-blue-100",
    label: "Info",
  },
};

const categoryOrder = [
  "Performance",
  "SEO",
  "Security",
  "Accessibility",
  "Technical Health",
];

export default function Landing() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scanWebsite = useAction(api.scan.scanWebsite);
  const saveScan = useMutation(api.scans.saveScan);
  const navigate = useNavigate();
  const resultsRef = useRef<HTMLDivElement>(null);

  const handleScan = async () => {
    if (!url.trim()) return;
    setScanning(true);
    setError(null);
    setResult(null);
    setScanId(null);
    try {
      const res = await scanWebsite({ url: url.trim() });
      const scanResult = res as ScanResult;
      setResult(scanResult);

      // Save to database for shareable link
      try {
        const id = await saveScan(scanResult);
        setScanId(id);
      } catch {
        // Saving is best-effort; scan still works without it
      }

      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Scan failed. Please check the URL and try again.",
      );
    } finally {
      setScanning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !scanning) handleScan();
  };

  const handleShare = async () => {
    if (!scanId) return;
    const shareUrl = `${window.location.origin}/report/${scanId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleViewFullReport = () => {
    if (scanId) navigate(`/report/${scanId}`);
  };

  const issuesByCategory: Record<string, Array<{category: string; severity: Severity; message: string}>> = (result?.issues ?? []).reduce(
    (acc: Record<string, Array<{category: string; severity: Severity; message: string}>>, issue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    },
    {},
  );

  const sortedCategories = Object.keys(issuesByCategory).sort(
    (a, b) =>
      categoryOrder.indexOf(a) === -1
        ? 1
        : categoryOrder.indexOf(b) === -1
          ? -1
          : categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
  );

  return (
    <div className="min-h-screen bg-[#FFFBF0] text-[#1a1a1a]">
      {/* Nav */}
      <nav className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A]">
              <Activity className="size-5" strokeWidth={2.5} />
            </div>
            <span className="text-xl font-black tracking-tight">
              SitePulse
            </span>
          </div>
          <span className="hidden text-sm font-medium text-[#1a1a1a]/50 sm:block">
            Free website health checker
          </span>
        </div>
      </nav>

      {/* Hero */}
      <section className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto max-w-4xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <div className="mb-6 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-3 py-1.5 text-sm font-bold">
              <Zap className="size-4" />
              Instant Website Analysis
            </div>
            <h1 className="text-4xl font-black leading-[1.1] tracking-tight sm:text-6xl">
              How healthy is
              <br />
              your website?
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-[#1a1a1a]/60 sm:text-lg">
              Enter any public URL and get a clear health report with
              prioritized recommendations to improve performance, SEO, security,
              and accessibility.
            </p>
          </motion.div>

          {/* URL Input */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="mt-10"
          >
            <div className="mx-auto flex max-w-xl flex-col gap-0 border-2 border-[#1a1a1a] shadow-[4px_4px_0px_0px_#1a1a1a] sm:flex-row">
              <div className="relative flex-1">
                <Globe className="absolute left-3 top-1/2 size-5 -translate-y-1/2 text-[#1a1a1a]/40" />
                <input
                  type="url"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={scanning}
                  className="h-14 w-full border-b-2 border-[#1a1a1a] bg-white px-4 pl-11 text-base font-medium outline-none placeholder:text-[#1a1a1a]/30 sm:border-b-0 sm:border-r-2 sm:border-l-0"
                />
              </div>
              <button
                onClick={handleScan}
                disabled={scanning || !url.trim()}
                className="flex h-14 items-center justify-center gap-2 border-0 bg-[#FDE68A] px-6 text-base font-black text-[#1a1a1a] transition-colors hover:bg-[#FCD34D] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {scanning ? (
                  <>
                    <Loader2 className="size-5 animate-spin" />
                    Scanning...
                  </>
                ) : (
                  <>
                    <Search className="size-5" />
                    Scan Website
                  </>
                )}
              </button>
            </div>

            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-3 text-sm font-medium text-red-600"
              >
                {error}
              </motion.p>
            )}
          </motion.div>
        </div>
      </section>

      {/* Features */}
      {!result && !scanning && (
        <section className="border-b-2 border-[#1a1a1a] bg-white">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <div className="grid grid-cols-1 gap-0 sm:grid-cols-5">
              {[
                {
                  icon: Zap,
                  title: "Performance",
                  desc: "Response time, page size, and loading efficiency.",
                  color: "bg-[#D1FAE5]",
                },
                {
                  icon: Search,
                  title: "SEO",
                  desc: "Title tags, meta descriptions, headings, and structure.",
                  color: "bg-[#FEF3C7]",
                },
                {
                  icon: Shield,
                  title: "Security",
                  desc: "HTTPS, security headers, and vulnerability checks.",
                  color: "bg-[#DBEAFE]",
                },
                {
                  icon: Eye,
                  title: "Accessibility",
                  desc: "Alt text, language attributes, and screen reader support.",
                  color: "bg-[#FCE7F3]",
                },
                {
                  icon: Globe,
                  title: "Technical Health",
                  desc: "HTTP status, redirects, viewport, and markup quality.",
                  color: "bg-[#E0E7FF]",
                },
              ].map((feature, i) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.08 * i }}
                  className={`border-b-2 border-[#1a1a1a] p-5 last:border-b-0 sm:border-b-0 sm:border-r-2 sm:last:border-r-0`}
                >
                  <div
                    className={`mb-3 flex size-10 items-center justify-center border-2 border-[#1a1a1a] ${feature.color}`}
                  >
                    <feature.icon className="size-5" strokeWidth={2.5} />
                  </div>
                  <h3 className="mb-1 text-base font-black">{feature.title}</h3>
                  <p className="text-xs leading-relaxed text-[#1a1a1a]/55">
                    {feature.desc}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Scanning animation */}
      <AnimatePresence>
        {scanning && (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="border-b-2 border-[#1a1a1a] bg-white"
          >
            <div className="mx-auto flex max-w-6xl flex-col items-center px-4 py-16 sm:px-6">
              <div className="mb-6 flex size-16 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A] shadow-[3px_3px_0px_0px_#1a1a1a]">
                <Loader2 className="size-8 animate-spin" />
              </div>
              <h2 className="text-2xl font-black">
                Analyzing your website...
              </h2>
              <p className="mt-2 text-sm text-[#1a1a1a]/60">
                Running checks across performance, SEO, security, accessibility,
                and technical health
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  { label: "Performance", color: "bg-[#D1FAE5]" },
                  { label: "SEO", color: "bg-[#FEF3C7]" },
                  { label: "Security", color: "bg-[#DBEAFE]" },
                  { label: "Accessibility", color: "bg-[#FCE7F3]" },
                  { label: "Technical", color: "bg-[#E0E7FF]" },
                ].map((step, i) => (
                  <motion.div
                    key={step.label}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.3, duration: 0.3 }}
                    className={`border-2 border-[#1a1a1a] ${step.color} px-3 py-1 text-xs font-bold`}
                  >
                    {step.label}
                  </motion.div>
                ))}
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Results */}
      <AnimatePresence>
        {result && (
          <motion.section
            ref={resultsRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="bg-[#FFFBF0]"
          >
            {/* Score header */}
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
                <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
                  {/* Score */}
                  <div className="flex flex-col items-center">
                    <div
                      className={`relative flex size-28 items-center justify-center border-[3px] border-[#1a1a1a] ${gradeColors[result.grade] || "bg-gray-300"}`}
                    >
                      <span className="text-5xl font-black text-[#1a1a1a]">
                        {result.score}
                      </span>
                    </div>
                    <div className="mt-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-1 text-sm font-black text-white">
                      Grade {result.grade}
                    </div>
                  </div>

                  {/* Info */}
                  <div className="flex-1 text-center sm:text-left">
                    <h2 className="text-2xl font-black sm:text-3xl">
                      Your Health Report
                    </h2>
                    <div className="mt-1.5 flex items-center gap-2 justify-center sm:justify-start">
                      <Globe className="size-4 text-[#1a1a1a]/40" />
                      <span className="text-sm text-[#1a1a1a]/60 break-all font-medium">
                        {result.url}
                      </span>
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-[#1a1a1a]/40 hover:text-[#1a1a1a] transition-colors"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2 justify-center sm:justify-start">
                      <StatusPill
                        ok={result.status >= 200 && result.status < 400}
                        label={`HTTP ${result.status}`}
                      />
                      <StatusPill
                        ok={result.https}
                        label={result.https ? "HTTPS" : "No HTTPS"}
                      />
                      <StatusPill
                        ok={result.responseTime < 2000}
                        label={`${result.responseTime}ms`}
                      />
                      <StatusPill
                        ok={true}
                        label={result.pageSizeFormatted}
                      />
                      {result.redirects > 0 && (
                        <StatusPill
                          ok={result.redirects < 3}
                          label={`${result.redirects} redirect${result.redirects > 1 ? "s" : ""}`}
                        />
                      )}
                    </div>

                    {/* Actions */}
                    <div className="mt-5 flex flex-wrap gap-2 justify-center sm:justify-start">
                      {scanId && (
                        <button
                          onClick={handleViewFullReport}
                          className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-2 text-xs font-black text-white transition-colors hover:bg-[#333]"
                        >
                          <ArrowRight className="size-3.5" />
                          View Full Report
                        </button>
                      )}
                      {scanId && (
                        <button
                          onClick={handleShare}
                          className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-4 py-2 text-xs font-black transition-colors hover:bg-[#BFDBFE]"
                        >
                          <Share2 className="size-3.5" />
                          {copied ? "Link Copied!" : "Share Report"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Page Overview */}
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <h3 className="mb-4 text-lg font-black">Page Overview</h3>
                <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-4">
                  {[
                    {
                      label: "Title",
                      value: result.title
                        ? result.title.length > 40
                          ? result.title.slice(0, 40) + "\u2026"
                          : result.title
                        : "Missing",
                      ok: !!result.title,
                    },
                    {
                      label: "Meta Description",
                      value: result.description
                        ? result.description.length > 40
                          ? result.description.slice(0, 40) + "\u2026"
                          : result.description
                        : "Missing",
                      ok: !!result.description,
                    },
                    {
                      label: "Viewport",
                      value: result.hasViewport ? "Configured" : "Missing",
                      ok: result.hasViewport,
                    },
                    {
                      label: "Language",
                      value: result.hasLanguage ? "Configured" : "Missing",
                      ok: result.hasLanguage,
                    },
                    {
                      label: "Headings (H1)",
                      value: String(result.h1Count),
                      ok: result.h1Count === 1,
                    },
                    {
                      label: "Images",
                      value:
                        result.imagesWithoutAlt > 0
                          ? `${result.imageCount} total (${result.imagesWithoutAlt} without alt)`
                          : `${result.imageCount} total`,
                      ok: result.imagesWithoutAlt === 0,
                    },
                    {
                      label: "Links",
                      value: `${result.internalLinkCount} internal / ${result.externalLinkCount} external`,
                      ok: true,
                    },
                    {
                      label: "Scripts & Styles",
                      value: `${result.scriptCount} scripts / ${result.styleCount} styles`,
                      ok: result.scriptCount < 15,
                    },
                  ].map((stat, i) => (
                    <div
                      key={stat.label}
                      className={`border-b-2 border-[#1a1a1a] p-3 ${i < 4 ? "sm:border-r-2" : ""} ${i === 3 || i === 7 ? "" : ""}`}
                    >
                      <div className="text-xs font-bold text-[#1a1a1a]/50 uppercase tracking-wider">
                        {stat.label}
                      </div>
                      <div
                        className={`mt-1 text-sm font-bold ${stat.ok ? "text-[#1a1a1a]" : "text-red-600"}`}
                      >
                        {stat.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Security Headers */}
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <h3 className="mb-4 text-lg font-black">Security Headers</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {[
                    {
                      label: "Content-Security-Policy",
                      present: result.hasCSP,
                      hint: "Protects against XSS and injection attacks",
                    },
                    {
                      label: "X-Frame-Options",
                      present: result.hasXFrameOptions,
                      hint: "Prevents clickjacking",
                    },
                    {
                      label: "X-Content-Type-Options",
                      present: result.hasXContentTypeOptions,
                      hint: "Prevents MIME-type sniffing",
                    },
                    {
                      label: "Strict-Transport-Security",
                      present: result.hasStrictTransportSecurity,
                      hint: "Enforces HTTPS connections",
                    },
                    {
                      label: "Referrer-Policy",
                      present: result.hasReferrerPolicy,
                      hint: "Controls referrer information sharing",
                    },
                    {
                      label: "Permissions-Policy",
                      present: result.hasPermissionsPolicy,
                      hint: "Controls browser feature access",
                    },
                  ].map((header) => (
                    <div
                      key={header.label}
                      className="flex items-center justify-between border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3"
                    >
                      <div>
                        <span className="text-sm font-bold">
                          {header.label}
                        </span>
                        <p className="mt-0.5 text-[11px] text-[#1a1a1a]/40">
                          {header.hint}
                        </p>
                      </div>
                      {header.present ? (
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-emerald-600">
                          <CheckCircle className="size-3.5" /> Present
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-red-600">
                          <XCircle className="size-3.5" /> Missing
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Issues */}
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-black">Recommendations</h3>
                  <span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">
                    {result.issues.length} issue
                    {result.issues.length !== 1 ? "s" : ""} found
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {sortedCategories.map((category) => (
                    <IssueGroup
                      key={category}
                      category={category}
                      issues={issuesByCategory[category]}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Scan again */}
            <div className="bg-[#FFFBF0]">
              <div className="mx-auto max-w-6xl px-4 py-10 text-center sm:px-6">
                <p className="mb-4 text-sm font-medium text-[#1a1a1a]/60">
                  Want to check another website?
                </p>
                <button
                  onClick={() => {
                    setResult(null);
                    setScanId(null);
                    setUrl("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"
                >
                  <Search className="size-4" />
                  Scan Another Website
                </button>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <Activity className="size-4" />
            <span className="text-sm font-bold">SitePulse</span>
          </div>
          <p className="text-xs text-white/50">
            Free website health checker. No tracking. No sign-up required.
          </p>
        </div>
      </footer>
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 border-2 border-[#1a1a1a] px-2.5 py-0.5 text-xs font-bold ${ok ? "bg-[#D1FAE5]" : "bg-red-100"}`}
    >
      {ok ? (
        <CheckCircle className="size-3" />
      ) : (
        <AlertTriangle className="size-3" />
      )}
      {label}
    </span>
  );
}

const categoryIcons: Record<string, typeof Shield> = {
  Performance: Zap,
  SEO: Search,
  Security: Shield,
  Accessibility: Eye,
  "Technical Health": Globe,
};

function IssueGroup({
  category,
  issues,
}: {
  category: string;
  issues: ScanResult["issues"];
}) {
  const [open, setOpen] = useState(true);
  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const CatIcon = categoryIcons[category] || Globe;

  return (
    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-7 items-center justify-center border border-[#1a1a1a]/20 bg-white">
            <CatIcon className="size-3.5" />
          </div>
          <span className="font-black">{category}</span>
          <div className="flex gap-1.5">
            {criticalCount > 0 && (
              <span className="border border-red-300 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600">
                {criticalCount} critical
              </span>
            )}
            {warningCount > 0 && (
              <span className="border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-600">
                {warningCount} warning{warningCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <ChevronDown
          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden border-t-2 border-[#1a1a1a]"
          >
            <div className="divide-y-2 divide-[#1a1a1a]/10">
              {issues.map((issue, i) => {
                const config = severityConfig[issue.severity];
                const Icon = config.icon;
                return (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <div
                      className={`mt-0.5 flex size-6 shrink-0 items-center justify-center border border-[#1a1a1a]/20 ${config.bg}`}
                    >
                      <Icon className={`size-3.5 ${config.color}`} />
                    </div>
                    <div>
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider ${config.color}`}
                      >
                        {config.label}
                      </span>
                      <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/80">
                        {issue.message}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
