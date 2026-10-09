import { useEffect, useState, useSyncExternalStore } from "react";
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
  Lightbulb,
} from "lucide-react";
import type { Priority, Severity } from "../types/scan";
import {
  anchorsFor,
  buildSnippet,
  canonicalActionable,
  dedupeIssues,
  issueKey,
  type FixSnippet,
  type RecommendationIssue,
} from "../lib/recommendations";
import { HOSTING_LABELS, type HostingPlatform } from "../lib/hosting";

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
  anchor,
  platform,
  open = false,
}: {
  issue: RecommendationIssue;
  index: number;
  anchor: string;
  platform: HostingPlatform;
  /** True when this card is the one a summary row just linked to. */
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // Following “Details →” should reveal the details, not just the header.
  // Adjusted during render (the React-sanctioned pattern for deriving state
  // from a prop change), so the card opens on the same paint it is linked to;
  // the reader can still close it afterwards.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setExpanded(true);
  }
  const pri = priorityUI[issue.priority];
  const sev = severityUI[issue.severity];
  const SevIcon = sev.icon;
  const snippet: FixSnippet | null = buildSnippet(issue, platform);

  // Trust labels separate what was observed from what is only recommended.
  const trustLabel = issue.status === "unable-to-verify"
    ? "Unable to verify"
    : (issue.confirmed ?? true)
      ? "Confirmed"
      : "Potential risk";
  const trustCls = issue.status === "unable-to-verify"
    ? "border-gray-300 bg-gray-100 text-gray-600"
    : (issue.confirmed ?? true)
      ? "border-emerald-300 bg-emerald-100 text-emerald-700"
      : "border-amber-300 bg-amber-100 text-amber-700";

  return (
    <div id={anchor} className="border-2 border-[#1a1a1a] bg-[#FFFBF0] scroll-mt-4">
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
            <span className={`border px-1.5 py-0.5 text-[10px] font-bold ${trustCls}`}>
              {trustLabel}
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
              {/* Observed evidence */}
              {issue.evidence && (
                <div className="border-l-3 border-blue-400 bg-blue-50 pl-3 py-2">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700">
                    What was observed
                  </div>
                  <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                    {issue.evidence}
                  </p>
                </div>
              )}

              {/* Why it matters */}
              <div className="border-l-3 border-amber-400 bg-amber-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
                  Why it matters
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  {issue.whyItMatters}
                </p>
              </div>

              {/* How to fix */}
              <div className="border-l-3 border-emerald-400 bg-emerald-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                  Recommendation
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  {issue.howToFix}
                </p>
              </div>

              {/* Copy-paste fix, written for the platform the scan observed */}
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
                  {snippet.assumption && (
                    <p className="mt-2 text-[11px] leading-relaxed text-[#1a1a1a]/55">
                      {snippet.assumption}
                    </p>
                  )}
                </div>
              )}

              {/* Verify fix */}
              <div className="border-l-3 border-purple-400 bg-purple-50 pl-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-purple-700">
                  Verify the fix
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-[#1a1a1a]/70">
                  After applying the fix, run a new scan with SitePulse to
                  confirm the check moves to <span className="font-bold text-emerald-600">passed</span>{" "}
                  and your {issue.category.toLowerCase()} score improves.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Hash tracking (so anchor links always find their card) ─────────── */

const subscribeHashChange = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readHash = () => window.location.hash;

/* ── Main FixRecommendations section ────────────────────────────────── */

export default function FixRecommendations({
  issues,
  platform = "unknown",
}: {
  issues: RecommendationIssue[];
  platform?: HostingPlatform;
}) {
  const [showAll, setShowAll] = useState(false);
  const [activeFilter, setActiveFilter] = useState<Priority | "all">("all");

  // Repeated advice is collapsed here too, so a duplicate can never sneak in
  // even if a caller passes the raw issue list. Anchors come from the same
  // canonical list the report's summary rows link into.
  const actionable = canonicalActionable(issues);
  const anchors = anchorsFor(actionable);

  // Summary rows link to cards by anchor. If the linked card is past the
  // first page of results it would otherwise not exist yet — the link target
  // must always resolve, so the list opens up for it.
  const hash = useSyncExternalStore(subscribeHashChange, readHash, () => "");
  const targetId = hash.startsWith("#fix-") ? hash.slice(1) : "";
  const targetIndex = targetId
    ? actionable.findIndex((issue) => anchors.get(issueKey(issue)) === targetId)
    : -1;

  // A freshly-followed link opens the list; collapsing it again stays put
  // until the reader follows another link.
  const [anchorOpen, setAnchorOpen] = useState(true);
  const [previousTarget, setPreviousTarget] = useState(targetId);
  if (targetId !== previousTarget) {
    // A newly-followed link re-opens the list, even after a manual collapse.
    setPreviousTarget(targetId);
    setAnchorOpen(true);
  }
  const listExpanded = showAll || (anchorOpen && targetIndex >= 0);

  useEffect(() => {
    if (!targetId || targetIndex < 0) return;
    // The browser cannot scroll to an element that did not exist when the
    // link was followed, so bring the freshly-rendered card into view.
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [targetId, targetIndex, listExpanded]);

  if (actionable.length === 0) return null;

  const filtered =
    activeFilter === "all"
      ? actionable
      : actionable.filter((i) => i.priority === activeFilter);

  const displayed = listExpanded ? filtered : filtered.slice(0, 8);

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

  const lowPriorityCount = dedupeIssues(issues).filter(
    (i) => i.priority === "nice-to-have",
  ).length;

  return (
    <section id="fix-recommendations" className="border-b-2 border-[#1a1a1a] bg-white">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="size-5 text-blue-600" />
          <h2 className="text-lg font-black">Fix Recommendations</h2>
        </div>
        <p className="text-xs text-[#1a1a1a]/50 mb-2">
          Every fix appears once, here. Expand an issue to see what was
          observed, why it matters, the recommendation, and a copy-paste
          snippet{" "}
          {platform === "unknown"
            ? "that stays platform-neutral and states its assumption, because the response named no platform."
            : `written for ${HOSTING_LABELS[platform]}, which is what the scan observed.`}
        </p>
        <p className="text-[11px] font-medium text-[#1a1a1a]/45 mb-4">
          Confirmed findings are backed by observed evidence; “Potential risk”
          entries are hardening recommendations where the evidence shows a
          missing control, not an exploit.
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
            <RecommendationCard
              key={anchors.get(issueKey(issue)) ?? String(i)}
              issue={issue}
              index={i}
              anchor={anchors.get(issueKey(issue)) ?? `fix-${i + 1}`}
              platform={platform}
              open={anchors.get(issueKey(issue)) === targetId}
            />
          ))}
        </div>

        {/* Show more / less */}
        {filtered.length > 8 && (
          <button
            onClick={() => {
              if (listExpanded) {
                setShowAll(false);
                setAnchorOpen(false);
              } else {
                setShowAll(true);
              }
            }}
            className="mt-4 flex items-center gap-1.5 text-xs font-bold text-[#1a1a1a]/50 transition-colors hover:text-[#1a1a1a]"
          >
            {listExpanded ? (
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
        {lowPriorityCount > 0 && (
          <div className="mt-4 border-2 border-dashed border-[#1a1a1a]/15 bg-[#FFFBF0] px-4 py-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-4 text-[#1a1a1a]/30" />
              <span className="text-xs font-bold text-[#1a1a1a]/40">
                {lowPriorityCount} additional low-priority recommendations are
                listed under “Other Findings” below.
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}


