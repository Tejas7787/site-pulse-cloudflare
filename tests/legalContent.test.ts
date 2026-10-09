// Legal-copy regression tests for Phase 1 (privacy accuracy + retention truth).
// These read the source files directly so a future edit that reintroduces a
// false or missing disclosure fails the suite.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

const legal = read("src/pages/Legal.tsx");
const landing = read("src/pages/Landing.tsx");
const report = read("src/pages/Report.tsx");

describe("Privacy Policy disclosures", () => {
  test("discloses scan processing (URL, HTTP data, derived results, no account required)", () => {
    expect(legal).toContain("the public URL you enter");
    expect(legal).toContain("redirect chain, response headers, timing, and the HTML body up to a size limit");
    expect(legal).toContain("No account or sign-up is required to scan a website");
  });

  test("discloses saved-report visibility and automatic 30-day retention", () => {
    expect(legal).toContain("public to anyone with the link");
    expect(legal).toContain("deleted automatically 30 days after the scan");
    expect(legal).toContain("the report link stops working");
  });

  test("discloses service providers without claiming data is never shared", () => {
    expect(legal).toContain("Convex (convex.dev)");
    expect(legal).toContain("VLY AI gateway");
    // The policy only names the AI model if it matches the active server config.
    const ai = read("src/convex/aiAssistant.ts");
    const configuredModel = ai.match(/model:\s*"([^"]+)"/)?.[1];
    expect(configuredModel).toBeTruthy();
    if (configuredModel === "gpt-4o-mini") {
      expect(legal).toContain(configuredModel);
    } else {
      // If the config ever changes, the policy must still mention this model
      // somewhere so the disclosure is not misleading.
      expect(legal).toContain(configuredModel);
    }
    expect(legal).toContain("integrations.vly.ai");
    expect(legal).toContain("web hosting provider");
    // The old blanket claim must not return:
    expect(legal).not.toContain("We do not sell or share your data with third parties");
    expect(legal).not.toContain("collects only the information needed to run a scan");
    // Selling is still disclaimed, accurately:
    expect(legal).toContain("We do not sell your data");
  });

  test("discloses feedback storage incl. optional email and admin visibility", () => {
    expect(legal).toContain("If you submit feedback we store your rating");
    expect(legal).toContain("your email address only if you entered one");
    expect(legal).toContain("visible to the SitePulse administrators");
  });

  test("discloses optional sign-in email addresses", () => {
    expect(legal).toContain("email address you use for email sign-in");
    expect(legal).toContain("sign-in codes");
  });

  test("describes first-party analytics accurately (storage, no PII, reset)", () => {
    expect(legal).toContain("Usage statistics (first-party only)");
    expect(legal).toContain("page views, scans started, scans completed");
    expect(legal).toContain("coarse device category");
    expect(legal).toContain("no names, email addresses, IP addresses, or location data");
    expect(legal).toContain("reset these identifiers");
    expect(legal).not.toContain("We do not collect"); // no blanket denials
  });

  test("explains user options for data", () => {
    expect(legal).toContain("Clearing your browser storage removes the local identifiers");
    expect(legal).toContain("To ask about information tied to an email address");
  });

  test("policy date was updated", () => {
    expect(legal).toContain('privacy: {\n    title: "Privacy Policy",\n    updated: "Last updated: October 9, 2026"');
  });
});

describe("Terms scanning limitations", () => {
  test("explains HTTP-based scanning and missing browser/JavaScript checks", () => {
    expect(legal).toContain("plain HTTP requests from a server");
    expect(legal).toContain("does not run a real browser");
    expect(legal).toContain("content that only appears after JavaScript runs");
    expect(legal).toContain('reported as \\"Unable to Verify\\" rather than guessed');
  });

  test("explains blocked scans, public-by-link reports, and 30-day deletion", () => {
    expect(legal).toContain("rate limiting or bot challenges");
    expect(legal).toContain("never as confirmed failures");
    expect(legal).toContain("publicly accessible to anyone who has the report link");
    expect(legal).toContain("deleted automatically 30 days after the scan");
  });

  test("states a clean scan does not guarantee complete security", () => {
    expect(legal).toContain("A clean scan does not guarantee that a website is completely secure");
    expect(legal).toContain("is not a security certification");
  });
});

describe("Footer taglines", () => {
  test('"No tracking" is gone from all three footers, replaced by precise wording', () => {
    for (const [name, src] of [["Landing", landing], ["Legal", legal], ["Report", report]] as const) {
      expect(`${name}: ${src.includes("No tracking.")}`).toBe(`${name}: false`);
      expect(src).toContain("First-party analytics only — no ads, no cross-site tracking.");
    }
  });
});
