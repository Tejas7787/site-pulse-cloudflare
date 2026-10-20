"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { buildDiagnosis, type DoctorDiagnosis } from "../lib/aiDoctor";
import { buildFixProposals, type FixProposalResult } from "../lib/fixProposal";

/**
 * SitePulse AI Assistant — server-side action.
 *
 * Tries the VLY AI gateway first.  If the AI service is unavailable
 * or unauthorized, falls back to a deterministic scan-aware engine
 * that answers from the actual scan data only — no invented issues.
 *
 * askAssistant is quota-gated server-side (consumeAiQuota) BEFORE any paid
 * model call, because a paid call must never be reachable without a server
 * check in front of it. On denial it returns { quotaExceeded: true } with a
 * human-readable answer, so the chat UI can show the limit as a message.
 */

/* ── Deterministic fallback engine ───────────────────────────────────── */

interface ScanData {
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

function deterministicAnswer(question: string, data: ScanData): string {
  const q = question.toLowerCase();

  // ── "What should I fix first?" ──
  if (q.includes("fix first") || q.includes("what to fix") || q.includes("start with")) {
    const critical = data.issues.filter((i) => i.priority === "critical");
    const important = data.issues.filter((i) => i.priority === "important");
    const top = [...critical, ...important].slice(0, 3);

    if (top.length === 0) {
      return `Great news — your site scored ${data.score}/100 with no critical or high-priority issues. Review the "Nice to have" items in Fix Recommendations for minor improvements.`;
    }

    const lines = top.map(
      (issue, i) =>
        `${i + 1}. **${issue.message}** (${issue.category})\n   ${issue.howToFix}`,
    );

    return `Based on your ${data.score}/100 scan, start with these ${top.length} issues:\n\n${lines.join("\n\n")}\n\nFixing these first will have the biggest impact on your score. Check the Fix Recommendations section below for copy-paste code snippets.`;
  }

  // ── "Why is my score low?" ──
  if (q.includes("why") && (q.includes("score low") || q.includes("score is low") || q.includes("low score"))) {
    const failed = data.issues.filter(
      (i) => i.severity === "critical" || i.severity === "warning",
    );

    if (failed.length === 0) {
      return `Your score of ${data.score}/100 is actually ${data.score >= 80 ? "strong" : "decent"}. There are no critical failures in your scan. The remaining points come from minor recommendations — see the full issue list below.`;
    }

    const byCategory: Record<string, number> = {};
    failed.forEach((i) => {
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    });

    const categoryBreakdown = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `- ${cat}: ${count} issue${count > 1 ? "s" : ""}`)
      .join("\n");

    return `Your score is ${data.score}/100 (${data.grade}). The main reasons:\n\n${categoryBreakdown}\n\nThe ${Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] || "biggest issue"} category has the most room for improvement. Open Fix Recommendations below for the specific fixes.`;
  }

  // ── "How can I improve my Security score?" ──
  if (q.includes("security")) {
    const secIssues = data.issues.filter((i) => i.category === "Security");
    const secFailed = secIssues.filter(
      (i) => i.severity === "critical" || i.severity === "warning",
    );

    if (secFailed.length === 0) {
      return `Your Security score is ${data.securityScore}/100 — already strong. No critical security issues found. Check the recommendations below for any minor improvements.`;
    }

    const headerIssues = secFailed.filter((i) =>
      i.message.toLowerCase().includes("header"),
    );
    const otherIssues = secFailed.filter(
      (i) => !i.message.toLowerCase().includes("header"),
    );

    let answer = `Your Security score is ${data.securityScore}/100. The main issues:\n\n`;

    if (headerIssues.length > 0) {
      answer += `**Missing security headers (${headerIssues.length}):**\n`;
      headerIssues.forEach((i) => {
        answer += `- ${i.message}\n`;
      });
      answer += `\nAdd these headers through your server configuration. The Fix Recommendations section below has copy-paste code for each one.\n\n`;
    }

    if (otherIssues.length > 0) {
      answer += `**Other security issues:**\n`;
      otherIssues.forEach((i) => {
        answer += `- ${i.message}\n`;
      });
    }

    return answer;
  }

  // ── "How can I improve Performance?" ──
  if (q.includes("performance")) {
    const perfIssues = data.issues.filter(
      (i) => i.category === "Performance",
    );
    const perfFailed = perfIssues.filter(
      (i) => i.severity === "critical" || i.severity === "warning",
    );

    let answer = `Your Performance score is ${data.performanceScore}/100.\n\n`;

    if (perfFailed.length === 0) {
      answer += `No critical performance issues found. Your page loads efficiently.`;
    } else {
      answer += `Issues affecting performance:\n`;
      perfFailed.forEach((i) => {
        answer += `- ${i.message}\n`;
      });
      answer += `\nCheck the Fix Recommendations for specific optimization steps.`;
    }

    return answer;
  }

  // ── "Explain my biggest problem simply" ──
  if (q.includes("biggest problem") || q.includes("biggest issue") || q.includes("explain")) {
    const critical = data.issues.filter((i) => i.priority === "critical");
    const important = data.issues.filter((i) => i.priority === "important");
    const top = critical[0] || important[0];

    if (!top) {
      return `You don't have any critical or high-priority issues. Your site scored ${data.score}/100, which is ${data.score >= 80 ? "strong" : "a good start"}. The remaining items are minor improvements — see the full list below.`;
    }

    return `Your biggest issue is: **${top.message}** (${top.category})\n\nIn simple terms: ${top.whyItMatters}\n\nHow to fix it: ${top.howToFix}\n\nSee the Fix Recommendations section below for a copy-paste code snippet.`;
  }

  // ── "Give me the top 3 improvements" ──
  if (q.includes("top 3") || q.includes("top three") || q.includes("3 improvements")) {
    const sorted = [...data.issues]
      .filter((i) => i.priority !== "nice-to-have")
      .sort((a, b) => {
        const order = { critical: 0, important: 1, recommended: 2, "nice-to-have": 3 };
        return (order[a.priority as keyof typeof order] ?? 4) - (order[b.priority as keyof typeof order] ?? 4);
      })
      .slice(0, 3);

    if (sorted.length === 0) {
      return `No actionable improvements needed — your ${data.score}/100 score reflects a well-optimized site. Check the recommendations for minor polish items.`;
    }

    const lines = sorted.map(
      (issue, i) =>
        `${i + 1}. **${issue.message}** (${issue.category}, ${issue.priority})\n   Fix: ${issue.howToFix}`,
    );

    return `Here are the top 3 improvements for your ${data.score}/100 site:\n\n${lines.join("\n\n")}\n\nEach fix has detailed instructions in Fix Recommendations below.`;
  }

  // ── Generic fallback ──
  return `Based on your scan of ${data.url} (score: ${data.score}/100, grade ${data.grade}):\n\n- Performance: ${data.performanceScore}/100\n- SEO: ${data.seoScore}/100\n- Security: ${data.securityScore}/100\n- Accessibility: ${data.accessibilityScore}/100\n- Technical Health: ${data.technicalHealthScore}/100\n\n${data.totalFailed} checks failed, ${data.totalWarnings} have warnings, and ${data.totalPassed} passed.\n\nFor specific guidance, try asking:\n- "What should I fix first?"\n- "Why is my score low?"\n- "How can I improve my Security score?"\n- "Explain my biggest problem simply"\n- "Give me the top 3 improvements"`;
}

/* ── Main action ─────────────────────────────────────────────────────── */

export const askAssistant = action({
  args: {
    question: v.string(),
    scanData: v.string(), // JSON-stringified scan summary
    visitorId: v.optional(v.string()),
  },
  handler: async (ctx, { question, scanData, visitorId }): Promise<{
    answer: string;
    quotaExceeded?: boolean;
    retryAfterMs?: number;
    limit?: number;
  }> => {
    // 0. Server-side quota — consumed FIRST, before any parsing and, above
    //    all, before the paid model call below. Same rolling-window
    //    mechanism as the Website Doctor (internal.rateLimit.consumeAiQuota):
    //    the client cannot bypass it by calling the pure library. Identity is
    //    the CLIENT-supplied visitorId (anti-abuse only — see rateLimit.ts).
    const quota = await ctx.runMutation(internal.rateLimit.consumeAiQuota, {
      visitorId,
    });
    if (!quota.allowed) {
      const minutes = Math.max(1, Math.ceil(quota.retryAfterMs / 60_000));
      return {
        answer: `Question limit reached — SitePulse allows up to ${quota.limit} questions per visitor per hour. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        quotaExceeded: true,
        retryAfterMs: quota.retryAfterMs,
        limit: quota.limit,
      };
    }

    // Questions and payloads are capped before anything else happens: the
    // assistant is public, so an unbounded argument would be a free way to
    // push arbitrary amounts of text into a paid model call.
    const trimmedQuestion = question.trim().slice(0, 500);
    if (trimmedQuestion.length === 0) {
      return { answer: "Ask me about your scan — for example: \"What should I fix first?\"" };
    }
    if (scanData.length > 200_000) {
      return {
        answer:
          "The scan data for this report is too large to analyse. Please run a new scan and try again.",
      };
    }

    let parsed: ScanData;
    try {
      // scanData is expected to be a JSON string from the frontend.
      parsed = JSON.parse(scanData);
    } catch {
      // If it's not valid JSON, return a clear error.
      return {
        answer:
          "Unable to parse scan data. This usually means the scan results were not transferred correctly. Please run a new scan and try again.",
      };
    }

    // Validate that parsed data has the minimum required fields.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.score !== "number" ||
      typeof parsed.url !== "string"
    ) {
      return {
        answer:
          "The scan data appears incomplete (missing score or URL). Please run a new scan and try again.",
      };
    }

    // Try AI first
    try {
      const { vly } = await import("../lib/vly-integrations");

      const systemPrompt = `You are SitePulse AI Assistant. Answer based ONLY on the scan data provided. Never invent issues, scores, or vulnerabilities. Keep answers concise (2-4 short paragraphs). Reference specific scores. Direct users to Fix Recommendations for code snippets.`;

      const result = await vly.ai.completion({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Scan data:\n${scanData}\n\nQuestion: ${trimmedQuestion}` },
        ],
        temperature: 0.3,
        maxTokens: 500,
      });

      if (result.success && result.data?.choices?.[0]?.message?.content) {
        return { answer: result.data.choices[0].message.content };
      }
    } catch {
      // AI unavailable — fall through to deterministic engine
    }

    // Deterministic fallback — answers from real scan data only
    return { answer: deterministicAnswer(trimmedQuestion, parsed) };
  },
});

/* ── AI Website Doctor (Phase 3, V1) ───────────────────────────────────── */

/**
 * Explain a saved report's findings in plain language: what each top finding
 * means, the likely root cause, the honest impact and prioritized fixes.
 *
 * V1 is fallback-first and makes NO external model calls (paid AI calls stay
 * off until model credits are verified for this deployment):
 * - quota first: 10 diagnoses/hour/visitor, enforced server-side here —
 *   the client cannot bypass it by calling the pure library directly;
 * - the scan is fetched SERVER-SIDE by id, so the diagnosis always describes
 *   the stored document, never a client-supplied payload;
 * - the diagnosis itself comes from src/lib/aiDoctor.ts (deterministic,
 *   evidence-grounded), and the result is explicitly labelled
 *   aiStatus: "unavailable" so the UI can never claim AI analysis ran.
 *
 * V2: when credits are verified, attempt vly.ai.completion here — as an
 * ADDITION in front of (never instead of) buildDiagnosis, without changing
 * any number it computes.
 */
export const explainFindings = action({
  args: {
    scanId: v.id("scans"),
    visitorId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<
    | { kind: "quotaExceeded"; retryAfterMs: number; limit: number }
    | { kind: "notFound" }
    | {
        kind: "ok";
        diagnosis: DoctorDiagnosis;
        aiStatus: "unavailable";
        aiReason: string;
        remaining: number;
      }
  > => {
    // 1. Server-side quota — consumed before any work happens.
    const quota = await ctx.runMutation(internal.rateLimit.consumeAiQuota, {
      visitorId: args.visitorId,
    });
    if (!quota.allowed) {
      return { kind: "quotaExceeded", retryAfterMs: quota.retryAfterMs, limit: quota.limit };
    }

    // 2. Trusted input: the stored scan, fetched by id (never client JSON).
    const scan = await ctx.runQuery(api.scans.getScan, { id: args.scanId });
    if (!scan) return { kind: "notFound" };

    // 3. Deterministic, evidence-grounded diagnosis (no model call in V1).
    const diagnosis = buildDiagnosis(scan);
    return {
      kind: "ok",
      diagnosis,
      aiStatus: "unavailable",
      aiReason:
        "AI analysis did not run: model credits are not verified for this deployment. This diagnosis was produced by SitePulse's evidence-based rules engine using only this report's saved data.",
      remaining: quota.remaining,
    };
  },
});

/* ── Phase 4 V1 — deterministic local fix proposals ───────────────────── */

/**
 * Propose concrete, copy-paste fix snippets for a saved report's findings:
 * finding identity, target file, labeled proposed change, rationale and a
 * unified-diff preview of proposed additions.
 *
 * V1 makes NO external calls of any kind — no model, no GitHub, no network,
 * no file writes — and trusts no client-supplied finding JSON:
 * - quota first: proposals/hour/visitor, enforced server-side here (same
 *   rolling-window machinery as the Website Doctor);
 * - the scan is fetched SERVER-SIDE by id, so proposals always describe the
 *   stored document, never a client-supplied payload;
 * - proposals come from src/lib/fixProposal.ts (deterministic, evidence-
 *   grounded, reuse of the hosting-aware snippets the report already shows);
 * - every preview is honestly labeled a proposed snippet — SitePulse never
 *   read the site owner's files, so no verified before/after diff exists.
 *
 * Suggestions only: nothing is applied anywhere, and no score changes.
 */

export const proposeFixes = action({
  args: {
    scanId: v.id("scans"),
    visitorId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<
    | { kind: "quotaExceeded"; retryAfterMs: number; limit: number }
    | { kind: "notFound" }
    | { kind: "ok"; result: FixProposalResult; remaining: number }
  > => {
    // 1. Server-side quota — consumed before any work happens.
    const quota = await ctx.runMutation(internal.rateLimit.consumeProposalQuota, {
      visitorId: args.visitorId,
    });
    if (!quota.allowed) {
      return { kind: "quotaExceeded", retryAfterMs: quota.retryAfterMs, limit: quota.limit };
    }

    // 2. Trusted input: the stored scan, fetched by id (never client JSON).
    const scan = await ctx.runQuery(api.scans.getScan, { id: args.scanId });
    if (!scan) return { kind: "notFound" };

    // 3. Deterministic proposals from the saved document (no external calls).
    const result = buildFixProposals({
      url: scan.url,
      issues: scan.issues,
      serverInfo: scan.serverInfo,
    });
    return { kind: "ok", result, remaining: quota.remaining };
  },
});
