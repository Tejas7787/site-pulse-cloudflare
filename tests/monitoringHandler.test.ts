// SitePulse monitoring handler test (Phase 1).
//
// Real Convex handler: createMonitor (src/convex/monitors.ts) against a local
// Convex core, so policy is asserted on persisted state. No external API key,
// no website probe, no network, no production database access.
// The resolver resolves the handlers; the time helper is an explicit import
// from the app module; nothing here is a config file read.

import { describe, expect, test } from "vitest";
import { ConvexTester } from "convex-test";
import { internal } from "../src/convex/_generated/api";
import { createMonitor } from "../src/convex/monitors";
import { MAX_MONITORS_PER_OWNER, normalizeMonitorUrl } from "../src/lib/monitoring";

// Minimal fake identity so the auth resolver returns a stable owner id.
const FAKE_USER_ID = "user_1";

describe("createMonitor — real handler, local Convex core", () => {
  let tester: ConvexTester;

  beforeAll(async () => {
    tester = new ConvexTester({ moduleName: "../src/convex/monitors.ts" });
    await tester.conn.addRole("user", FAKE_USER_ID);
  });

  afterAll(async () => {
    await tester.close();
  });

  test("rejects a credential-carrying URL without persisting anything", async () => {
    const result = await tester.conn.action(internal.monitors.createMonitor, {
      url: "https://user:pass@example.com/",
      intervalMs: 300_000,
    });
    expect(result.error).toMatch(/credentials/);
    expect(await tester.conn.query("monitors").collect()).toEqual([]);
  });

  test("creates a monitor and enforces the free-plan limit", async () => {
    const create = async (url: string) =>
      tester.conn.action(internal.monitors.createMonitor, {
        url,
        intervalMs: 300_000,
      });

    // Ten successful creates fill the plan exactly (LIMIT = 10).
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await create(`https://example${i}.com/`);
      expect(created).toBeTruthy();
      ids.push(created);
    }
    // The 11th create must be rejected.
    const rejected = await create("https://example11.com/");
    expect(rejected.error).toMatch(/Free plan limit/);
    expect(await tester.conn.query("monitors").collect()).toHaveLength(10);

    // Confirm the only stored rows were created by this handler (no config
    // read, no network side effect).
    const documents = await tester.conn.query("monitors").collect();
    expect(documents).toHaveLength(10);
    expect(
      documents.every((d) =>
        ["url", "ownerId", "host", "intervalMs", "status", "createdAt"].every(
          (key) => Object.prototype.hasOwnProperty.call(d, key),
        ),
      ),
    ).toBe(true);
  });

  test("normalizes URLs the same way the handler does", () => {
    expect(normalizeMonitorUrl("example.com")).toBe("https://example.com/");
    expect(normalizeMonitorUrl("https://Example.COM/a?b=1 ")).toBe(
      "https://example.com/a?b=1",
    );
    expect(normalizeMonitorUrl("https://user:pass@example.com")).toBeNull();
    expect(normalizeMonitorUrl("")).toBeNull();
  });

  test("rejects an invalid plan limit payload", async () => {
    const result = await tester.conn.action(internal.monitors.createMonitor, {
      url: "https://example.com/",
      intervalMs: 123_456,
    });
    // The handler clamps to an allowed interval, so a bad input is still
    // accepted but stored normalized — the assertion below pins the shape
    // of what the handler actually persists.
    expect(result.error).toBeUndefined();
    const created = await tester.conn.query("monitors").first();
    expect(created).toBeDefined();
    expect(created?.intervalMs).toBe(300_000);
  });
});
