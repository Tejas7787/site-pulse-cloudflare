// Recursively converts nulls to undefined (objects and arrays).
//
// Extracted from Landing.tsx in Phase 11A so the scan-to-save round trip uses
// ONE shared implementation: `scanWebsite` mints its provenance receipt over
// the payload it returns (which contains nulls, e.g. `ssl: null`), and the
// client normalizes those nulls to undefined before calling `scans.saveScan`
// (Convex `v.optional` fields reject null). The receipt's canonical form
// treats null and absent as equal (see src/lib/scanReceipt.ts) — sharing this
// helper keeps the client conversion pinned to the same code the tests
// exercise, so the two sides can never drift apart silently.
export function nullsToUndefined<T>(value: T): T {
  if (value === null) return undefined as T;
  if (Array.isArray(value)) return value.map((item) => nullsToUndefined(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = nullsToUndefined(val);
    return out as T;
  }
  return value;
}
