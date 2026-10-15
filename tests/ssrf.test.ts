// SSRF regression tests for src/lib/ssrf.ts — the guard shared by the scanner
// and the unattended uptime prober. These lock the exact classes of input a
// dotted-quad-only check lets through: decimal/hex/short IPv4 forms,
// IPv4-mapped IPv6, private ranges (192.168/16 in particular), non-standard
// ports and DNS answers that cannot be proven public.

import { describe, expect, test } from "bun:test";
import {
  checkUrlSafety,
  expandIpv6,
  isPrivateAddress,
  isUrlSafe,
  normalizeIpLiteral,
  parseLooseIpv4,
} from "../src/lib/ssrf";

describe("IP literal normalization", () => {
  test("decimal, hex and short IPv4 forms all normalize to dotted quad", () => {
    expect(parseLooseIpv4("127.0.0.1")).toBe(0x7f000001);
    expect(parseLooseIpv4("2130706433")).toBe(0x7f000001); // decimal loopback
    expect(parseLooseIpv4("0x7f000001")).toBe(0x7f000001); // hex loopback
    expect(parseLooseIpv4("127.1")).toBe(0x7f000001); // short form
    expect(parseLooseIpv4("10.0.0.1")).toBe(0x0a000001);
    expect(normalizeIpLiteral("2130706433")).toBe("127.0.0.1");
    expect(normalizeIpLiteral("127.1")).toBe("127.0.0.1");
    expect(normalizeIpLiteral("[::1]")).toBe("::1");
    expect(normalizeIpLiteral("example.com")).toBeNull();
  });

  test("out-of-range and non-IP input is not treated as an address", () => {
    expect(parseLooseIpv4("999.1.1.1")).toBeNull();
    expect(parseLooseIpv4("1.2.3.4.5")).toBeNull();
    expect(parseLooseIpv4("example.com")).toBeNull();
  });

  test("IPv6 expansion handles compression and embedded IPv4", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6("not-an-ip")).toBeNull();
  });
});

describe("private / special-purpose address classification", () => {
  test("loopback, LAN, link-local and metadata are private", () => {
    for (const addr of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1", // the range the old guard missed
      "172.16.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fd00::1",
      "ff02::1",
      "2130706433",
      "127.1",
    ]) {
      expect(`${addr}: ${isPrivateAddress(addr)}`).toBe(`${addr}: true`);
    }
  });

  test("public addresses stay reachable", () => {
    for (const addr of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2001:4860:4860::8888"]) {
      expect(`${addr}: ${isPrivateAddress(addr)}`).toBe(`${addr}: false`);
    }
  });
});

describe("checkUrlSafety", () => {
  const resolveTo =
    (...addresses: string[]) =>
    async () =>
      addresses;

  test("rejects private IP literals without touching DNS", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://192.168.0.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/",
      "http://10.0.0.5:80/",
    ]) {
      const result = await checkUrlSafety(url, {
        resolve: async () => {
          throw new Error("DNS must not be consulted for literals");
        },
      });
      expect(`${url} → ${result.reason}`).toBe(`${url} → blocked`);
    }
  });

  test("rejects internal hostnames before DNS", async () => {
    for (const url of [
      "http://localhost/",
      "http://intranet.local/",
      "http://metadata.google.internal/",
      "http://db.internal/",
    ]) {
      const result = await checkUrlSafety(url, {
        resolve: async () => {
          throw new Error("DNS must not be consulted");
        },
      });
      expect(result).toEqual({ ok: false, reason: "blocked" });
    }
  });

  test("allows a public host when every DNS answer is public", async () => {
    const result = await checkUrlSafety("https://example.com/", {
      resolve: resolveTo("93.184.216.34"),
    });
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  test("rejects when ANY answer is private (mixed public/private set)", async () => {
    const result = await checkUrlSafety("https://example.com/", {
      resolve: resolveTo("93.184.216.34", "127.0.0.1"),
    });
    expect(result).toEqual({ ok: false, reason: "blocked" });
  });

  test("fails closed when DNS cannot prove the destination, unless told otherwise", async () => {
    const failing = async (): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    expect(await checkUrlSafety("https://example.com/", { resolve: failing })).toEqual({
      ok: false,
      reason: "dns",
    });
    expect(
      await checkUrlSafety("https://example.com/", { resolve: failing, failClosed: false }),
    ).toEqual({ ok: true, reason: "ok" });
    expect(await checkUrlSafety("https://example.com/", { resolve: async () => [] })).toEqual({
      ok: false,
      reason: "dns",
    });
  });

  test("enforces scheme and port allowlist", async () => {
    expect(await checkUrlSafety("file:///etc/passwd")).toEqual({ ok: false, reason: "scheme" });
    expect(await checkUrlSafety("https://example.com:8080/")).toEqual({
      ok: false,
      reason: "port",
    });
    expect(await checkUrlSafety("not a url")).toEqual({ ok: false, reason: "invalid" });
    expect(await checkUrlSafety("https://example.com:443/", { resolve: resolveTo("1.1.1.1") })).toEqual({
      ok: true,
      reason: "ok",
    });
  });

  test("boolean wrapper matches the detailed check", async () => {
    expect(await isUrlSafe("http://10.0.0.1/")).toBe(false);
    expect(await isUrlSafe("https://example.com/", { resolve: resolveTo("1.1.1.1") })).toBe(true);
  });
});
