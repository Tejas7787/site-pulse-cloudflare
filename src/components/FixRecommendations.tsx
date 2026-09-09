import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Wrench,
  AlertTriangle,
  XCircle,
  Info,
  ExternalLink,
  Lightbulb,
} from "lucide-react";
import type { Priority, Severity } from "../types/scan";

/* ── Priority badge colors ─────────────────────────────────────────── */

const priorityUI: Record<
  Priority,
  { label: string; color: string; bg: string; border: string }
> = {
  critical: {
    label: "Critical",
    color: "text-red-700",
    bg: "bg-red-100",
    border: "border-red-300",
  },
  important: {
    label: "High",
    color: "text-amber-700",
    bg: "bg-amber-100",
    border: "border-amber-300",
  },
  recommended: {
    label: "Medium",
    color: "text-blue-700",
    bg: "bg-blue-100",
    border: "border-blue-300",
  },
  "nice-to-have": {
    label: "Low",
    color: "text-gray-600",
    bg: "bg-gray-100",
    border: "border-gray-200",
  },
};

const severityUI: Record<
  Severity,
  { icon: typeof XCircle; color: string; bg: string }
> = {
  critical: { icon: XCircle, color: "text-red-600", bg: "bg-red-100" },
  warning: { icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-100" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-100" },
};

/* ── Copy-paste snippet map ─────────────────────────────────────────── */

type Issue = {
  category: string;
  severity: Severity;
  priority: Priority;
  message: string;
  whyItMatters: string;
  howToFix: string;
};

const SNIPPET_MAP: Record<
  string,
  { label: string; code: string; language?: string } | undefined
> = {
  // ── Security headers ──
  "Missing Content-Security-Policy header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block or location:\nadd_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';" always;`,
  },
  "Missing Strict-Transport-Security (HSTS) header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`,
  },
  "Missing X-Frame-Options header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header X-Frame-Options "DENY" always;`,
  },
  "Missing X-Content-Type-Options header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header X-Content-Type-Options "nosniff" always;`,
  },
  "Missing Referrer-Policy header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;`,
  },
  "Missing Permissions-Policy header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;`,
  },
  "Missing X-Permitted-Cross-Domain-Policies header": {
    label: "Nginx config",
    code: `# Add to your Nginx server block:\nadd_header X-Permitted-Cross-Domain-Policies "none" always;`,
  },

  // ── Apache variants ──
  "Missing Content-Security-Policy header.": {
    label: "Apache .htaccess",
    code: `# Add to your .htaccess or Apache config:\nHeader always set Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';"`,
  },

  // ── SEO ──
  "No title tag found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<title>Your Page Title Here — 30-60 characters</title>`,
  },
  "No meta description found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<meta name="description" content="A compelling 120-160 character description of this page that entices users to click from search results.">`,
  },
  "No H1 tag found.": {
    label: "HTML",
    code: `<!-- Add exactly one <h1> per page, inside <body> -->\n<h1>Your Main Page Heading</h1>`,
  },
  "No canonical tag found.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<link rel="canonical" href="https://yourdomain.com/this-page">`,
  },
  "No robots.txt file found.": {
    label: "robots.txt",
    code: `# Create at your site root: https://yourdomain.com/robots.txt\nUser-agent: *\nAllow: /\nSitemap: https://yourdomain.com/sitemap.xml`,
  },
  "No sitemap.xml found.": {
    label: "sitemap.xml",
    code: `<!-- Create at your site root: https://yourdomain.com/sitemap.xml -->\n<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://yourdomain.com/</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>`,
  },

  // ── Technical ──
  "No viewport meta tag.": {
    label: "HTML",
    code: `<!-- Add inside <head> -->\n<meta name="viewport" content="width=device-width, initial-scale=1.0">`,
  },
  "Missing charset declaration.": {
    label: "HTML",
    code: `<!-- Add as the first tag inside <head> -->\n<meta charset="utf-8">`,
  },
  "Missing DOCTYPE declaration.": {
    label: "HTML",
    code: `<!-- Add as the very first line of your HTML file -->\n<!DOCTYPE html>`,
  },

  // ── Accessibility ──
  "The <html> tag is missing a lang attribute.": {
    label: "HTML",
    code: `<!-- Change your <html> tag -->\n<html lang="en">`,
  },
  "form input(s) may be missing associated labels.": {
    label: "HTML",
    code: `<!-- Pair each input with a label -->\n<label for="email">Email address</label>\n<input id="email" type="email" name="email">`,
  },
};

/* ── Determine snippet from issue ──────────────────────────────────── */

function findSnippet(issue: Issue): { label: string; code: string } | null {
  // Exact match first
  const exact = SNIPPET_MAP[issue.message];
  if (exact) return exact;

  // Fuzzy match on header missing messages
  for (const [key, val] of Object.entries(SNIPPET_MAP)) {
    if (val && (issue.message.includes(key) || issue.howToFix.includes(key))) return val;
  }

  // Security header presence check — build from the howToFix text
  if (
    issue.category === "Security" &&
    issue.message.toLowerCase().includes("missing") &&
    issue.message.toLowerCase().includes("header")
  ) {
    return { label: "Header fix", code: `# Add this header to your server configuration:\n# ${issue.howToFix}` };
  }

  return null;
}

/* ── Copy button ────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 border-2 border-[#1a1a1a] px-2.5 py-1 text-[11px] font-bold transition-colors ${
        copied
          ? "bg-emerald-100 text-emerald-700"
          : "bg-white text-[#1a1a1a] hover:bg-[#FDE68A]"
      }`}
      aria-label={copied ? "Copied to clipboard" : "Copy code snippet"}
    >
      {copied ? (
        <>
          <Check className="size-3" /> Copied
        </>
      ) : (
        <>
          <Copy className="size-3" /> Copy
        </>
      )}
    </button>
  );
}

/* ── Single recommendation card ─────────────────────────────────────── */

function RecommendationCard({
  issue,
  index,
}: {
  issue: Issue;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const pri = priorityUI[issue.priority];
  const sev = severityUI[issue.severity];
  const SevIcon = sev.icon;
  const snippet = findSnippet(issue);

  return (
    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <div
          className="flex size-7 shrink-0 items-center justify-center border border-[#1a1a1a]/20 bg-white text-xs font-black mt-0.5"
          aria-hidden="true"
        >
          {index + 1}
        </div>
        <div
          className={`mt-0.5 flex size-6 shrink-0 items-center justify-center border border-[#1a1a1a]/20 ${sev.bg}`}
        >
          <SevIcon className={`size-3.5 ${sev.color}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`border ${pri.border} ${pri.bg} px-1.5 py-0.5 text-[10px] font-bold ${pri.color}`}
            >
              {pri.label}
            </span>
            <span className="text-[10px] font-bold text-[#1a1a1a]/30">
              {issue.category}
            </span>
          </div>
          <p className="mt-1 text-sm font-bold text-[#1a1a1a]">
            {issue.message}
          </p>
        </div>
        <ChevronDown
          className={`size-4 shrink-0 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden border-t-2 border-[#1a1a1a]"
          >
            <div className="px-4 py-3 space-y-3">
              {/* 1. What's wrong */}
              <div className="border-l-3 border-red-400 bg-red-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-red-700">
                  What's wrong
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  {issue.message}
                </p>
              </div>

              {/* 2. Why it matters */}
              <div className="border-l-3 border-amber-400 bg-amber-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
                  Why it matters
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  {issue.whyItMatters}
                </p>
              </div>

              {/* 3. How to fix */}
              <div className="border-l-3 border-emerald-400 bg-emerald-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  How to fix
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  {issue.howToFix}
                </p>
              </div>

              {/* 4. Copy-paste fix */}
              {snippet && (
                <div className="border-l-3 border-blue-400 bg-blue-50 pl-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700">
                      Copy-paste fix · {snippet.label}
                    </div>
                    <CopyButton text={snippet.code} />
                  </div>
                  <pre className="mt-2 overflow-x-auto rounded border border-[#1a1a1a]/10 bg-white p-3 text-xs leading-relaxed text-[#1a1a1a]/80">
                    <code>{snippet.code}</code>
                  </pre>
                </div>
              )}

              {/* 5. Verify fix */}
              <div className="border-l-3 border-purple-400 bg-purple-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-purple-700">
                  Verify the fix
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  After applying the fix, run a new scan with SitePulse to
                  confirm the issue is resolved. The check should move from{" "}
                  <span className="font-bold text-red-600">failed</span> to{" "}
                  <span className="font-bold text-emerald-600">passed</span>,
                  and your {issue.category.toLowerCase()} score should improve.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Main FixRecommendations section ────────────────────────────────── */

export default function FixRecommendations({
  issues,
}: {
  issues: Issue[];
}) {
  const [showAll, setShowAll] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Priority | "all">("all");

  // Only show issues that are actual problems (critical / important / recommended)
  const actionable = issues.filter(
    (i) =>
      i.priority === "critical" ||
      i.priority === "important" ||
      i.priority === "recommended",
  );

  if (actionable.length === 0) return null;

  // Sort by priority order
  const priorityOrder: Record<Priority, number> = {
    critical: 0,
    important: 1,
    recommended: 2,
    "nice-to-have": 3,
  };
  const sorted = [...actionable].sort(
    (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority],
  );

  const filtered =
    activeFilter === "all"
      ? sorted
      : sorted.filter((i) => i.priority === activeFilter);

  const displayed = showAll ? filtered : filtered.slice(0, 8);

  const counts = {
    all: actionable.length,
    critical: actionable.filter((i) => i.priority === "critical").length,
    important: actionable.filter((i) => i.priority === "important").length,
    recommended: actionable.filter((i) => i.priority === "recommended").length,
  };

  const filters: { key: Priority | "all"; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    ...(counts.critical > 0
      ? [{ key: "critical" as Priority, label: "Critical", count: counts.critical }]
      : []),
    ...(counts.important > 0
      ? [{ key: "important" as Priority, label: "High", count: counts.important }]
      : []),
    ...(counts.recommended > 0
      ? [{ key: "recommended" as Priority, label: "Medium", count: counts.recommended }]
      : []),
  ];

  return (
    <section className="border-b-2 border-[#1a1a1a] bg-white">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="size-5 text-blue-600" />
          <h2 className="text-lg font-black">Fix Recommendations</h2>
        </div>
        <p className="text-xs text-[#1a1a1a]/50 mb-4">
          Actionable fixes for every failed or warning check. Expand any issue
          to see what's wrong, why it matters, how to fix it, and a copy-paste
          code snippet where applicable.
        </p>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setActiveFilter(f.key);
                setShowAll(false);
              }}
              className={`border-2 border-[#1a1a1a] px-3 py-1 text-xs font-bold transition-colors ${
                activeFilter === f.key
                  ? "bg-[#1a1a1a] text-white"
                  : "bg-white text-[#1a1a1a] hover:bg-[#FDE68A]"
              }`}
            >
              {f.label}
              <span className="ml-1 text-[10px] opacity-60">{f.count}</span>
            </button>
          ))}
        </div>

        {/* Recommendations list */}
        <div className="space-y-2">
          {displayed.map((issue, i) => (
            <RecommendationCard key={i} issue={issue} index={i} />
          ))}
        </div>

        {/* Show more / less */}
        {filtered.length > 8 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="mt-4 flex items-center gap-1.5 text-xs font-bold text-[#1a1a1a]/50 transition-colors hover:text-[#1a1a1a]"
          >
            {showAll ? (
              <>
                <ChevronUp className="size-3.5" /> Show fewer
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" /> Show all{" "}
                {filtered.length} recommendations
              </>
            )}
          </button>
        )}

        {/* Low priority hint */}
        {issues.filter((i) => i.priority === "nice-to-have").length > 0 && (
          <div className="mt-4 border-2 border-dashed border-[#1a1a1a]/15 bg-[#FFFBF0] px-4 py-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-[#1a1a1a]/30" />
              <span className="text-xs font-bold text-[#1a1a1a]/40">
                {issues.filter((i) => i.priority === "nice-to-have").length}{" "}
                additional low-priority recommendations available in the full
                issue list below.
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
