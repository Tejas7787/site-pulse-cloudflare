import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Send,
  Loader2,
  AlertCircle,
  Sparkles,
  ChevronDown,
} from "lucide-react";

/* ── Types ──────────────────────────────────────────────────────────── */

interface ScanSummary {
  url: string;
  score: number;
  grade: string;
  performanceScore: number;
  seoScore: number;
  securityScore: number;
  accessibilityScore: number;
  technicalHealthScore: number;
  issues: Array<{
    category: string;
    severity: string;
    priority: string;
    message: string;
    whyItMatters: string;
    howToFix: string;
  }>;
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  https: boolean;
  status: number;
  responseTime: number;
}

/* ── Suggested questions ────────────────────────────────────────────── */

const SUGGESTED_QUESTIONS = [
  "What should I fix first?",
  "Why is my score low?",
  "How can I improve my Security score?",
  "How can I improve Performance?",
  "Explain my biggest problem simply.",
  "Give me the top 3 improvements.",
];

/* ── Helpers ────────────────────────────────────────────────────────── */

function buildScanData(scan: ScanSummary): string {
  // Return a JSON string so the Convex action can JSON.parse() it once.
  return JSON.stringify({
    url: scan.url,
    score: scan.score,
    grade: scan.grade,
    performanceScore: scan.performanceScore,
    seoScore: scan.seoScore,
    securityScore: scan.securityScore,
    accessibilityScore: scan.accessibilityScore,
    technicalHealthScore: scan.technicalHealthScore,
    issues: scan.issues,
    totalPassed: scan.totalPassed,
    totalFailed: scan.totalFailed,
    totalWarnings: scan.totalWarnings,
    https: scan.https,
    status: scan.status,
    responseTime: scan.responseTime,
  });
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function AIAssistant({
  scan,
}: {
  scan: ScanSummary;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ q: string; a: string }>>([]);
  const [expanded, setExpanded] = useState(true);

  const askAssistant = useAction(api.aiAssistant.askAssistant);

  const handleAsk = async (q: string) => {
    if (!q.trim() || loading) return;

    const userQuestion = q.trim();
    setQuestion("");
    setLoading(true);
    setError(null);
    setAnswer(null);

    try {
      const scanData = buildScanData(scan);
      const result = await askAssistant({ question: userQuestion, scanData });

      const responseText =
        result.answer ||
        "I wasn't able to generate a response. Please check the Fix Recommendations section below.";

      setAnswer(responseText);
      setHistory((prev) => [...prev, { q: userQuestion, a: responseText }]);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "The AI assistant is temporarily unavailable.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAsk(question);
    }
  };

  return (
    <section className="border-b-2 border-[#1a1a1a] bg-white">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* Header — collapsible */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-between text-left"
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#E0E7FF]">
              <Bot className="size-5 text-indigo-600" strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-lg font-black">
                🤖 SitePulse AI Assistant
              </h2>
              <p className="text-xs text-[#1a1a1a]/50">
                Ask questions about your website health report.
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
              {/* Suggested questions — shown only when no answer yet */}
              {!answer && !loading && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-1.5">
                    <Sparkles className="size-3.5 text-[#1a1a1a]/30" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[#1a1a1a]/40">
                      Suggested questions
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        onClick={() => handleAsk(q)}
                        disabled={loading}
                        className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-3 py-1.5 text-xs font-bold text-[#1a1a1a] transition-colors hover:bg-[#FDE68A] disabled:opacity-50"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="mt-4 flex gap-0 border-2 border-[#1a1a1a] shadow-[3px_3px_0px_0px_#1a1a1a]">
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your scan results…"
                  disabled={loading}
                  className="flex-1 bg-white px-4 py-3 text-sm font-medium outline-none placeholder:text-[#1a1a1a]/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#FDE68A] disabled:opacity-50"
                  aria-label="Ask the AI assistant a question"
                />
                <button
                  onClick={() => handleAsk(question)}
                  disabled={loading || !question.trim()}
                  className="flex items-center gap-2 border-l-2 border-[#1a1a1a] bg-[#FDE68A] px-4 text-sm font-black transition-colors hover:bg-[#FCD34D] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Send question"
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Ask
                </button>
              </div>

              {/* Loading */}
              <AnimatePresence>
                {loading && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-4 flex items-center gap-3 border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3"
                  >
                    <Loader2 className="size-5 animate-spin text-indigo-600" />
                    <div>
                      <p className="text-sm font-bold text-[#1a1a1a]">
                        Analyzing your scan data…
                      </p>
                      <p className="text-[11px] text-[#1a1a1a]/40">
                        Based on your {scan.score}/100 health report
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Error */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 flex items-start gap-3 border-2 border-red-300 bg-red-50 px-4 py-3"
                >
                  <AlertCircle className="size-4 mt-0.5 shrink-0 text-red-600" />
                  <div>
                    <p className="text-sm font-bold text-red-700">
                      Unable to generate response
                    </p>
                    <p className="mt-0.5 text-xs text-red-600/70">{error}</p>
                    <p className="mt-1 text-xs text-[#1a1a1a]/40">
                      Check the Fix Recommendations section below for detailed
                      guidance.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Answer */}
              <AnimatePresence>
                {answer && !loading && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4"
                  >
                    <div className="border-2 border-[#1a1a1a] bg-[#FFFBF0] px-4 py-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Bot className="size-4 text-indigo-600" />
                        <span className="text-xs font-bold text-[#1a1a1a]/60">
                          SitePulse AI Assistant
                        </span>
                        <span className="border border-[#1a1a1a]/15 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1a1a1a]/30">
                          AI-generated
                        </span>
                      </div>
                      <div className="prose-sm whitespace-pre-wrap text-sm leading-relaxed text-[#1a1a1a]/80">
                        {answer}
                      </div>
                    </div>

                    {/* Ask another */}
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => {
                          setAnswer(null);
                          setError(null);
                        }}
                        className="border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-xs font-bold transition-colors hover:bg-[#FDE68A]"
                      >
                        Ask another question
                      </button>
                      <span className="text-[10px] text-[#1a1a1a]/30">
                        or type below
                      </span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Conversation history (compact) */}
              {history.length > 1 && (
                <div className="mt-4 border-t-2 border-[#1a1a1a]/10 pt-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-[#1a1a1a]/30">
                    Previous questions
                  </span>
                  <div className="mt-2 space-y-1.5">
                    {history
                      .slice(0, -1)
                      .reverse()
                      .map((h, i) => (
                        <div
                          key={i}
                          className="border border-[#1a1a1a]/10 bg-[#FFFBF0]/50 px-3 py-2"
                        >
                          <p className="text-xs font-bold text-[#1a1a1a]/60">
                            Q: {h.q}
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-[11px] text-[#1a1a1a]/40">
                            A: {h.a}
                          </p>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
