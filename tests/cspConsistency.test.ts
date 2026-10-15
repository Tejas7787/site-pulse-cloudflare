// CSP consistency regression tests (audit fix, Issue 1 + Issue 2 guards).
//
// The Content-Security-Policy exists in four hand-maintained copies:
//   1. index.html        — <meta http-equiv> (browser-enforced, but a SUBSET of
//                          directives only: frame-ancestors is spec-ignored here)
//   2. public/_headers   — Cloudflare Pages HTTP response headers
//   3. vercel.json       — Vercel HTTP response headers (production: sitepulse.freebuff.app)
//   4. vite.config.ts    — dev/preview server response headers
//
// These tests fail if the copies drift apart, if frame-ancestors is put back
// into the (ineffective) meta tag, if it is removed from the real HTTP
// headers, or if any copy is weakened to allow cdn.jsdelivr.net.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

interface HeaderPair {
  key: string;
  value: string;
}

interface VercelConfig {
  headers: { source: string; headers: HeaderPair[] }[];
}

function parseCsp(csp: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const part of csp.split(";")) {
    const trimmed = part.trim().replace(/\s+/g, " ");
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(" ");
    directives[name] = rest.join(" ");
  }
  return directives;
}

function metaCspContent(html: string): string {
  const m = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  );
  if (!m) throw new Error("index.html meta CSP not found");
  return m[1];
}

function headersFileCsp(headers: string): string {
  const m = headers.match(/^ {2}Content-Security-Policy: (.+)$/m);
  if (!m) throw new Error("public/_headers CSP not found");
  return m[1];
}

function vercelCsp(raw: string): string {
  const cfg = JSON.parse(raw) as VercelConfig;
  const found = cfg.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === "Content-Security-Policy");
  if (!found) throw new Error("vercel.json CSP not found");
  return found.value;
}

function viteConfigCsp(source: string): string {
  const m = source.match(/"Content-Security-Policy":\s*"([^"]+)"/);
  if (!m) throw new Error("vite.config.ts CSP not found");
  return m[1];
}

const indexHtml = read("index.html");
const headersFile = read("public/_headers");
const vercelRaw = read("vercel.json");
const viteConfig = read("vite.config.ts");

const cspCopies: Record<string, string> = {
  "index.html (meta)": metaCspContent(indexHtml),
  "public/_headers": headersFileCsp(headersFile),
  "vercel.json": vercelCsp(vercelRaw),
  "vite.config.ts": viteConfigCsp(viteConfig),
};

const parsedCopies = Object.fromEntries(
  Object.entries(cspCopies).map(([name, csp]) => [name, parseCsp(csp)]),
);

describe("frame-ancestors delivery", () => {
  test("every HTTP response-header carrier sets frame-ancestors 'none'", () => {
    for (const name of ["public/_headers", "vercel.json", "vite.config.ts"]) {
      expect(parsedCopies[name]["frame-ancestors"]).toBe("'none'");
    }
  });

  test("the meta CSP does NOT contain frame-ancestors (browsers ignore it there)", () => {
    expect(parsedCopies["index.html (meta)"]["frame-ancestors"]).toBeUndefined();
    expect(metaCspContent(indexHtml)).not.toContain("frame-ancestors");
  });

  test("the meta CSP is otherwise identical to each header CSP (copies stay in sync)", () => {
    const meta = parsedCopies["index.html (meta)"];
    for (const name of ["public/_headers", "vercel.json", "vite.config.ts"]) {
      const header = { ...parsedCopies[name] };
      delete header["frame-ancestors"];
      expect(header).toEqual(meta);
    }
  });

  test("X-Frame-Options DENY remains on the HTTP header carriers (defense in depth)", () => {
    expect(headersFile).toMatch(/^ {2}X-Frame-Options: DENY$/m);
    expect(vercelRaw).toContain('"X-Frame-Options"');
    expect(vercelRaw).toContain('"value": "DENY"');
    expect(viteConfig).toContain('"X-Frame-Options": "DENY"');
  });
});

describe("script-src must not be weakened", () => {
  test("no CSP copy allows cdn.jsdelivr.net", () => {
    for (const [name, csp] of Object.entries(cspCopies)) {
      const allowsJsdelivr = csp.includes("cdn.jsdelivr.net");
      expect(`${name} allows jsdelivr: ${allowsJsdelivr}`).toBe(
        `${name} allows jsdelivr: false`,
      );
    }
  });

  test("script-src exists and allows 'self' in every copy (local vendor scripts must load)", () => {
    for (const [name, parsed] of Object.entries(parsedCopies)) {
      const scriptSrc = parsed["script-src"];
      expect(`${name} script-src: ${scriptSrc !== undefined}`).toBe(
        `${name} script-src: true`,
      );
      expect(`${name} allows self: ${scriptSrc?.includes("'self'") ?? false}`).toBe(
        `${name} allows self: true`,
      );
    }
  });
});
