import { describe, expect, test } from "vitest";

describe("isolation", () => {
  test("node environment works", () => {
    expect(process.version).toBeTruthy();
  });
});
