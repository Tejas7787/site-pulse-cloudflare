import { useState, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  Search,
  Zap,
  Globe,
  ArrowRight,
  Loader2,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Info,
  ChevronDown,
  ExternalLink,
  Activity,
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

export default function Landing() {
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanWebsite = useAction(api.scan.scanWebsite);
  const resultsRef = useRef<HTMLDivElement>(null);

  const handleScan = async () => {
    if (!url.trim()) return;
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const res = await scanWebsite({ url: url.trim() });
      setResult(res as ScanResult);
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Scan failed. Please try again.",
      );
    } finally {
      setScanning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !scanning) handleScan();
  };

  const issuesByCategory = result?.issues.reduce(
    (acc, issue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    },
    {} as Record<string, typeof result.issues>,
  );

  return (
    <div className="min-h-screen bg-[#FFFBF0] text-[#1a1a1a]">
      {/* Nav */}
      <nav className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A]">
              <Activity className="size-5" strokeWidth={2.5} />
            </div>
            <span className="text-xl font-black tracking-tight">SitePulse</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm font-medium text-[#1a1a1a]/60 sm:block">
              Free website health checker
            </span>
          </div>
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
            <p className="mx-auto mt-4 max-w-xl text-base text-[#1a1a1a]/70 sm:text-lg">
              Scan your website and discover the most important issues to fix.
              Free, fast, and no sign-up required.
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
            <div className="grid grid-cols-1 gap-0 sm:grid-cols-3">
              {[
                {
                  icon: Shield,
                  title: "Security Headers",
                  desc: "Check for CSP, HSTS, X-Frame-Options and more critical security headers.",
                  color: "bg-[#DBEAFE]",
                },
                {
                  icon: Search,
                  title: "SEO Basics",
                  desc: "Verify title tags, meta descriptions, heading structure and viewport.",
                  color: "bg-[#FEF3C7]",
                },
                {
                  icon: Zap,
                  title: "Performance",
                  desc: "Measure response time, page size, redirects and loading efficiency.",
                  color: "bg-[#D1FAE5]",
                },
              ].map((feature, i) => (
                <motion.div
                  key={feature.title}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: 0.1 * i }}
                  className={`border-b-2 border-[#1a1a1a] p-6 last:border-b-0 sm:border-b-0 sm:border-r-2 sm:last:border-r-0 ${
                    i === 0
                      ? "sm:border-l-0"
                      : ""
                  }`}
                >
                  <div
                    className={`mb-4 flex size-11 items-center justify-center border-2 border-[#1a1a1a] ${feature.color}`}
                  >
                    <feature.icon className="size-5" strokeWidth={2.5} />
                  </div>
                  <h3 className="mb-2 text-lg font-black">{feature.title}</h3>
                  <p className="text-sm leading-relaxed text-[#1a1a1a]/60">
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
              <h2 className="text-2xl font-black">Scanning your website...</h2>
              <p className="mt-2 text-sm text-[#1a1a1a]/60">
                Checking HTTPS, status, headers, SEO, and performance
              </p>
              <div className="mt-6 flex gap-3">
                {["HTTPS", "Headers", "SEO", "Speed"].map((step, i) => (
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.4, duration: 0.3 }}
                    className="border-2 border-[#1a1a1a] bg-[#DBEAFE] px-3 py-1 text-xs font-bold"
                  >
                    {step}
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
                  {/* Score circle */}
                  <div className="flex flex-col items-center">
                    <div
                      className={`relative flex size-28 items-center justify-center border-3 border-[#1a1a1a] ${gradeColors[result.grade] || "bg-gray-300"}`}
                      style={{
                        borderWidth: "3px",
                      }}
                    >
                      <span className="text-5xl font-black text-[#1a1a1a]">
                        {result.score}
                      </span>
                    </div>
                    <div className="mt-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-1 text-sm font-black text-white">
                      Grade {result.grade}
                    </div>
                  </div>

                  {/* Quick info */}
                  <div className="flex-1 text-center sm:text-left">
                    <h2 className="text-2xl font-black sm:text-3xl">
                      Health Report
                    </h2>
                    <div className="mt-1 flex items-center gap-2 justify-center sm:justify-start">
                      <span className="text-sm text-[#1a1a1a]/60 break-all">
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
                  </div>
                </div>
              </div>
            </div>

            {/* Detailed stats grid */}
            <div className="border-b-2 border-[#1a1a1a] bg-white">
              <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
                <h3 className="mb-4 text-lg font-black">Page Overview</h3>
                <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-4">
                  {[
                    {
                      label: "Title",
                      value: result.title
                        ? result.title.length > 40
                          ? result.title.slice(0, 40) + "…"
                          : result.title
                        : "Missing",
                      ok: !!result.title,
                    },
                    {
                      label: "Meta Desc",
                      value: result.description
                        ? result.description.length > 40
                          ? result.description.slice(0, 40) + "…"
                          : result.description
                        : "Missing",
                      ok: !!result.description,
                    },
                    {
                      label: "Viewport",
                      value: result.hasViewport ? "Set" : "Missing",
                      ok: result.hasViewport,
                    },
                    {
                      label: "Language",
                      value: result.hasLanguage ? "Set" : "Missing",
                      ok: result.hasLanguage,
                    },
                    {
                      label: "H1 Tags",
                      value: String(result.h1Count),
                      ok: result.h1Count === 1,
                    },
                    {
                      label: "Images",
                      value: result.imagesWithoutAlt > 0
                        ? `${result.imageCount} (${result.imagesWithoutAlt} no alt)`
                        : String(result.imageCount),
                      ok: result.imagesWithoutAlt === 0,
                    },
                    {
                      label: "Links",
                      value: `${result.internalLinkCount} int / ${result.externalLinkCount} ext`,
                      ok: true,
                    },
                    {
                      label: "Scripts",
                      value: String(result.scriptCount),
                      ok: result.scriptCount < 15,
                    },
                  ].map((stat, i) => (
                    <div
                      key={stat.label}
                      className={`border-b-2 border-[#1a1a1a] p-3 ${
                        i % 4 !== 3 ? "sm:border-r-2" : ""
                      } ${
                        i < 4 ? "" : "border-b-0 sm:border-b-2"
                      } ${
                        i === 4 ? "border-b-2 sm:border-b-2" : ""
                      }`}
                      style={{
                        borderRight:
                          i % 4 === 3
                            ? "none"
                            : i < 4 || (i >= 4 && i % 4 !== 3)
                              ? undefined
                              : "none",
                      }}
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
                    },
                    {
                      label: "X-Frame-Options",
                      present: result.hasXFrameOptions,
                    },
                    {
                      label: "X-Content-Type-Options",
                      present: result.hasXContentTypeOptions,
                    },
                    {
                      label: "Strict-Transport-Security",
                      present: result.hasStrictTransportSecurity,
                    },
                    {
                      label: "Referrer-Policy",
                      present: result.hasReferrerPolicy,
                    },
                    {
                      label: "Permissions-Policy",
                      present: result.hasPermissionsPolicy,
                    },
                  ].map((header) => (
                    <div
                      key={header.label}
                      className="flex items-center justify-between border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-2.5"
                    >
                      <span className="text-sm font-bold">
                        {header.label}
                      </span>
                      {header.present ? (
                        <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-600">
                          <CheckCircle className="size-3.5" /> Present
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs font-bold text-red-600">
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
                  <h3 className="text-lg font-black">Issues Found</h3>
                  <span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">
                    {result.issues.length} total
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {issuesByCategory &&
                    Object.entries(issuesByCategory).map(
                      ([category, categoryIssues]) => (
                        <IssueGroup
                          key={category}
                          category={category}
                          issues={categoryIssues}
                        />
                      ),
                    )}
                </div>
              </div>
            </div>

            {/* Scan again */}
            <div className="bg-[#FFFBF0]">
              <div className="mx-auto max-w-6xl px-4 py-10 text-center sm:px-6">
                <p className="mb-4 text-sm font-medium text-[#1a1a1a]/60">
                  Want to scan another website?
                </p>
                <button
                  onClick={() => {
                    setResult(null);
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
      className={`inline-flex items-center gap-1 border-2 border-[#1a1a1a] px-2.5 py-0.5 text-xs font-bold ${
        ok ? "bg-[#D1FAE5]" : "bg-red-100"
      }`}
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

  return (
    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-3">
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
                  <div
                    key={i}
                    className="flex items-start gap-3 px-4 py-3"
                  >
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
