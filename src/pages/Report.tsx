import { useParams, Link } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Id } from "../convex/_generated/dataModel";
import {
  ArrowLeft,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Info,
  ChevronDown,
  ExternalLink,
  Activity,
  Share2,
  Loader2,
  Globe,
  Shield,
  Search,
  Zap,
  Eye,
} from "lucide-react";

type Severity = "critical" | "warning" | "info";

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

const categoryIcons: Record<string, typeof Shield> = {
  Performance: Zap,
  SEO: Search,
  Security: Shield,
  Accessibility: Eye,
  "Technical Health": Globe,
};

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Report() {
  const { id } = useParams<{ id: string }>();
  const [copied, setCopied] = useState(false);

  const scan = useQuery(
    api.scans.getScan,
    id ? { id: id as Id<"scans"> } : "skip",
  );

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the URL
    }
  };

  if (scan === undefined) {
    return (
      <div className="min-h-screen bg-[#FFFBF0] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="size-8 animate-spin text-[#1a1a1a]/40" />
          <p className="text-sm font-medium text-[#1a1a1a]/60">
            Loading report...
          </p>
        </div>
      </div>
    );
  }

  if (scan === null) {
    return (
      <div className="min-h-screen bg-[#FFFBF0] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="mb-6 flex size-16 mx-auto items-center justify-center border-2 border-[#1a1a1a] bg-red-100">
            <XCircle className="size-8 text-red-600" />
          </div>
          <h1 className="text-2xl font-black">Report Not Found</h1>
          <p className="mt-2 text-sm text-[#1a1a1a]/60 max-w-sm">
            This scan report does not exist or may have been removed. Run a new
            scan to generate a fresh report.
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-5 py-2.5 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"
          >
            <ArrowLeft className="size-4" />
            Back to SitePulse
          </Link>
        </div>
      </div>
    );
  }

  const issuesByCategory = scan.issues.reduce(
    (acc, issue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    },
    {} as Record<string, typeof scan.issues>,
  );

  // Category order
  const categoryOrder = [
    "Performance",
    "SEO",
    "Security",
    "Accessibility",
    "Technical Health",
  ];
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
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-bold text-[#1a1a1a]/60 transition-colors hover:text-[#1a1a1a]"
          >
            <ArrowLeft className="size-4" />
            SitePulse
          </Link>
          <button
            onClick={handleShare}
            className="flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#BFDBFE]"
          >
            <Share2 className="size-3.5" />
            {copied ? "Copied!" : "Share Report"}
          </button>
        </div>
      </nav>

      {/* Report Header */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            {/* Score */}
            <div className="flex flex-col items-center">
              <div
                className={`relative flex size-28 items-center justify-center border-[3px] border-[#1a1a1a] ${gradeColors[scan.grade] || "bg-gray-300"}`}
              >
                <span className="text-5xl font-black text-[#1a1a1a]">
                  {scan.score}
                </span>
              </div>
              <div className="mt-2 border-2 border-[#1a1a1a] bg-[#1a1a1a] px-4 py-1 text-sm font-black text-white">
                Grade {scan.grade}
              </div>
            </div>

            {/* Info */}
            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-2xl font-black sm:text-3xl">
                Website Health Report
              </h1>
              <div className="mt-2 flex items-center gap-2 justify-center sm:justify-start">
                <Globe className="size-4 text-[#1a1a1a]/40" />
                <span className="text-sm text-[#1a1a1a]/60 break-all font-medium">
                  {scan.url}
                </span>
                <a
                  href={scan.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-[#1a1a1a]/40 hover:text-[#1a1a1a] transition-colors"
                >
                  <ExternalLink className="size-4" />
                </a>
              </div>
              <p className="mt-1 text-xs text-[#1a1a1a]/40">
                Scanned {formatDate(scan.scannedAt)}
              </p>

              <div className="mt-4 flex flex-wrap gap-2 justify-center sm:justify-start">
                <StatusPill
                  ok={scan.status >= 200 && scan.status < 400}
                  label={`HTTP ${scan.status}`}
                />
                <StatusPill
                  ok={scan.https}
                  label={scan.https ? "HTTPS" : "No HTTPS"}
                />
                <StatusPill
                  ok={scan.responseTime < 2000}
                  label={`${scan.responseTime}ms`}
                />
                <StatusPill ok={true} label={scan.pageSizeFormatted} />
                {scan.redirects > 0 && (
                  <StatusPill
                    ok={scan.redirects < 3}
                    label={`${scan.redirects} redirect${scan.redirects > 1 ? "s" : ""}`}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Page Overview */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <h2 className="mb-4 text-lg font-black">Page Overview</h2>
          <div className="grid grid-cols-2 gap-0 border-2 border-[#1a1a1a] sm:grid-cols-4">
            {[
              {
                label: "Title",
                value: scan.title
                  ? scan.title.length > 40
                    ? scan.title.slice(0, 40) + "\u2026"
                    : scan.title
                  : "Missing",
                ok: !!scan.title,
              },
              {
                label: "Meta Description",
                value: scan.description
                  ? scan.description.length > 40
                    ? scan.description.slice(0, 40) + "\u2026"
                    : scan.description
                  : "Missing",
                ok: !!scan.description,
              },
              {
                label: "Viewport",
                value: scan.hasViewport ? "Configured" : "Missing",
                ok: scan.hasViewport,
              },
              {
                label: "Language",
                value: scan.hasLanguage ? "Configured" : "Missing",
                ok: scan.hasLanguage,
              },
              {
                label: "Headings (H1)",
                value: String(scan.h1Count),
                ok: scan.h1Count === 1,
              },
              {
                label: "Images",
                value:
                  scan.imagesWithoutAlt > 0
                    ? `${scan.imageCount} total (${scan.imagesWithoutAlt} without alt text)`
                    : `${scan.imageCount} total`,
                ok: scan.imagesWithoutAlt === 0,
              },
              {
                label: "Links",
                value: `${scan.internalLinkCount} internal / ${scan.externalLinkCount} external`,
                ok: true,
              },
              {
                label: "Scripts & Styles",
                value: `${scan.scriptCount} scripts / ${scan.styleCount} styles`,
                ok: scan.scriptCount < 15,
              },
            ].map((stat, i) => (
              <div
                key={stat.label}
                className={`border-b-2 border-[#1a1a1a] p-3 ${i < 4 ? "sm:border-r-2" : ""} ${i === 3 || i === 7 ? "" : i < 4 ? "sm:border-r-2" : ""}`}
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
      </section>

      {/* Security Headers */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <h2 className="mb-4 text-lg font-black">Security Headers</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              {
                label: "Content-Security-Policy",
                present: scan.hasCSP,
                hint: "Protects against XSS and injection attacks",
              },
              {
                label: "X-Frame-Options",
                present: scan.hasXFrameOptions,
                hint: "Prevents clickjacking",
              },
              {
                label: "X-Content-Type-Options",
                present: scan.hasXContentTypeOptions,
                hint: "Prevents MIME-type sniffing",
              },
              {
                label: "Strict-Transport-Security",
                present: scan.hasStrictTransportSecurity,
                hint: "Enforces HTTPS connections",
              },
              {
                label: "Referrer-Policy",
                present: scan.hasReferrerPolicy,
                hint: "Controls referrer information sharing",
              },
              {
                label: "Permissions-Policy",
                present: scan.hasPermissionsPolicy,
                hint: "Controls browser feature access",
              },
            ].map((header) => (
              <div
                key={header.label}
                className="flex items-center justify-between border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3"
              >
                <div>
                  <span className="text-sm font-bold">{header.label}</span>
                  <p className="text-[11px] text-[#1a1a1a]/40 mt-0.5">
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
      </section>

      {/* Issues by Category */}
      <section className="border-b-2 border-[#1a1a1a] bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black">Recommendations</h2>
            <span className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1 text-xs font-bold">
              {scan.issues.length} issue{scan.issues.length !== 1 ? "s" : ""}{" "}
              found
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
      </section>

      {/* Scan again */}
      <section className="bg-[#FFFBF0]">
        <div className="mx-auto max-w-5xl px-4 py-10 text-center sm:px-6">
          <p className="mb-4 text-sm font-medium text-[#1a1a1a]/60">
            Want to check another website?
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"
          >
            <Activity className="size-4" />
            Run a New Scan
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] text-white">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
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

function IssueGroup({
  category,
  issues,
}: {
  category: string;
  issues: Array<{
    category: string;
    severity: Severity;
    message: string;
  }>;
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
