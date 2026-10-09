// Recommendation consolidation + hosting-aware fix snippets.

import { describe, expect, test } from "bun:test";
import {
  anchorFor,
  anchorsFor,
  buildSnippet,
  canonicalActionable,
  dedupeIssues,
  issueKey,
  matchIssueByMessage,
  splitRecommendations,
  type RecommendationIssue,
} from "../src/lib/recommendations";
import { detectHostingPlatform, headerSyntaxFor, HOSTING_LABELS } from "../src/lib/hosting";

function issue(overrides: Partial<RecommendationIssue> & { message: string }): RecommendationIssue {
  return {
    category: "Security",
    severity: "warning",
    priority: "important",
    whyItMatters: "why",
    howToFix: "how",
    ...overrides,
  };
}

/* ── Duplicate removal ─────────────────────────────────────────────────── */

describe("dedupeIssues", () => {
  test("the same check raised twice appears once", () => {
    const first = issue({ message: "Missing Referrer-Policy header.", checkKey: "header-rp" });
    const duplicate = issue({
      message: "Missing Referrer-Policy header.",
      checkKey: "header-rp",
      priority: "recommended",
    });
    const result = dedupeIssues([first, duplicate]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(first); // the stronger instance is kept
  });

  test("the strongest priority wins regardless of order", () => {
    const weak = issue({ message: "No title tag found.", checkKey: "title", priority: "nice-to-have" });
    const strong = issue({ message: "No title tag found.", checkKey: "title", priority: "critical" });
    expect(dedupeIssues([weak, strong])[0]).toBe(strong);
    expect(dedupeIssues([strong, weak])[0]).toBe(strong);
  });

  test("falls back to the normalised message when there is no check key", () => {
    const result = dedupeIssues([
      issue({ message: "No H1 tag found." }),
      issue({ message: "  no h1  tag found!! " }),
    ]);
    expect(result).toHaveLength(1);
  });

  test("distinct checks with similar wording stay distinct", () => {
    const result = dedupeIssues([
      issue({ message: "Missing X-Frame-Options header.", checkKey: "header-xfo" }),
      issue({ message: "Missing X-Content-Type-Options header.", checkKey: "header-xcto" }),
    ]);
    expect(result).toHaveLength(2);
  });

  test("first-appearance order is preserved", () => {
    const a = issue({ message: "A", checkKey: "a", priority: "recommended" });
    const b = issue({ message: "B", checkKey: "b", priority: "recommended" });
    expect(dedupeIssues([a, b]).map((i) => i.checkKey)).toEqual(["a", "b"]);
  });
});

describe("splitRecommendations / canonicalActionable", () => {
  test("actionable holds critical/important/recommended, informational the rest", () => {
    const { actionable, informational } = splitRecommendations([
      issue({ message: "A", checkKey: "a", priority: "critical" }),
      issue({ message: "B", checkKey: "b", priority: "important" }),
      issue({ message: "C", checkKey: "c", priority: "recommended" }),
      issue({ message: "D", checkKey: "d", priority: "nice-to-have" }),
    ]);
    expect(actionable.map((i) => i.checkKey)).toEqual(["a", "b", "c"]);
    expect(informational.map((i) => i.checkKey)).toEqual(["d"]);
  });

  test("the canonical list is deduplicated, actionable only and sorted", () => {
    const list = canonicalActionable([
      issue({ message: "Nice", checkKey: "n", priority: "nice-to-have" }),
      issue({ message: "Second", checkKey: "b", priority: "recommended" }),
      issue({ message: "First", checkKey: "a", priority: "critical" }),
      issue({ message: "First again", checkKey: "a", priority: "important" }),
    ]);
    expect(list.map((i) => i.checkKey)).toEqual(["a", "b"]);
    expect(list[0].priority).toBe("critical");
  });

  test("quick wins resolve to their canonical card instead of a duplicate", () => {
    const list = canonicalActionable([
      issue({ message: "Add a meta description.", checkKey: "meta-description" }),
    ]);
    const match = matchIssueByMessage(list, "add a  meta description!");
    expect(match?.checkKey).toBe("meta-description");
    expect(matchIssueByMessage(list, "something else")).toBeUndefined();
  });
});

describe("anchors", () => {
  test("anchors are stable, unique and url-safe", () => {
    const list = canonicalActionable([
      issue({ message: "Missing CSP header.", checkKey: "header-csp" }),
      issue({ message: "No title tag found.", checkKey: "title" }),
    ]);
    const anchors = anchorsFor(list);
    const values = list.map((i) => anchors.get(issueKey(i)));
    expect(values[0]).toBe(anchorFor(list[0], 0));
    expect(values[0]).not.toBe(values[1]);
    expect(values.every((a) => /^fix-\d+[a-z0-9-]*$/.test(a ?? ""))).toBe(true);
  });
});

/* ── Hosting detection ─────────────────────────────────────────────────── */

describe("detectHostingPlatform", () => {
  test("names the platform only from observed evidence", () => {
    expect(detectHostingPlatform({ server: "nginx/1.24.0" })).toBe("nginx");
    expect(detectHostingPlatform({ server: "Apache/2.4.41 (Ubuntu)" })).toBe("apache");
    expect(detectHostingPlatform({ server: "openresty" })).toBe("openresty");
    expect(detectHostingPlatform({ server: "LiteSpeed" })).toBe("litespeed");
    expect(detectHostingPlatform({ server: "Microsoft-IIS/10.0" })).toBe("iis");
    expect(detectHostingPlatform({ server: "cloudflare" })).toBe("cloudflare");
    expect(detectHostingPlatform({ poweredBy: "Vercel" })).toBe("vercel");
    expect(detectHostingPlatform({ server: "Netlify" })).toBe("netlify");
  });

  test("unknown when nothing names a platform", () => {
    expect(detectHostingPlatform({})).toBe("unknown");
    expect(detectHostingPlatform({ server: null, poweredBy: null })).toBe("unknown");
    expect(detectHostingPlatform({ server: "gunicorn" })).toBe("unknown");
  });

  test("a CDN in front of a server wins, because that is where the owner acts", () => {
    expect(detectHostingPlatform({ server: "cloudflare" })).toBe("cloudflare");
  });

  test("header syntax follows the identified platform", () => {
    expect(headerSyntaxFor("nginx")).toBe("nginx");
    expect(headerSyntaxFor("apache")).toBe("apache");
    expect(headerSyntaxFor("iis")).toBe("iis");
    expect(headerSyntaxFor("cloudflare")).toBe("panel");
    expect(headerSyntaxFor("unknown")).toBe("neutral");
  });
});

/* ── Hosting-aware snippets ────────────────────────────────────────────── */

const referrerPolicy = issue({
  message: "Missing Referrer-Policy header.",
  howToFix: "Add the header: Referrer-Policy: strict-origin-when-cross-origin",
});
const csp = issue({
  message: "Missing Content-Security-Policy header.",
  howToFix:
    "Add a Content-Security-Policy header. Start with a basic policy: Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'.",
});
const hsts = issue({
  message: "Missing Strict-Transport-Security (HSTS) header.",
  howToFix:
    "Add the header: Strict-Transport-Security: max-age=31536000; includeSubDomains. Start with a short max-age and increase over time.",
});
const frameOptions = issue({
  message: "Missing X-Frame-Options header.",
  howToFix: "Add the header: X-Frame-Options: DENY (or SAMEORIGIN if you need to frame your own content).",
});

describe("buildSnippet — never assumes Apache or Nginx", () => {
  test("unknown platform → neutral snippet that states the assumption", () => {
    const snippet = buildSnippet(referrerPolicy, "unknown");
    expect(snippet).not.toBeNull();
    expect(snippet!.label).not.toMatch(/nginx|apache/i);
    expect(snippet!.code).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(snippet!.assumption).toContain("could not identify your hosting platform");
  });

  test("no platform argument means unknown (the safe default)", () => {
    const snippet = buildSnippet(referrerPolicy);
    expect(snippet!.label).toBe("Generic response header");
    expect(snippet!.assumption).toBeDefined();
  });

  test("nginx evidence → nginx syntax only", () => {
    const snippet = buildSnippet(referrerPolicy, "nginx");
    expect(snippet!.label).toBe("Nginx server block");
    expect(snippet!.code).toContain(
      'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    );
    expect(snippet!.assumption).toBeUndefined();
  });

  test("apache evidence → Apache syntax only", () => {
    const snippet = buildSnippet(referrerPolicy, "apache");
    expect(snippet!.label).toBe("Apache .htaccess");
    expect(snippet!.code).toContain('Header always set Referrer-Policy "strict-origin-when-cross-origin"');
    expect(snippet!.code).not.toContain("add_header");
  });

  test("iis evidence → web.config syntax", () => {
    const snippet = buildSnippet(referrerPolicy, "iis");
    expect(snippet!.code).toContain('<add headerName="Referrer-Policy"');
  });

  test("cloudflare evidence → dashboard/_headers steps, no server syntax", () => {
    const snippet = buildSnippet(referrerPolicy, "cloudflare");
    expect(snippet!.label).toBe("Cloudflare settings");
    expect(snippet!.code).toContain("_headers");
    expect(snippet!.code).not.toContain("add_header");
    expect(snippet!.code).not.toContain("Header always set");
  });

  test("CSP and HSTS values are parsed out of the recommendation text", () => {
    expect(buildSnippet(csp, "nginx")!.code).toContain(
      'add_header Content-Security-Policy "default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'" always;',
    );
    expect(buildSnippet(hsts, "nginx")!.code).toContain(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    );
  });

  test("parentheticals in a fix are not copied into the header value", () => {
    expect(buildSnippet(frameOptions, "nginx")!.code).toContain(
      'add_header X-Frame-Options "DENY" always;',
    );
  });

  test("HTML/config fixes stay platform-independent", () => {
    const snippet = buildSnippet(
      issue({
        category: "SEO",
        severity: "info",
        priority: "recommended",
        message: "No title tag found.",
        howToFix: "Add a title tag.",
      }),
      "nginx",
    );
    expect(snippet!.label).toBe("HTML");
    expect(snippet!.code).toContain("<title>");
  });

  test("issues that are not copy-paste fixes return null", () => {
    expect(buildSnippet(issue({ message: "Page responded with HTTP 500." }), "nginx")).toBeNull();
  });
});

describe("labels are consistent", () => {
  test("every platform has a human label", () => {
    for (const platform of ["nginx", "apache", "iis", "cloudflare", "unknown"] as const) {
      expect(HOSTING_LABELS[platform]).toBeTruthy();
    }
  });
});
