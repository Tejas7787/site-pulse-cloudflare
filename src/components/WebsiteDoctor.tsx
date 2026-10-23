import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { friendlyError } from "@/lib/userErrors";
import { motion, AnimatePresence } from "framer-motion";
import { Stethoscope, Loader2, AlertCircle, ChevronDown, Clock } from "lucide-react";
import { DIAGNOSIS_LIMIT_PER_HOUR, type DoctorDiagnosis } from "../lib/aiDoctor";

/* ── AI Website Doctor (Phase 3, V1) ────────────────────────────────────────
 * Sits immediately after "Fix These First" on the report page and explains
 * findings in plain language: what it means, likely cause, honest impact and
 * prioritized fixes — all server-side (quota + trusted scan fetch through
 * api.aiAssistant.explainFindings).
 *
 * HONESTY CONTRACT: V1 never ran a model, so the panel always labels itself
 * evidence-based / "AI not enabled" and surfaces the server's aiReason. It
 * must never claim model output unless a future server response actually
 * reports an AI run. Screen-only: the report wraps this in print:hidden so
 * neither the PDF nor print output include it.
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

export default function WebsiteDoctor({
  scanId,
  visitorId,
  score,
  grade,
}: {
  scanId: Id<"scans">;
  visitorId?: string;
  score?: number | null;
  grade?: string;
}) {
  const explainFindings = useAction(api.aiAssistant.explainFindings);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaNotice, setQuotaNotice] = useState<string | null>(null);
  const [result, setResult] = useState<
    Extract<Awaited<ReturnType<typeof explainFindings>>, { kind: "ok" }> | null
  >(null);
  const [expanded, setExpanded] = useState(true);

  const run = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setQuotaNotice(null);
    try {
      const res = await explainFindings({ scanId, ...(visitorId ? { visitorId } : {}) });
      if (res.kind === "ok") {
        setResult(res);
      } else if (res.kind === "quotaExceeded") {
        const minutes = Math.max(1, Math.ceil(res.retryAfterMs / 60_000));
        setQuotaNotice(
          `Diagnosis limit reached — the Website Doctor answers ${res.limit} times per visitor per hour. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        );
      } else {
        setError("This report could not be found — it may have been removed.");
      }
    } catch (err) {
      setError(
        friendlyError(err, "The Website Doctor is temporarily unavailable."),
      );
    } finally {
      setLoading(false);
    }
  };

  const diagnosis: DoctorDiagnosis | null = result?.diagnosis ?? null;

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
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#D1FAE5]">
              <Stethoscope className="size-5 text-emerald-700" strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black">
                AI Website Doctor
                <span className="border border-[#1a1a1a]/20 bg-[#FFFBF0] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/45">
                  Evidence-based · AI not enabled
                </span>
              </h2>
              <p className="text-xs text-[#1a1a1a]/50">
                Plain-language explanations of this report&rsquo;s findings — what they mean, why
                they happened, what they cost, and what to do first.
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
                      <Stethoscope className="size-4" />
                    )}
                    {loading ? "Reviewing your findings…" : "Diagnose my report"}
                  </button>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#1a1a1a]/45">
                    <Clock className="size-3.5" />
                    {score !== undefined && score !== null
                      ? `Based on your ${score}/100 report${grade ? ` (grade ${grade})` : ""} · limit ${DIAGNOSIS_LIMIT_PER_HOUR} per hour`
                      : `Limit: ${DIAGNOSIS_LIMIT_PER_HOUR} diagnoses per hour`}
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
                    <Loader2 className="size-5 animate-spin text-emerald-700" />
                    <div>
                      <p className="text-sm font-bold text-[#1a1a1a]">
                        Reviewing this report&rsquo;s findings…
                      </p>
                      <p className="text-[11px] text-[#1a1a1a]/40">
                        Reading the saved evidence — no external analysis is running.
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
                    <p className="text-sm font-bold text-red-700">Unable to diagnose this report</p>
                    <p className="mt-0.5 text-xs text-red-600/70">{error}</p>
                  </div>
                </div>
              )}

              {/* Result */}
              {diagnosis && result?.kind === "ok" && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4"
                >
                  {/* Honest provenance — V1 never ran a model. */}
                  <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Stethoscope className="size-4 text-emerald-700" />
                      <span className="text-xs font-bold text-[#1a1a1a]/60">
                        Website Doctor diagnosis
                      </span>
                      <span className="border border-[#1a1a1a]/20 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/45">
                        Evidence-based · AI not enabled
                      </span>
                      {typeof result.remaining === "number" && (
                        <span className="text-[10px] font-bold text-[#1a1a1a]/35">
                          {result.remaining} diagnosis{result.remaining === 1 ? "" : "es"} left this hour
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-[#1a1a1a]/55">
                      {result.aiReason}
                    </p>
                    <p className="mt-2 text-sm leading-relaxed text-[#1a1a1a]/80">
                      {diagnosis.summary}
                    </p>
                  </div>

                  {/* Findings */}
                  {diagnosis.findings.length === 0 ? (
                    <div className="mt-3 border-2 border-[#1a1a1a] bg-white px-4 py-4 text-sm font-bold text-[#1a1a1a]">
                      No urgent findings to diagnose — nothing needs fixing right now.
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {diagnosis.findings.map((finding, index) => (
                        <div
                          key={finding.key}
                          className="border-2 border-[#1a1a1a] bg-white"
                        >
                          <div className="flex items-start gap-3 border-b-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                            <div className="flex size-7 shrink-0 items-center justify-center border-2 border-[#1a1a1a] bg-white text-xs font-black">
                              {index + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-bold text-[#1a1a1a]">{finding.message}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] font-bold">
                                <span className="border border-[#1a1a1a]/15 bg-white px-1.5 py-0.5 text-[#1a1a1a]/55">
                                  {finding.category}
                                </span>
                                <span
                                  className={`border px-1.5 py-0.5 ${PRIORITY_CHIP[finding.priority] ?? "border-[#1a1a1a]/15 bg-white text-[#1a1a1a]/55"}`}
                                >
                                  {finding.priority}
                                </span>
                                <span className="text-[#1a1a1a]/40">
                                  {SEVERITY_LABEL[finding.severity] ?? finding.severity}
                                </span>
                                {finding.evidence && (
                                  <span
                                    className="max-w-[340px] truncate text-[#1a1a1a]/40"
                                    title={finding.evidence}
                                  >
                                    Observed: {finding.evidence}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="space-y-2.5 px-4 py-3 text-sm leading-relaxed">
                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                What it means
                              </span>
                              <p className="mt-0.5 text-[#1a1a1a]/75">{finding.plainLanguage}</p>
                            </div>
                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                Likely cause
                              </span>
                              <p className="mt-0.5 text-[#1a1a1a]/75">{finding.likelyCause}</p>
                            </div>
                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                Impact
                              </span>
                              <p className="mt-0.5 text-[#1a1a1a]/75">{finding.impactText}</p>
                            </div>
                            <div>
                              <span className="text-[10px] font-black uppercase tracking-wider text-[#1a1a1a]/45">
                                Fix it
                              </span>
                              {finding.fixSteps.length > 0 ? (
                                <ol className="mt-1 space-y-1">
                                  {finding.fixSteps.map((step, stepIndex) => (
                                    <li
                                      key={stepIndex}
                                      className="flex items-start gap-2 text-[#1a1a1a]/75"
                                    >
                                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center border border-[#1a1a1a]/25 bg-[#FFFBF0] text-[9px] font-black">
                                        {stepIndex + 1}
                                      </span>
                                      <span>{step}</span>
                                    </li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="mt-0.5 text-[#1a1a1a]/55">
                                  No standalone instructions for this one — the full guidance
                                  lives in its Fix Recommendations card below.
                                </p>
                              )}
                              {finding.anchor && (
                                <a
                                  href={`#${finding.anchor}`}
                                  className="mt-1.5 inline-flex items-center gap-1 border-2 border-[#1a1a1a] bg-[#FDE68A] px-2.5 py-1 text-[11px] font-bold transition-colors hover:bg-[#FCD34D]"
                                >
                                  See the full recommendation →
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => setResult(null)}
                      className="border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#FDE68A]"
                    >
                      Diagnose again
                    </button>
                    <span className="text-[10px] text-[#1a1a1a]/30">
                      each run uses one of your {DIAGNOSIS_LIMIT_PER_HOUR} hourly diagnoses
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
