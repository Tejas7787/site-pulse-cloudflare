import { useState } from "react";
import { useMutation } from "convex/react";
import { X, Star, MessageSquare } from "lucide-react";
import { api } from "../convex/_generated/api";

const QUESTIONS = [
  {
    field: "thought" as const,
    label: "What did you think of SitePulse?",
    placeholder: "Your impressions — anything you liked or disliked…",
  },
  {
    field: "improve" as const,
    label: "What should we improve?",
    placeholder: "Anything that felt confusing, slow, or missing…",
  },
  {
    field: "featureRequest" as const,
    label: "What feature would you like next?",
    placeholder: "e.g. PDF reports, competitor comparison…",
  },
  {
    field: "problem" as const,
    label: "Did you find any problem?",
    placeholder: "Bugs, broken scans, wrong results — tell us what happened…",
  },
];

export default function FeedbackModal({ onClose }: { onClose: () => void }) {
  const submitFeedback = useMutation(api.feedback.submit);
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const setField = (field: string, value: string) =>
    setFields((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1 || state === "submitting") return; // prevent duplicate submits
    setState("submitting");
    setError(null);
    try {
      await submitFeedback({
        rating,
        thought: fields.thought || undefined,
        improve: fields.improve || undefined,
        featureRequest: fields.featureRequest || undefined,
        problem: fields.problem || undefined,
        email: email.trim() || undefined,
        path: window.location.pathname,
      });
      setState("done");
    } catch {
      setState("idle");
      setError("Something went wrong while sending your feedback. Please try again.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#1a1a1a]/60 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto border-2 border-[#1a1a1a] bg-[#FFFBF0] shadow-[8px_8px_0px_0px_#1a1a1a]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b-2 border-[#1a1a1a] bg-[#FDE68A] px-5 py-3">
          <h2 id="feedback-title" className="flex items-center gap-2 text-base font-black">
            <MessageSquare className="size-4" aria-hidden="true" />Give Feedback
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close feedback form"
            className="border-2 border-[#1a1a1a] bg-white p-1 shadow-[2px_2px_0px_0px_#1a1a1a] transition-all hover:bg-red-100"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {state === "done" ? (
          <div className="px-5 py-10 text-center">
            <p className="text-lg font-black">Thanks! Your feedback helps us improve SitePulse 🚀</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-2.5 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5 px-5 py-5">
            {/* Rating */}
            <fieldset>
              <legend className="mb-2 text-sm font-bold">Rating *</legend>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`${n} star${n > 1 ? "s" : ""}`}
                    onMouseEnter={() => setHovered(n)}
                    onMouseLeave={() => setHovered(0)}
                    onClick={() => setRating(n)}
                    className="p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1a1a1a]"
                  >
                    <Star
                      className={`size-7 transition-colors ${
                        n <= (hovered || rating)
                          ? "fill-[#FBBF24] text-[#1a1a1a]"
                          : "text-[#1a1a1a]/30"
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                ))}
                <span className="ml-2 text-sm font-bold text-[#1a1a1a]/60" aria-live="polite">
                  {rating > 0 ? `${rating}/5` : ""}
                </span>
              </div>
              {rating === 0 && (
                <p className="mt-1 text-xs font-medium text-[#1a1a1a]/50">Please choose a rating.</p>
              )}
            </fieldset>

            {/* Optional questions */}
            {QUESTIONS.map((q) => (
              <div key={q.field}>
                <label htmlFor={`fb-${q.field}`} className="mb-1 block text-sm font-bold">
                  {q.label}{" "}
                  <span className="font-medium text-[#1a1a1a]/40">(optional)</span>
                </label>
                <textarea
                  id={`fb-${q.field}`}
                  rows={2}
                  maxLength={2000}
                  value={fields[q.field] ?? ""}
                  onChange={(e) => setField(q.field, e.target.value)}
                  placeholder={q.placeholder}
                  className="w-full resize-y border-2 border-[#1a1a1a] bg-white px-3 py-2 text-sm placeholder:text-[#1a1a1a]/35 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#1a1a1a]"
                />
              </div>
            ))}

            {/* Optional email */}
            <div>
              <label htmlFor="fb-email" className="mb-1 block text-sm font-bold">
                Email{" "}
                <span className="font-normal text-[#1a1a1a]/40">(optional — only if you'd like a reply)</span>
              </label>
              <input
                id="fb-email"
                type="email"
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full border-2 border-[#1a1a1a] bg-white px-3 py-2 text-sm placeholder:text-[#1a1a1a]/35 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#1a1a1a]"
              />
            </div>

            {error && (
              <p role="alert" className="border-2 border-[#1a1a1a] bg-red-100 px-3 py-2 text-sm font-bold">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={rating < 1 || state === "submitting"}
              className="w-full border-2 border-[#1a1a1a] bg-[#FDE68A] px-4 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all enabled:hover:bg-[#FCD34D] enabled:hover:shadow-[1px_1px_0px_0px_#1a1a1a] enabled:hover:translate-x-[2px] enabled:hover:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state === "submitting" ? "Sending…" : "Submit Feedback"}
            </button>
            <p className="text-center text-xs font-medium text-[#1a1a1a]/45">
              Everything except the rating is optional. No account needed.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
