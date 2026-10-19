import { beforeAll, afterAll, vi } from "vitest";
import { EdgeVM } from "@edge-runtime/vm";

beforeAll(async () => {
  const vm = new EdgeVM({ initialCode: "const console = globalThis.console;" });
  for (const [key, value] of Object.entries(vm.context)) {
    if (key in globalThis === false || globalThis[key] !== value) {
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});
