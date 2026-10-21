// B2 — paid AI spend guard: tests that a PAID vly.ai.completion cannot
// proceed when the deployment-wide safeguard is exhausted, unavailable, or
// switched off — and that NO caller-controlled input (least of all the
// client-supplied visitorId quotas) can reset it.
//
// The paid call site is proven with a module spy: askAssistant dynamically
// imports ../lib/vly-integrations immediately before completion, so the mock
// records every attempt while keeping the suite offline — no key, no gateway,
// no spend. Everything else (quota ordering, deterministic fallback, shared
// OTP key) is pinned against the real handlers and sources.

import { describe, expect, test, mock } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { convexTest } from "convex-test";
import { api } from "../src/convex/_generated/api";
import schema from "../src/convex/schema";
import {
  PAID_AI_DAILY_LIMIT,
  consumePaidAiBudget,
  paidAiBudgetKey,
} from "../src/convex/rateLimit";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

/* ── Spy on the ONLY paid call site in the codebase (aiAssistant.ts:271) ────── */

type CompletionArgs = { model: string; messages: Array<{ role: string; content: string }> };
const paidCalls: CompletionArgs[] = [];
let paidResult: {
  success: boolean;
  data?: { choices?: Array<{ message?: { content?: string } }> };
} = { success: false };

mock.module("../src/lib/vly-integrations", () => ({
  vly: {
    ai: {
      completion: async (args: CompletionArgs) => {
        paidCalls.push(args);
        return paidResult;
      },
    },
  },
}));

// convex-test loads Convex modules on demand from this map (keys relative to
// src/convex with the extension kept; values are lazy importers).
const modules = {
  "_generated/api.js": () => import("../src/convex/_generated/api.js"),
  "_generated/server.js": () => import("../src/convex/_generated/server.js"),
  "aiAssistant.ts": () => import("../src/convex/aiAssistant.ts"),
  "scans.ts": () => import("../src/convex/scans.ts"),
  "rateLimit.ts": () => import("../src/convex/rateLimit.ts"),
};

const freshBackend = () => convexTest(schema, modules);

/** Valid, complete scan payload (what AIAssistant's buildScanData produces). */
const scanData = JSON.stringify({
  url: "https://example.com/",
  score: 60,
  grade: "D",
  performanceScore: 70,
  seoScore: 60,
  securityScore: 40,
  accessibilityScore: 80,
  technicalHealthScore: 65,
  issues: [],
  totalPassed: 6,
  totalFailed: 2,
  totalWarnings: 2,
  https: true,
  status: 200,
  responseTime: 120,
});

const ask = (t: ReturnType<typeof freshBackend>, visitorId: string) =>
  t.action(api.aiAssistant.askAssistant, {
    question: "What should I fix first?",
    scanData,
    visitorId,
  });

/** Exhaust today's deployment budget straight through the real schema. */
async function exhaustBudget(t: ReturnType<typeof freshBackend>): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("rateLimits", {
      key: paidAiBudgetKey(Date.now()),
      windowStart: Date.now(),
      count: PAID_AI_DAILY_LIMIT,
    }),
  );
}

const budgetRows = (t: ReturnType<typeof freshBackend>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("rateLimits").collect()).filter((r) => r.key.startsWith("ai-paid:")),
  );

/* ── Real handler: paid path must stay shut ────────────────────────────────── */

describe("askAssistant — the spend budget blocks paid calls at runtime", () => {
  test("an exhausted budget means NO paid call; the deterministic engine answers", async () => {
    const t = freshBackend();
    await exhaustBudget(t);
    paidCalls.length = 0;

    const res = await ask(t, "visitor-1");

    expect(paidCalls).toHaveLength(0);
    // Not a visitor-quota refusal — the visitor's own quota is untouched by this gate.
    expect(res.quotaExceeded).toBeUndefined();
    // Deterministic engine answered from the scan data (offline, unbilled).
    expect(res.answer).toContain("Great news — your site scored 60/100");
  });

  test("rotating visitorId does NOT reset the budget", async () => {
    const t = freshBackend();
    await exhaustBudget(t);
    paidCalls.length = 0;

    for (let i = 0; i < 5; i++) {
      const res = await ask(t, `visitor-rotating-${i}`);
      // Each fresh visitor has a full per-visitor quota — and still no paid call.
      expect(res.quotaExceeded).toBeUndefined();
      expect(paidCalls).toHaveLength(0);
    }
  });

  test("control: with budget available the paid path is attempted exactly once and the budget is consumed", async () => {
    const t = freshBackend();
    paidCalls.length = 0;
    paidResult = { success: true, data: { choices: [{ message: { content: "PAID-ANSWER" } }] } };
    try {
      const res = await ask(t, "control-visitor");
      expect(paidCalls).toHaveLength(1);
      expect(res.answer).toBe("PAID-ANSWER");
      // The gate is what spent: one unit of the UTC-day budget, server-side.
      const rows = await budgetRows(t);
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(1);
    } finally {
      paidResult = { success: false };
    }
  });

  test("the ops kill switch skips the paid path entirely — no budget consumed, key untouched", async () => {
    const t = freshBackend();
    paidCalls.length = 0;
    process.env.VLY_AI_PAID_DISABLED = "true";
    try {
      const res = await ask(t, "switch-visitor");
      expect(paidCalls).toHaveLength(0);
      expect(res.answer).toContain("Great news — your site scored 60/100");
      expect(await budgetRows(t)).toHaveLength(0);
    } finally {
      delete process.env.VLY_AI_PAID_DISABLED;
    }
  });
});

/* ── The safeguard itself: exhausted / unavailable / key purity ────────────── */

type Row = { _id: string; key: string; windowStart: number; count: number };

/** Minimal in-memory Convex MutationCtx over `rateLimits` (same seam as rateLimit.test). */
function fakeCtx(rows: Row[] = []) {
  let nextId = 1;
  const store = rows;
  const db = {
    query: () => ({
      withIndex: (_name: string, selector: (q: unknown) => unknown) => {
        const recorded: { op?: string; value?: unknown } = {};
        const q = {
          eq: (field: string, value: unknown) => {
            recorded.op = "eq";
            recorded.value = value;
            void field;
            return q;
          },
        };
        selector(q);
        const matches = store.filter((row) => recorded.op === "eq" && row.key === recorded.value);
        return { first: async () => matches[0] ?? null };
      },
    }),
    insert: async (_table: string, doc: Omit<Row, "_id">) => {
      const row: Row = { _id: `row${nextId++}`, ...doc };
      store.push(row);
      return row._id;
    },
    patch: async (id: string, patch: Partial<Row>) => {
      const row = store.find((r) => r._id === id);
      if (row) Object.assign(row, patch);
    },
  };
  return { ctx: { db } as never, store };
}

describe("consumePaidAiBudget — unit behaviour", () => {
  test("healthy counter: consumes, refuses at the limit, resets at the next UTC day", async () => {
    const { ctx, store } = fakeCtx();
    const now = Date.UTC(2026, 9, 21, 10, 0); // 2026-10-21T10:00Z
    const limit = 2;

    const first = await consumePaidAiBudget(ctx, { now, limit });
    expect(first).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0, limit });
    const second = await consumePaidAiBudget(ctx, { now, limit });
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    const denied = await consumePaidAiBudget(ctx, { now, limit });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.unavailable).toBeUndefined();
    // Denied until the next UTC midnight — a date change, not a caller change.
    expect(denied.retryAfterMs).toBe(Date.UTC(2026, 9, 22) - now);
    expect(store).toHaveLength(1);

    const tomorrow = await consumePaidAiBudget(ctx, { now: Date.UTC(2026, 9, 22, 0, 1), limit });
    expect(tomorrow.allowed).toBe(true);
    expect(store).toHaveLength(2);
    expect(store[1].key).toBe("ai-paid:2026-10-22");
  });

  test("UNAVAILABLE storage fails CLOSED — a broken counter never authorizes a paid call", async () => {
    // The read itself throws (counter table unreadable).
    const queryBroken = {
      db: {
        query: () => ({
          withIndex: () => ({
            first: async () => {
              throw new Error("storage unavailable");
            },
          }),
        }),
        insert: async () => {
          throw new Error("storage unavailable");
        },
        patch: async () => {
          throw new Error("storage unavailable");
        },
      },
    } as never;

    const readDenied = await consumePaidAiBudget(queryBroken);
    expect(readDenied.allowed).toBe(false);
    expect(readDenied.unavailable).toBe(true);
    expect(readDenied.limit).toBe(PAID_AI_DAILY_LIMIT);

    // Reads work but the write fails (counter unusable for the next caller).
    const writeBroken = {
      db: {
        query: () => ({ withIndex: () => ({ first: async () => null }) }),
        insert: async () => {
          throw new Error("storage unavailable");
        },
        patch: async () => {
          throw new Error("storage unavailable");
        },
      },
    } as never;

    const writeDenied = await consumePaidAiBudget(writeBroken);
    expect(writeDenied.allowed).toBe(false);
    expect(writeDenied.unavailable).toBe(true);
  });

  test("the shipped limit is a real cap, not a placeholder", () => {
    expect(PAID_AI_DAILY_LIMIT).toBe(100);
    expect(PAID_AI_DAILY_LIMIT).toBeGreaterThan(0);
  });

  test("the budget key has no caller-controlled component", () => {
    // Same day, any hour → same key; only the DATE changes the key.
    expect(paidAiBudgetKey(Date.UTC(2026, 9, 21, 0, 0))).toBe("ai-paid:2026-10-21");
    expect(paidAiBudgetKey(Date.UTC(2026, 9, 21, 23, 59))).toBe("ai-paid:2026-10-21");
    expect(paidAiBudgetKey(Date.UTC(2026, 9, 22, 0, 0))).toBe("ai-paid:2026-10-22");
    // Exactly one parameter (`now`) — there is no visitor id to rotate.
    expect(paidAiBudgetKey.length).toBe(1);
  });
});

/* ── Source pins: ordering a runtime test cannot observe, and key safety ───── */

describe("wiring — gate ordering, non-paid features, shared OTP key", () => {
  const src = read("src/convex/aiAssistant.ts");

  test("spend budget is consumed between the visitor quota and vly.ai.completion", () => {
    const start = src.indexOf("export const askAssistant");
    const end = src.indexOf("export const explainFindings");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);

    const visitorQuota = block.indexOf("internal.rateLimit.consumeAiQuota");
    const spendBudget = block.indexOf("internal.rateLimit.consumePaidAiQuota");
    const paidCall = block.indexOf("vly.ai.completion");
    expect(visitorQuota).toBeGreaterThan(-1);
    expect(spendBudget).toBeGreaterThan(visitorQuota);
    expect(paidCall).toBeGreaterThan(spendBudget);

    // Fail-closed structure and the ops kill switch are both present.
    expect(block).toContain("VLY_AI_PAID_DISABLED");
    expect(block).toContain("paidAllowed = false");
    expect(block).toContain("fail closed");
    // The paid attempt is conditional, never unconditional.
    expect(block).toContain("if (paidAllowed) {");
  });

  test("Website Doctor and Repair Agent never reach the paid call site", () => {
    const doctorStart = src.indexOf("export const explainFindings");
    const fixesStart = src.indexOf("export const proposeFixes");
    const doctor = src.slice(doctorStart, fixesStart);
    const fixes = src.slice(fixesStart);
    expect(doctor).not.toContain("vly.ai.completion");
    expect(fixes).not.toContain("vly.ai.completion");
    expect(doctor).toContain("buildDiagnosis");
    expect(fixes).toContain("buildFixProposals");
  });

  test("the shared integration key is untouched — email sign-in still depends on it", () => {
    // The fix is a code-side gate, not a removed/renamed key: OTP auth keeps
    // working with VLY_INTEGRATION_KEY set, and the spend guard is independent.
    const otp = read("src/convex/auth/emailOtp.ts");
    expect(otp).toContain("VLY_INTEGRATION_KEY");
    expect(src).toContain("VLY_AI_PAID_DISABLED");
    // And the budget module itself never reads or exposes any secret.
    const rateLimit = read("src/convex/rateLimit.ts");
    expect(rateLimit).not.toContain("VLY_INTEGRATION_KEY");
    expect(rateLimit).toContain("FAIL CLOSED");
  });
});
