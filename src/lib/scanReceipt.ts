// ── SitePulse scan provenance receipts (Phase 11A) ──────────────────────────
// Fixes the audit's "forged saved scan reports" risk: `scans.saveScan` is a
// PUBLIC mutation (the anonymous flow must be able to persist a report), so
// before this phase it accepted whatever scores, grades, issues and summary
// the caller felt like sending. A report minted out of thin air was then
// served from `/report/<id>` under a "Verified Scan" badge.
//
// The fix binds every saved report to the server-side scan that produced it:
//
//   1. `scan.scanWebsite` (a "use node" ACTION) computes the report
//      server-side, then mints a receipt over a canonical form of the ENTIRE
//      payload plus an expiry:  receipt = HMAC-SHA256(key, "<exp>.<canonical>")
//   2. `scans.saveScan` (a PUBLIC MUTATION) recomputes the canonical form of
//      everything it received (minus `visitorId` and `receipt`, which are
//      transport, not report data) and verifies signature AND expiry BEFORE
//      consuming any quota or writing any row.
//
// Properties, all enforced by the code below and pinned by tests:
//   - The client cannot mint receipts: the HMAC key is generated once in the
//     action and stored in an internal-only table (see scans.ts) — it is
//     never returned to any client and there is no env-var/hardcoded secret.
//   - The client cannot tamper: any change to score, grade, category checks,
//     issues, quick wins, summary, SSL/server info, URL, scannedAt … changes
//     the canonical bytes and the signature no longer verifies.
//   - Expiry is inside the signed message, so `exp` cannot be extended.
//   - Missing/invalid/expired/mismatched receipts are rejected with a typed
//     reason and never reach the quota or insert steps.
//
// Runtime note (verified against Convex docs before choosing this design):
// signing runs in a Node action (node:crypto available) and verification runs
// in a default-runtime mutation, which Convex documents as exposing Web
// Crypto (`crypto`, `SubtleCrypto`). HMAC is deliberately built from
// `crypto.subtle.digest("SHA-256")` ONLY — the single most widely supported
// primitive — instead of importKey/sign, so verification depends on the
// smallest possible runtime surface. Tests cross-check every signature
// against Node's own `crypto.createHmac`.
//
// Canonical form: recursive JSON with object keys sorted, where object
// properties whose value is `null` or `undefined` are DROPPED (arrays keep
// their elements; JSON turns undefined array slots into null). Dropping nulls
// is what makes the payload the action returned (which contains nulls) equal
// to the payload the mutation receives (the client runs `nullsToUndefined`
// before saving, see src/lib/nulls.ts).

export const SCAN_RECEIPT_TTL_MS = 10 * 60 * 1000;

export interface ScanReceipt {
  /** Absolute expiry, epoch ms — signed, so it cannot be moved forward. */
  exp: number;
  /** Lowercase hex HMAC-SHA256 (64 chars) over `"<exp>.<canonical payload>"`. */
  sig: string;
}

export type ReceiptRejectReason =
  | "missing"
  | "malformed"
  | "expired"
  | "mismatch"
  | "key_unavailable";

export type ReceiptVerdict =
  | { ok: true }
  | { ok: false; reason: ReceiptRejectReason };

/** 64-char lowercase hex — the exact shape our HMAC output produces. */
const HEX64 = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Invalid hex key.");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Web Crypto only: available in the Node action (mint) and in Convex's
  // default runtime (verify). No node:crypto import here so the SAME
  // implementation runs on both sides of the round trip. The copy re-bases
  // the bytes on a plain ArrayBuffer, which is what BufferSource requires
  // (inputs may arrive as ArrayBufferLike-backed views).
  const buf = new Uint8Array(data);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

/**
 * HMAC-SHA256, RFC 2104 construction over the SHA-256 primitive, hex output.
 * Key is lowercase hex (32 bytes / 64 chars in production).
 */
export async function hmacSha256Hex(keyHex: string, message: string): Promise<string> {
  let key = hexToBytes(keyHex);
  if (key.length === 0) throw new Error("Empty HMAC key.");
  if (key.length > 64) key = await sha256(key); // hash keys longer than one block
  const padded = new Uint8Array(64);
  padded.set(key, 0);
  const ipad = padded.map((b) => b ^ 0x36);
  const opad = padded.map((b) => b ^ 0x5c);
  const inner = await sha256(concat(ipad, new TextEncoder().encode(message)));
  return bytesToHex(await sha256(concat(opad, inner)));
}

/**
 * Deterministic canonical JSON for receipt binding: sorted object keys,
 * null/undefined properties dropped, arrays kept in order. Two structurally
 * equal payloads canonicalize to identical bytes regardless of key order,
 * null-vs-absent spelling, or the Convex client round trip.
 */
export function canonicalScanPayload(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalScanPayload(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, val]) => val !== null && val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const body = entries
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalScanPayload(val)}`)
      .join(",");
    return `{${body}}`;
  }
  // string | number | boolean — JSON's own deterministic serialization.
  return JSON.stringify(value);
}

/** The exact bytes a receipt signs: expiry first, then the payload. */
function receiptMessage(exp: number, payload: unknown): string {
  return `${exp}.${canonicalScanPayload(payload)}`;
}

/**
 * Mint a receipt for a payload the SERVER just produced (called only from
 * the scanWebsite action, which holds the stored key).
 */
export async function mintScanReceipt(
  payload: unknown,
  keyHex: string,
  now: number = Date.now(),
): Promise<ScanReceipt> {
  const exp = now + SCAN_RECEIPT_TTL_MS;
  const sig = await hmacSha256Hex(keyHex, receiptMessage(exp, payload));
  return { exp, sig };
}

/** Constant-time-ish hex comparison (no early exit on the first mismatch). */
function hexesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a receipt against the payload a client submitted. Signature is
 * checked before expiry so a tampered `exp` fails as `mismatch`, and an
 * honestly signed but past `exp` fails as `expired`.
 */
export async function verifyScanReceipt(
  payload: unknown,
  receipt: ScanReceipt | undefined,
  keyHex: string,
  now: number = Date.now(),
): Promise<ReceiptVerdict> {
  if (receipt === undefined) return { ok: false, reason: "missing" };
  if (
    typeof receipt.exp !== "number" ||
    !Number.isFinite(receipt.exp) ||
    typeof receipt.sig !== "string" ||
    !HEX64.test(receipt.sig)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expected = await hmacSha256Hex(keyHex, receiptMessage(receipt.exp, payload));
  if (!hexesEqual(expected, receipt.sig)) return { ok: false, reason: "mismatch" };
  if (now > receipt.exp) return { ok: false, reason: "expired" };
  return { ok: true };
}
