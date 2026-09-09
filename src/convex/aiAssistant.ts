"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";

/**
 * SitePulse AI Assistant — server-side action.
 *
 * Tries the VLY AI gateway first.  If the AI service is unavailable
 * or unauthorized, falls back to a deterministic scan-aware engine
 * that answers from the actual scan data only — no invented issues.
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
  if (q.includes("fix first") || q.includes("fix first") || q.includes("start with")) {
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
  },
  handler: async (_ctx, { question, scanData }) => {
    let parsed: ScanData;
    try {
      parsed = JSON.parse(scanData);
    } catch {
      return { answer: "Unable to parse scan data. Please try scanning again." };
    }

    // Try AI first
    try {
      const { vly } = await import("../lib/vly-integrations");

      const systemPrompt = `You are SitePulse AI Assistant. Answer based ONLY on the scan data provided. Never invent issues, scores, or vulnerabilities. Keep answers concise (2-4 short paragraphs). Reference specific scores. Direct users to Fix Recommendations for code snippets.`;

      const result = await vly.ai.completion({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Scan data:\n${scanData}\n\nQuestion: ${question}` },
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
    return { answer: deterministicAnswer(question, parsed) };
  },
});
