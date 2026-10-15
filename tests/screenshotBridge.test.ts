// Freebuff preview screenshot bridge — local-loading contract (audit fix, Issue 2).
//
// The platform's @vly-ai/integrations bridge (injected into this page by
// vlyPlugin in vite.config.ts) would otherwise inject
//   https://cdn.jsdelivr.net/npm/html2canvas-pro@2.0.4/dist/html2canvas-pro.min.js
// at runtime, which this app's script-src ('self' …) correctly blocks.
//
// The fix loads a byte-identical, sha256-pinned copy from public/vendor as a
// classic script BEFORE the deferred module graph runs. The bridge's loader
// checks window.html2canvas first and then never requests the CDN.
//
// These tests pin that contract:
//   - the vendored artifact is present and exactly the expected bytes
//   - index.html loads it from 'self' as a classic script (no module/async/defer),
//     positioned before the app module entry so the global exists before any
//     module (including the platform's head-injected bridge) evaluates
//   - no script/link URL on the page points at jsDelivr

import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const VENDOR_REL = "public/vendor/html2canvas-pro-2.0.4.min.js";
const VENDOR_URL = "/vendor/html2canvas-pro-2.0.4.min.js";
// sha256 of npm html2canvas-pro@2.0.4 dist/html2canvas-pro.min.js
// (npm dist.integrity sha512-tfL8XNvu… verified at vendoring time; byte-identical to
// the file the platform would have loaded from cdn.jsdelivr.net).
const VENDOR_SHA256 =
  "7beb420cd95e8c7ceab73aef50b77afde9b9309717506ee0dc41b63e83d931e2";
const VENDOR_BYTES = 227298;

const indexHtml = read("index.html");

describe("vendored screenshot library", () => {
  test("the pinned html2canvas-pro 2.0.4 artifact is present under public/vendor", () => {
    const buf = readFileSync(join(import.meta.dir, "..", VENDOR_REL));
    expect(buf.byteLength).toBe(VENDOR_BYTES);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(VENDOR_SHA256);
  });

  test("the vendored file keeps its upstream MIT license header", () => {
    const head = read(VENDOR_REL).slice(0, 200);
    expect(head).toContain("html2canvas-pro 2.0.4");
    expect(head).toContain("MIT License");
  });
});

describe("index.html loading contract", () => {
  test("exactly one classic script tag loads the vendor copy (no type=module/async/defer)", () => {
    const tags = indexHtml.match(/<script[^>]*html2canvas-pro[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    const tag = tags[0];
    expect(tag).toContain(`src="${VENDOR_URL}"`);
    expect(tag).not.toContain('type="module"');
    expect(tag).not.toContain("async");
    expect(tag).not.toContain("defer");
  });

  test("the classic script appears before the app module entry, so it executes first", () => {
    const vendorAt = indexHtml.indexOf(`src="${VENDOR_URL}"`);
    const entryAt = indexHtml.indexOf(
      '<script type="module" src="/src/main.tsx">',
    );
    expect(vendorAt).toBeGreaterThan(-1);
    expect(entryAt).toBeGreaterThan(-1);
    // Classic (non-deferred) scripts run during parsing; every module — the app
    // entry and the platform's head-injected bridge alike — runs after parsing.
    expect(vendorAt).toBeLessThan(entryAt);
  });

  test("no script or link URL on the page points at jsDelivr", () => {
    const remoteRefs =
      indexHtml.match(/(?:src|href)\s*=\s*["'][^"']*jsdelivr[^"']*"/g) ?? [];
    expect(remoteRefs).toEqual([]);
  });
});
