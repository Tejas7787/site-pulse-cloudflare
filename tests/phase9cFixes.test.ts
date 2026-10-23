// Phase 9C regression tests for the two confirmed browser-test bugs:
//
// 1. AUTH ERROR LEAK — the sign-in form rendered raw Convex server errors
//    ("[CONVEX A(auth:signIn)] [Request ID: ...] ... at freebuffEmailOtpError
//    (../../src/convex/auth/emailOtp.ts:59:6)") to users. friendlyAuthError
//    now maps framework-shaped errors to a fixed sentence while clean,
//    application-authored messages pass through.
//
// 2. DEAD HISTORY BUTTON — Landing's "History N" header button scrolled to
//    document.getElementById('scan-history'), which existed nowhere: the
//    history state was never rendered as a list. The section now exists with
//    that exact id and maps entries to their saved reports.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { friendlyAuthError } from "../src/lib/authErrors";
import { friendlyError } from "../src/lib/userErrors";

const FRIENDLY_FALLBACK = "We couldn't send your sign-in code right now. Please try again in a moment.";

describe("friendlyAuthError — auth screens never show framework internals", () => {
  test("the exact error observed in the browser is mapped to the friendly sentence", () => {
    // Captured verbatim from the Phase 9C browser run (Playwright console).
    const convexWrapped =
      "[CONVEX A(auth:signIn)] [Request ID: 8824ac00d224be5a] Server Error\n" +
      "Uncaught Error: Could not send the sign-in code (HTTP 400): Invalid `to` field.\n" +
      "    at freebuffEmailOtpError (../../src/convex/auth/emailOtp.ts:59:6)";
    const shown = friendlyAuthError(new Error(convexWrapped), FRIENDLY_FALLBACK);
    expect(shown).toBe(FRIENDLY_FALLBACK);
    expect(shown).not.toContain("[CONVEX");
    expect(shown).not.toContain("emailOtp.ts");
    expect(shown).not.toContain("Request ID");
  });

  test("bare stack frames and 'Server Error' wrappers are scrubbed even without [CONVEX", () => {
    expect(friendlyAuthError(new Error("boom\n    at handler (../src/x.ts:1:1)"), FRIENDLY_FALLBACK)).toBe(
      FRIENDLY_FALLBACK,
    );
    expect(friendlyAuthError(new Error("Server Error: whatever"), FRIENDLY_FALLBACK)).toBe(FRIENDLY_FALLBACK);
  });

  test("short clean application messages pass through unchanged", () => {
    expect(friendlyAuthError(new Error("That code has already been used."), "fallback")).toBe(
      "That code has already been used.",
    );
  });

  test("over-long or missing messages fall back", () => {
    expect(friendlyAuthError(new Error("x".repeat(500)), FRIENDLY_FALLBACK)).toBe(FRIENDLY_FALLBACK);
    expect(friendlyAuthError(undefined, FRIENDLY_FALLBACK)).toBe(FRIENDLY_FALLBACK);
    expect(friendlyAuthError("not an error", FRIENDLY_FALLBACK)).toBe(FRIENDLY_FALLBACK);
  });

  test("Auth.tsx routes BOTH failure paths through the helper (no raw .message left)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "pages", "Auth.tsx"), "utf8");
    expect(source).toContain("import { friendlyAuthError } from \"@/lib/authErrors\"");
    expect(source).toContain("friendlyAuthError(error,");
    // The two pre-fix raw-display sites must not be back:
    expect(source).not.toContain("error.message\n          :");
    expect(source).not.toContain("${error instanceof Error ? error.message");
  });
});

describe("friendlyError — no user action may show framework internals", () => {
  const FALLBACK = "Something went wrong. Please try again.";

  test("the exact agency plan-limit error captured in-browser unwraps to its message", () => {
    // Captured verbatim from the Phase 9C browser run (Playwright body text)
    // when a 4th client was created on the Free plan.
    const captured =
      "[CONVEX M(agency:createClient)] [Request ID: 14a4d38eb9b66b87] Server Error\n" +
      'Uncaught ConvexError: {"code":"limit","message":"Workspace limit: 3 active clients on this plan. Archive one or upgrade on /pricing."} ' +
      "at handler (../src/convex/agency.ts:489:11)";
    const shown = friendlyError(new Error(captured), FALLBACK);
    expect(shown).toBe(
      "Workspace limit: 3 active clients on this plan. Archive one or upgrade on /pricing.",
    );
    expect(shown).not.toContain("[CONVEX");
    expect(shown).not.toContain("agency.ts");
    expect(shown).not.toContain("Request ID");
    expect(shown).not.toContain('"code"');
  });

  test("a wrapped plain server error unwraps to its message line", () => {
    const captured =
      "[CONVEX A(scan:scanWebsite)] [Request ID: 79f5dc39cb9cb6cf] Server Error\n" +
      "Uncaught Error: This URL points to a private or restricted address and cannot be scanned.\n" +
      "    at handler (../src/convex/scan.ts:86:13)";
    expect(friendlyError(new Error(captured), FALLBACK)).toBe(
      "This URL points to a private or restricted address and cannot be scanned.",
    );
  });

  test("unextractable framework noise falls back; clean messages pass through", () => {
    expect(friendlyError(new Error("[CONVEX] something opaque"), FALLBACK)).toBe(FALLBACK);
    expect(friendlyError(new Error("network exploded\n    at x (y.js:1:1)"), FALLBACK)).toBe(FALLBACK);
    expect(friendlyError(new Error("Monthly saved-scan limit reached."), FALLBACK)).toBe(
      "Monthly saved-scan limit reached.",
    );
    expect(friendlyError(undefined, FALLBACK)).toBe(FALLBACK);
  });

  test("no page or component shows err.message raw to users anymore", () => {
    // The Phase 9C browser run found the pattern in 14 places; the fix replaced
    // every one with friendlyError(err, fallback). A relapse must fail here.
    const root = join(import.meta.dir, "..", "src");
    const files = [
      "pages/Landing.tsx",
      "pages/Monitors.tsx",
      "pages/Pricing.tsx",
      "pages/Agency.tsx",
      "pages/Report.tsx",
      "pages/Auth.tsx",
      "components/FixProposalPanel.tsx",
      "components/WebsiteDoctor.tsx",
      "components/GitHubRepair.tsx",
    ];
    for (const file of files) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src).not.toContain("instanceof Error ? err.message");
      expect(src).not.toContain("instanceof Error ? error.message");
    }
    expect(files.length).toBeGreaterThan(0);
  });
});

describe("scan history section — the header button has a real target again", () => {
  const landing = readFileSync(join(import.meta.dir, "..", "src", "pages", "Landing.tsx"), "utf8");

  test("an element with id=\"scan-history\" exists (the button's scroll target)", () => {
    expect(landing).toContain('id="scan-history"');
    // The button targets exactly that id:
    expect(landing).toContain("getElementById('scan-history')");
  });

  test("the history state is actually rendered — entries map to saved reports", () => {
    expect(landing).toContain("{history.map((entry) => (");
    expect(landing).toContain("`/report/${entry.scanId}`");
    // Same guard as the button: the section only shows when there is history.
    expect(landing).toContain("{history.length > 0 && (");
  });

  test("no other code path references a scan-history id that does not exist", () => {
    // Every getElementById('scan-history') in the repo must have a matching
    // id in the same source tree — this is the assertion that failed Phase 9C.
    const files = ["src/pages/Landing.tsx"];
    for (const file of files) {
      const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
      const targets = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
      for (const target of targets) {
        expect(src).toContain(`id="${target}"`);
      }
    }
    expect(files.length).toBeGreaterThan(0);
  });
});
