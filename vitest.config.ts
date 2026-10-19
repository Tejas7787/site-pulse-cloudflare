import { defineProject } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { vlyPlugin } from "@vly-ai/integrations";

// Vitest runs ONLY the dedicated Convex handler integration tests, which use
// the real convex-test backend. Every other file under tests/ is written for
// `bun test` (they import "bun:test", which Vitest cannot resolve), so the
// project's primary test command remains `bun test`.
export default defineProject({
  plugins: [react(), vlyPlugin(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: [
      "tests/monitoringHandler.test.ts",
      "tests/monitoringEnqueue.test.ts",
    ],
  },
});
