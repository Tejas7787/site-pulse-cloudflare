// Temporary: minimal mock.module leak probe.
import { test, mock } from "bun:test";

const real = await import("@convex-dev/auth/server");
let signedInAs: string | null = "users|i1";
mock.module("@convex-dev/auth/server", () => ({
  ...real,
  getAuthUserId: async () => signedInAs,
}));

test("noop", () => {});
