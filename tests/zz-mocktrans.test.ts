// Temporary: mock.module + transitive import probe (mimics convexAuthz shape).
import { test, mock } from "bun:test";

const real = await import("@convex-dev/auth/server");
let signedInAs: string | null = "users|iX";
mock.module("@convex-dev/auth/server", () => ({
  ...real,
  getAuthUserId: async () => signedInAs,
}));

// Import a real Convex module that depends on the mocked one, like convexAuthz does.
await import("../src/convex/monitors");

test("noop", () => {});
