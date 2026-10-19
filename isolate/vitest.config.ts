import { defineProject } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { vlyPlugin } from "@vly-ai/integrations";

export default defineProject({
  plugins: [react(), vlyPlugin(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "..", "src") },
  },
  test: {
    environment: "jsdom",
    include: ["isolate/**/*.test.ts"],
    globals: true,
    setupFiles: ["./isolate/test.setup.ts"],
  },
});
