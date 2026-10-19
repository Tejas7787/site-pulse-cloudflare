// SitePulse monitoring test harness.
// Real Convex handler: createMonitor (monitors.ts) against a local Convex
// core, so policy can be asserted on persisted state — no external API key,
// no website probe, no network. The resolver resolves the handlers; time
// helpers are explicit imports from the app modules; nothing here is a
// config file read.
// This file is a dev-only, file-system-based harness; it never connects to
// production Convex, sends email, or probes any host.

import { vitest } from "vitest";
import { beforeAll, afterAll } from "vitest";
import { EdgeVM } from "@edge-runtime/vm";

const consoleShim = {
  ...globalThis.console,
  log: globalThis.console.log.bind(globalThis.console),
};

const vm = new EdgeVM({ initialCode: "const console = globalThis.console;" });
Object.defineProperty(globalThis, "console", {
  value: consoleShim,
  writable: true,
  enumerable: false,
  configurable: true,
});

for (const [key, value] of Object.entries(vm.context)) {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

type VitestGlobals = {
  vitest: typeof vitest;
  beforeAll: typeof beforeAll;
  afterAll: typeof afterAll;
};

const globals = globalThis as VitestGlobals & typeof globalThis;

beforeAll(async () => {
  // Ensure the globals exist before any test file imports them.
  if (!globals.vitest) globals.vitest = vitest;
  if (!globals.beforeAll) globals.beforeAll = beforeAll;
  if (!globals.afterAll) globals.afterAll = afterAll;
});

afterAll(() => {
  vitest.restoreAllMocks();
});

globals.vitest = vitest;
globals.beforeAll = beforeAll;
globals.afterAll = afterAll;
