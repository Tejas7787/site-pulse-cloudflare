// Rate-limit tests — the rolling window that keeps the free scanner from being
// used as a request cannon against other people's websites.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  consumeQuota,
  RATE_LIMIT_MAX_AGE_MS,
  SCAN_LIMIT,
  SCAN_WINDOW_MS,
} from "../src/convex/rateLimit";

type Row = { _id: string; key: string; windowStart: number; count: number };

/** Minimal in-memory stand-in for a Convex MutationCtx over `rateLimits`. */
function fakeCtx(rows: Row[] = [], options: { fail?: boolean } = {}) {
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
          lt: (field: string, value: unknown) => {
            recorded.op = "lt";
            recorded.value = value;
            void field;
            return q;
          },
        };
        selector(q);
        const matches = store.filter((row) =>
          recorded.op === "eq" ? row.key === recorded.value : row.windowStart < (recorded.value as number),
        );
        return {
          first: async () => matches[0] ?? null,
          take: async (n: number) => matches.slice(0, n),
        };
      },
    }),
    insert: async (_table: string, doc: Omit<Row, "_id">) => {
      if (options.fail) throw new Error("storage unavailable");
      const row: Row = { _id: `row${nextId++}`, ...doc };
      store.push(row);
      return row._id;
    },
    patch: async (id: string, patch: Partial<Row>) => {
      if (options.fail) throw new Error("storage unavailable");
      const row = store.find((r) => r._id === id);
      if (row) Object.assign(row, patch);
    },
    delete: async (id: string) => {
      const index = store.findIndex((r) => r._id === id);
      if (index >= 0) store.splice(index, 1);
    },
  };
  return { ctx: { db } as never, store };
}

describe("scan quota", () => {
  test("first request is allowed and consumes one unit", async () => {
    const { ctx, store } = fakeCtx();
    const result = await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 1000, now: 0 });
    expect(result).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
    expect(store).toHaveLength(1);
    expect(store[0].count).toBe(1);
  });

  test("the window fills up, then denies with the time left until reset", async () => {
    const { ctx } = fakeCtx();
    for (let i = 0; i < 3; i++) {
      const r = await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 1_000 });
      expect(r.allowed).toBe(true);
    }
    const denied = await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 10_000 });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(1_000 + 60_000 - 10_000);
  });

  test("an expired window resets in place instead of growing a second row", async () => {
    const { ctx, store } = fakeCtx();
    for (let i = 0; i < 3; i++) {
      await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 0 });
    }
    const afterReset = await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 60_000 });
    expect(afterReset.allowed).toBe(true);
    expect(store).toHaveLength(1);
    expect(store[0].count).toBe(1);
    expect(store[0].windowStart).toBe(60_000);
  });

  test("separate keys do not share a window", async () => {
    const { ctx } = fakeCtx();
    for (let i = 0; i < 3; i++) {
      await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 0 });
    }
    const other = await consumeQuota(ctx, { key: "scan:b", limit: 3, windowMs: 60_000, now: 0 });
    expect(other.allowed).toBe(true);
  });

  test("a broken counter fails open instead of breaking every scan", async () => {
    const { ctx } = fakeCtx([], { fail: true });
    const result = await consumeQuota(ctx, { key: "scan:a", limit: 3, windowMs: 60_000, now: 0 });
    expect(result.allowed).toBe(true);
  });

  test("the shipped limits are sane", () => {
    expect(SCAN_LIMIT).toBe(20);
    expect(SCAN_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(RATE_LIMIT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    // Stale keys must outlive the window they belong to.
    expect(RATE_LIMIT_MAX_AGE_MS).toBeGreaterThan(SCAN_WINDOW_MS);
  });
});

describe("scan quota wiring", () => {
  const rateLimit = readFileSync(
    join(import.meta.dir, "..", "src", "convex", "rateLimit.ts"),
    "utf8",
  );
  const scan = readFileSync(join(import.meta.dir, "..", "src", "convex", "scan.ts"), "utf8");
  const crons = readFileSync(join(import.meta.dir, "..", "src", "convex", "crons.ts"), "utf8");
  const legal = readFileSync(join(import.meta.dir, "..", "src", "pages", "Legal.tsx"), "utf8");
  const landing = readFileSync(join(import.meta.dir, "..", "src", "pages", "Landing.tsx"), "utf8");

  test("the quota endpoints are internal-only and count through one index", () => {
    expect(rateLimit).toContain("internalMutation");
    expect(rateLimit).toContain('withIndex("by_key"');
    expect(rateLimit).not.toContain("export const consumeQuota = mutation");
  });

  test("the scan action checks the quota before it touches the target site", () => {
    // The quota check must appear before the controlled fetch.
    const quotaAt = scan.indexOf("consumeScanQuota");
    const fetchAt = scan.indexOf("fetchTarget(");
    expect(quotaAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(quotaAt);
    // And a denied visitor gets a clear, actionable error rather than a scan.
    expect(scan).toContain("You've reached the scan limit");
  });

  test("the landing page sends the visitor id that keys the quota", () => {
    expect(landing).toContain("visitorId: getVisitorId()");
  });

  test("stale counters are swept and the public copy states the limit", () => {
    expect(crons).toContain("internal.rateLimit.cleanup");
    expect(legal).toContain("20 scans per hour");
  });
});
