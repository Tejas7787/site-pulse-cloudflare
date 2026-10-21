import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { motion, AnimatePresence } from "framer-motion";
import { FileDiff, Loader2, AlertCircle, ChevronDown, Clock, Info } from "lucide-react";
import {
  FIX_PROPOSAL_LIMIT_PER_HOUR,
  type FixProposal,
} from "../lib/fixProposal";
import GitHubRepair from "./GitHubRepair";

/* ── Fix Proposals (Phase 4, V1) ─────────────────────────────────────────────
 * Sits immediately after the AI Website Doctor on the report page and offers
 * concrete, copy-paste fix proposals for this report's findings — target
 * file, labeled proposed change, rationale and a unified-diff preview — all
 * server-side (quota + trusted scan fetch through api.aiAssistant.proposeFixes).
 *
 * HONESTY CONTRACT (V1): deterministic only — no model ran, and SitePulse
 * never read the site owner's source files. Every preview is labeled a
 * proposed snippet, never a verified before/after diff, and the panel states
 * that nothing was applied anywhere. Screen-only: the report wraps this in
 * print:hidden so neither the PDF nor print output include it.
 */

const PRIORITY_CHIP: Record<string, string> = {
  critical: "border-red-300 bg-red-100 text-red-700",
  important: "border-amber-300 bg-amber-100 text-amber-700",
  recommended: "border-blue-300 bg-blue-100 text-blue-700",
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

/** Unified-diff preview: proposed additions only, line-colored. */
function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="overflow-x-auto border-2 border-[#1a1a1a] bg-[#FAFAF5] px-3 py-2 font-mono text-[11px] leading-relaxed">
      {diff.split("\n").map((line, i) => {
        const style = line.startsWith("+")
          ? "text-emerald-800 bg-emerald-50"
          : line.startsWith("---") || line.startsWith("+++")
            ? "font-bold text-[#1a1a1a]/70"
            : line.startsWith("@@")
              ? "text-sky-800 bg-sky-50"
              : "text-[#1a1a1a]/60";
        return (
          <div key={i} className={style}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </pre>
  );
}

export default function FixProposalPanel({
  scanId,
  visitorId,
}: {
  scanId: Id<"scans">;
  visitorId?: string;
}) {
  const proposeFixes = useAction(api.aiAssistant.proposeFixes);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaNotice, setQuotaNotice] = useState<string | null>(null);
  const [result, setResult] = useState<
    Extract<Awaited<ReturnType<typeof proposeFixes>>, { kind: "ok" }> | null
  >(null);
  const [expanded, setExpanded] = useState(true);

  const run = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setQuotaNotice(null);
    try {
      const res = await proposeFixes({ scanId, ...(visitorId ? { visitorId } : {}) });
      if (res.kind === "ok") {
        setResult(res);
      } else if (res.kind === "quotaExceeded") {
        const minutes = Math.max(1, Math.ceil(res.retryAfterMs / 60_000));
        setQuotaNotice(
          `Proposal limit reached — SitePulse prepares up to ${res.limit} fix proposals per visitor per hour. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      } else {
        setError("This report could not be found — it may have been removed.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Fix proposals are temporarily unavailable.",
      );
    } finally {
      setLoading(false);
    }
  };

  const proposals = result?.result.proposals ?? [];

  return (
    <section className="border-b-2 border-[#1a1a1a] bg-white print:hidden">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-between text-left"
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#DBEAFE]">
              <FileDiff className="size-5 text-sky-700" strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black">
                Fix Proposals
                <span className="border border-[#1a1a1a]/20 bg-[#FFFBF0] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/45">
                  Deterministic · Suggestions only
                </span>
              </h2>
              <p className="text-xs text-[#1a1a1a]/50">
                Copy-paste proposals for this report&rsquo;s findings — the file to touch, the
                exact lines to add, and why — all derived from saved evidence. Nothing is
                applied for you.
              </p>
            </div>
          </div>
          <ChevronDown
            className={`size-5 shrink-0 text-[#1a1a1a]/30 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              {/* CTA + honest status */}
              {!result && (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    onClick={run}
                    disabled={loading}
                    className="inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-4 py-2 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <FileDiff className="size-4" />
                    )}
                    {loading ? "Preparing proposals…" : "Propose fixes for this report"}
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#1a1a1a]/45">
                    <Clock className="size-3.5" />
                    {`Suggestions from saved evidence · limit ${FIX_PROPOSAL_LIMIT_PER_HOUR} per hour`}
                  </span>
                </div>
              )}

              {/* Loading */}
              <AnimatePresence>
                {loading && !result && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-4 flex items-center gap-3 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3"
                  >
                    <Loader2 className="size-5 animate-spin text-sky-700" />
                    <div>
                      <p className="text-sm font-bold text-[#1a1a1a]">
                        Preparing fix proposals from this report&rsquo;s evidence…
                      </p>
                      <p className="text-[11px] text-[#1a1a1a]/40">
                        No model, network call or external service is involved.
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Quota notice */}
              {quotaNotice && (
                <div className="mt-4 flex items-start gap-2 border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  <Clock className="mt-0.5 size-4 shrink-0" />
                  <span>{quotaNotice}</span>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-4 flex items-start gap-3 border-2 border-red-300 bg-red-50 px-4 py-3">
                  <AlertCircle className="size-4 mt-0.5 shrink-0 text-red-600" />
                  <div>
                    <p className="text-sm font-bold text-red-700">Unable to prepare proposals</p>
                    <p className="mt-0.5 text-xs text-red-600/70">{error}</p>
                  </div>
                </div>
              )}

              {/* Result */}
              {result && result.kind === "ok" && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4"
                >
                  {/* Honest provenance — deterministic, nothing applied. */}
                  <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <FileDiff className="size-4 text-sky-700" />
                      <span className="text-xs font-bold text-[#1a1a1a]/60">
                        Fix proposals for {result.result.platformLabel}
                      </span>
                      <span className="border border-[#1a1a1a]/20 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/45">
                        Proposed snippets · not verified diffs
                      </span>
                      {typeof result.remaining === "number" && (
                        <span className="text-[10px] font-bold text-[#1a1a1a]/35">
                          {result.remaining} run{result.remaining === 1 ? "" : "s"} left this hour
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-[#1a1a1a]/55">
                      {result.result.notice}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-[#1a1a1a]/80">
                      {result.result.summary}
                    </p>
                  </div>

                  {/* Proposals */}
                  {proposals.length === 0 ? (
                    <div className="mt-3 border-2 border-[#1a1a1a] bg-white px-4 py-4 text-sm font-bold text-[#1a1a1a]">
                      No copy-paste proposals for this report — the evidence behind its
                      findings does not support a concrete file change, so none is invented.
                      Follow the written guidance in Fix Recommendations below instead.
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {proposals.map((proposal: FixProposal, index: number) => (
                        <div key={proposal.key} className="border-2 border-[#1a1a1a] bg-white">
                          {/* Card header */}
                          <div className="flex items-start gap-3 border-b-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                            <div className="flex size-7 shrink-0 items-center justify-center border-2 border-[#1a1a1a] bg-white text-xs font-black">
                              {index + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-bold text-[#1a1a1a]">
                                {proposal.message}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                                <span className="border border-[#1a1a1a]/15 bg-white px-1.5 py-0.5 text-[#1a1a1a]/55">
                                  {proposal.category}
                                </span>
                                <span
                                  className={`border px-1.5 py-0.5 ${PRIORITY_CHIP[proposal.priority] ?? "border-[#1a1a1a]/15 bg-white text-[#1a1a1a]/55"}`}
                                >
                                  {proposal.priority}
                                </span>
                                <span className="text-[#1a1a1a]/40">
                                  {SEVERITY_LABEL[proposal.severity] ?? proposal.severity}
                                </span>
                                <span className="border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-sky-800">
                                  {proposal.targetPath}
                                </span>
                                <span className="text-[#1a1a1a]/40">{proposal.snippetLabel}</span>
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2.5 px-4 py-3 text-sm leading-relaxed">
                            {/* Honest label above every preview */}
                            <div className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800">
                              <Info className="mt-0.5 size-3.5 shrink-0" />
                              <span>{proposal.previewNotice}</span>
                            </div>

                            {/* Diff preview */}
                            <DiffPreview diff={proposal.diff} />

                            {proposal.assumption && (
                              <p className="text-[11px] italic text-[#1a1a1a]/50">
                                {proposal.assumption}
                              </p>
                            )}

                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                Why this change
                              </span>
                              <p className="mt-0.5 text-[#1a1a1a]/75">{proposal.rationale}</p>
                            </div>

                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                Where it applies
                              </span>
                              <p className="mt-0.5 text-[#1a1a1a]/75">
                                {proposal.targetLabel}
                                {proposal.evidence && (
                                  <span className="text-[#1a1a1a]/50">
                                    {" "}
                                    · Observed: {proposal.evidence}
                                  </span>
                                )}
                              </p>
                            </div>

                            {proposal.anchor && (
                              <a
                                href={`#${proposal.anchor}`}
                                className="inline-flex items-center gap-1 border-2 border-[#1a1a1a] bg-[#FDE68A] px-2.5 py-1 text-[11px] font-bold transition-colors hover:bg-[#FCD34D]"
                              >
                                See the full recommendation →
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Phase 5 — GitHub Repair: code-aware proposals for the same
                      findings, with connection, diff review and approval flow. */}
                  <GitHubRepair scanId={scanId} proposals={proposals} />

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => setResult(null)}
                      className="border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#FDE68A]"
                    >
                      Propose again
                    </button>
                    <span className="text-[10px] text-[#1a1a1a]/30">
                      each run uses one of your {FIX_PROPOSAL_LIMIT_PER_HOUR} hourly proposal
                      runs — nothing is applied until you review and apply a change yourself
                    </span>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
