// Temporary: mock + import of the new agency module (probe).
import { test, mock } from "bun:test";

const real = await import("@convex-dev/auth/server");
let signedInAs: string | null = null;
mock.module("@convex-dev/auth/server", () => ({
  ...real,
  getAuthUserId: async () => signedInAs,
}));

await import("../src/convex/agency");

test("noop", () => {});
