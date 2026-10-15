// Alert email content tests: subjects, bodies and recipient validation.
// The body must contain the monitor's own data only (no secrets), and both
// kinds of email must be worded so a reader knows what happened and when.

import { describe, expect, test } from "bun:test";
import { alertSubject, alertText, isValidAlertEmail } from "../src/lib/alerts";

describe("recipient validation", () => {
  test("accepts plausible addresses and rejects junk", () => {
    expect(isValidAlertEmail("ops@example.com")).toBe(true);
    expect(isValidAlertEmail("a.b+tag@sub.example.co.uk")).toBe(true);
    expect(isValidAlertEmail("nope")).toBe(false);
    expect(isValidAlertEmail("nope@domain")).toBe(false);
    expect(isValidAlertEmail("@example.com")).toBe(false);
    expect(isValidAlertEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("subjects", () => {
  test("downtime and recovery are distinguishable at a glance", () => {
    expect(alertSubject("downtime", "example.com")).toBe("SitePulse: example.com is DOWN");
    expect(alertSubject("recovery", "example.com")).toBe("SitePulse: example.com is back up");
  });
});

describe("bodies", () => {
  const openedAt = Date.UTC(2026, 9, 15, 12, 0, 0);

  test("downtime email names the URL, detection time and reason", () => {
    const body = alertText({
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      reason: "http-503",
      openedAt,
    });
    expect(body).toContain("example.com appears to be DOWN.");
    expect(body).toContain("https://example.com/");
    expect(body).toContain("2026-10-15 12:00:00 UTC");
    expect(body).toContain("http-503");
    expect(body).toContain("consecutive failed checks");
    expect(body).not.toContain("undefined");
  });

  test("recovery email states the outage window and duration", () => {
    const recoveredAt = openedAt + 10 * 60 * 1000;
    const body = alertText({
      kind: "recovery",
      url: "https://example.com/",
      host: "example.com",
      openedAt,
      recoveredAt,
    });
    expect(body).toContain("example.com is back UP.");
    expect(body).toContain("2026-10-15 12:00:00 UTC");
    expect(body).toContain("2026-10-15 12:10:00 UTC");
    expect(body).toContain("~10 minutes");
    expect(body).not.toContain("undefined");
  });

  test("emails carry an unsubscribe-style explanation, not secrets", () => {
    const body = alertText({
      kind: "downtime",
      url: "https://example.com/",
      host: "example.com",
      openedAt,
    });
    expect(body).toContain("receiving this because alerts are enabled");
    expect(body.toLowerCase()).not.toContain("api key");
    expect(body.toLowerCase()).not.toContain("authorization");
  });
});
