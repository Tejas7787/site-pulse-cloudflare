/**
 * Multilingual site-page detection (privacy, terms, about, contact).
 *
 * SitePulse fetches exactly one page, so "does this site have a privacy
 * policy / terms / about / contact page?" can only be answered from what that
 * page links to. Real sites localise those links, so a detector that only
 * looks for the English strings reports false "missing page" findings on
 * perfectly compliant French, German and Spanish sites.
 *
 * Detection sources, in the order real sites actually use them:
 *   1. anchor links   — href against common URL patterns, and the link label
 *                       against localised labels;
 *   2. hreflang       — declared alternates (an English page with
 *                       hreflang="de" … /de/datenschutz has a German page);
 *   3. page titles    — <title>, <h1> and <h2> headings;
 *   4. English body   — the legacy whole-page heuristics, kept as a fallback
 *                       so nothing that used to be detected regresses.
 *
 * Everything here is pure string work so it can be unit-tested without a
 * network or a DOM.
 */

export type PageKind = "privacy" | "terms" | "about" | "contact";

export type PageEvidenceSource =
  | "link-label"
  | "link-href"
  | "hreflang"
  | "page-title"
  | "heading"
  | "english-fallback";

export interface PageEvidence {
  kind: PageKind;
  source: PageEvidenceSource;
  /** Human-readable description of what matched, safe to show in a report. */
  detail: string;
  /** Language the match came from, when it came from a translated string. */
  language?: "en" | "fr" | "de" | "es";
}

export interface SitePageDetection {
  found: Record<PageKind, boolean>;
  evidence: Record<PageKind, PageEvidence | null>;
}

/* ── Vocabulary ────────────────────────────────────────────────────────── */

/** Link label / heading text, matched after accent-folding. */
const LABELS: Record<PageKind, { text: string; language: PageEvidence["language"] }[]> = {
  privacy: [
    { text: "privacy policy", language: "en" },
    { text: "privacy notice", language: "en" },
    { text: "datenschutzerklärung", language: "de" },
    { text: "datenschutzerklaerung", language: "de" },
    { text: "datenschutz", language: "de" },
    { text: "politique de confidentialité", language: "fr" },
    { text: "politique de confidentialite", language: "fr" },
    { text: "confidentialité", language: "fr" },
    { text: "confidentialite", language: "fr" },
    { text: "política de privacidad", language: "es" },
    { text: "politica de privacidad", language: "es" },
    { text: "aviso de privacidad", language: "es" },
    { text: "privacidad", language: "es" },
  ],
  terms: [
    { text: "terms of service", language: "en" },
    { text: "terms and conditions", language: "en" },
    { text: "terms of use", language: "en" },
    { text: "terms & conditions", language: "en" },
    { text: "conditions générales d'utilisation", language: "fr" },
    { text: "conditions generales d'utilisation", language: "fr" },
    { text: "conditions d'utilisation", language: "fr" },
    { text: "conditions générales", language: "fr" },
    { text: "conditions generales", language: "fr" },
    { text: "agb", language: "de" },
    { text: "nutzungsbedingungen", language: "de" },
    { text: "allgemeine geschäftsbedingungen", language: "de" },
    { text: "allgemeine geschaeftsbedingungen", language: "de" },
    { text: "términos y condiciones", language: "es" },
    { text: "terminos y condiciones", language: "es" },
    { text: "términos de servicio", language: "es" },
    { text: "terminos de servicio", language: "es" },
    { text: "condiciones de uso", language: "es" },
    { text: "aviso legal", language: "es" },
  ],
  about: [
    { text: "about us", language: "en" },
    { text: "about", language: "en" },
    { text: "über uns", language: "de" },
    { text: "uber uns", language: "de" },
    { text: "à propos", language: "fr" },
    { text: "a propos", language: "fr" },
    { text: "sobre nosotros", language: "es" },
  ],
  contact: [
    { text: "contact us", language: "en" },
    { text: "contact", language: "en" },
    { text: "kontakt", language: "de" },
    { text: "nous contacter", language: "fr" },
    { text: "contacto", language: "es" },
    { text: "contáctanos", language: "es" },
    { text: "contactanos", language: "es" },
  ],
};

/** Common URL path segments (after locale prefix / extension stripping). */
const PATH_PATTERNS: Record<PageKind, { segment: string; language: PageEvidence["language"] }[]> = {
  privacy: [
    { segment: "privacy", language: "en" },
    { segment: "privacy-policy", language: "en" },
    { segment: "privacypolicy", language: "en" },
    { segment: "datenschutz", language: "de" },
    { segment: "datenschutzerklaerung", language: "de" },
    { segment: "confidentialite", language: "fr" },
    { segment: "politique-de-confidentialite", language: "fr" },
    { segment: "privacidad", language: "es" },
    { segment: "politica-de-privacidad", language: "es" },
    { segment: "aviso-de-privacidad", language: "es" },
  ],
  terms: [
    { segment: "terms", language: "en" },
    { segment: "tos", language: "en" },
    { segment: "terms-of-service", language: "en" },
    { segment: "termsofservice", language: "en" },
    { segment: "terms-and-conditions", language: "en" },
    { segment: "terms-of-use", language: "en" },
    { segment: "agb", language: "de" },
    { segment: "nutzungsbedingungen", language: "de" },
    { segment: "conditions-generales", language: "fr" },
    { segment: "conditions-generales-d-utilisation", language: "fr" },
    { segment: "conditions-d-utilisation", language: "fr" },
    { segment: "cgu", language: "fr" },
    { segment: "terminos", language: "es" },
    { segment: "terminos-y-condiciones", language: "es" },
    { segment: "terminos-de-servicio", language: "es" },
    { segment: "condiciones-de-uso", language: "es" },
    { segment: "aviso-legal", language: "es" },
  ],
  about: [
    { segment: "about", language: "en" },
    { segment: "about-us", language: "en" },
    { segment: "ueber-uns", language: "de" },
    { segment: "a-propos", language: "fr" },
    { segment: "sobre-nosotros", language: "es" },
  ],
  contact: [
    { segment: "contact", language: "en" },
    { segment: "contact-us", language: "en" },
    { segment: "kontakt", language: "de" },
    { segment: "nous-contacter", language: "fr" },
    { segment: "contacto", language: "es" },
    { segment: "contactanos", language: "es" },
  ],
};

/** Language subdomains / path prefixes we should look through. */
const LOCALE_SEGMENT = /^(?:[a-z]{2}|[a-z]{2}-[a-z]{2})$/i;
const ENGLISH_LOCALES = new Set(["en", "en-us", "en-gb", "en-ca", "en-au"]);

/**
 * Legacy whole-page heuristics, kept verbatim so English detection behaves
 * exactly as it did before multilingual support was added.
 */
const LEGACY_ENGLISH: Record<PageKind, RegExp> = {
  privacy: /privacy[- _]?policy|datenschutz|privacidad/i,
  terms: /terms[- _]?(?:of[- _]?)?service|terms[- _]and[- _]conditions|agb|términos/i,
  contact: /contact[\s@]|mailto:|tel:|phone|address|support@/i,
  about: /about[- _]?us/i,
};

/* ── Text helpers ──────────────────────────────────────────────────────── */

/** Lowercase, strip accents, collapse whitespace. */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripTags(html: string): string {
  return foldText(html.replace(/<[^>]*>/g, " "));
}

function decodeUrlSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Match a short label against a known phrase with word boundaries. */
function labelMatches(text: string, phrase: string): boolean {
  const folded = foldText(text);
  const target = foldText(phrase);
  if (!target) return false;
  const index = folded.indexOf(target);
  if (index === -1) return false;
  const before = index === 0 ? " " : folded[index - 1];
  const after = index + target.length >= folded.length ? " " : folded[index + target.length];
  // Words only: "contact" must not match "contacting", "about" not "aboutus".
  const isWord = /^[a-z0-9]/.test(target);
  return (!isWord || !/[a-z0-9]/.test(before)) && (!isWord || !/[a-z0-9]/.test(after));
}

/** Split a URL's pathname into comparable, locale/extension-stripped segments. */
function pathSegments(href: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(href, "https://example.invalid").pathname;
  } catch {
    return [];
  }
  return decodeUrlSafe(pathname)
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0)
    // Locale prefixes (/en/, /fr-FR/, /de/blog/) are navigation, not evidence.
    .filter((segment, index, all) => !(index < all.length - 1 && LOCALE_SEGMENT.test(segment)))
    .map((segment) => segment.replace(/\.(?:html?|php|aspx?)$/, ""))
    .map((segment) => foldText(segment).replace(/\s+/g, "-"));
}

function matchPath(
  segments: string[],
): { kind: PageKind; pattern: string; language: PageEvidence["language"] } | null {
  for (const segment of segments) {
    for (const kind of Object.keys(PATH_PATTERNS) as PageKind[]) {
      const match = PATH_PATTERNS[kind].find((p) => p.segment === segment);
      if (match) return { kind, pattern: match.segment, language: match.language };
    }
  }
  return null;
}

function matchLabel(text: string): { kind: PageKind; phrase: string; language: PageEvidence["language"] } | null {
  for (const kind of Object.keys(LABELS) as PageKind[]) {
    for (const entry of LABELS[kind]) {
      if (labelMatches(text, entry.text)) return { kind, phrase: entry.text, language: entry.language };
    }
  }
  return null;
}

/** English locale codes that should *not* count as a "translated" page. */
function isNonEnglishLocale(locale: string): boolean {
  const folded = locale.trim().toLowerCase();
  return folded.length > 0 && !ENGLISH_LOCALES.has(folded);
}

/* ── Detector ──────────────────────────────────────────────────────────── */

interface Anchor {
  href: string;
  label: string;
  hreflang: string;
}

function parseAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const label = stripTags(match[2] ?? "");
    let href = "";
    let hreflang = "";
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(attrs)) !== null) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (name === "href") href = value;
      if (name === "hreflang") hreflang = value;
    }
    anchors.push({ href, label, hreflang });
  }
  return anchors;
}

function parseHreflangAlternates(html: string): Anchor[] {
  const alternates: Anchor[] = [];
  const linkRe = /<link\b([^>]*)\/?>/gi;
  const attrRe = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    let rel = "";
    let href = "";
    let hreflang = "";
    let attr: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((attr = attrRe.exec(attrs)) !== null) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (name === "rel") rel = value.toLowerCase();
      if (name === "href") href = value;
      if (name === "hreflang") hreflang = value;
    }
    if (rel.includes("alternate") && href && hreflang) {
      alternates.push({ href, label: "", hreflang });
    }
  }
  return alternates;
}

function headText(html: string, tag: "title" | "h1" | "h2"): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = re.exec(html);
  return match ? stripTags(match[1]) : "";
}

/**
 * Detect privacy / terms / about / contact pages in EN, FR, DE and ES.
 * Always returns a full record — a page is only "missing" when every source
 * came back empty.
 */
export function detectSitePages(html: string): SitePageDetection {
  const found = { privacy: false, terms: false, about: false, contact: false } as Record<
    PageKind,
    boolean
  >;
  const evidence = { privacy: null, terms: null, about: null, contact: null } as Record<
    PageKind,
    PageEvidence | null
  >;

  const record = (kind: PageKind, value: PageEvidence) => {
    if (found[kind]) return;
    found[kind] = true;
    evidence[kind] = value;
  };

  const anchors = parseAnchors(html);

  // 1a. Anchor hrefs → common URL patterns (locale prefixes ignored).
  for (const anchor of anchors) {
    if (!anchor.href) continue;
    const match = matchPath(pathSegments(anchor.href));
    if (match) {
      record(match.kind, {
        kind: match.kind,
        source: "link-href",
        detail: `Link to "${anchor.href}" contains the "${match.pattern}" path segment.`,
        language: match.language,
      });
    }
  }

  // 1b. Anchor labels → localised link text.
  for (const anchor of anchors) {
    if (!anchor.label) continue;
    const match = matchLabel(anchor.label);
    if (match) {
      record(match.kind, {
        kind: match.kind,
        source: "link-label",
        detail: `Link labelled "${anchor.label}" (${match.language} label).`,
        language: match.language,
      });
    }
  }

  // 2. Declared hreflang alternates — a translated page is still a page.
  for (const alternate of [...parseHreflangAlternates(html), ...anchors]) {
    if (!alternate.href) continue;
    const match = matchPath(pathSegments(alternate.href));
    if (!match) continue;
    // The declared hreflang is authoritative for the language of the page.
    const language = (isNonEnglishLocale(alternate.hreflang)
      ? alternate.hreflang.slice(0, 2).toLowerCase()
      : "en") as PageEvidence["language"];
    record(match.kind, {
      kind: match.kind,
      source: "hreflang",
      detail: `Alternate page declared as hreflang="${alternate.hreflang}" → ${alternate.href}.`,
      language,
    });
  }

  // 3. Page title and headings.
  for (const tag of ["title", "h1", "h2"] as const) {
    const text = headText(html, tag);
    if (!text) continue;
    const match = matchLabel(text);
    if (match) {
      record(match.kind, {
        kind: match.kind,
        source: tag === "title" ? "page-title" : "heading",
        detail: `Page ${tag === "title" ? "title" : `heading <${tag}>`} reads "${text}".`,
        language: match.language,
      });
    }
  }

  // 4. Legacy English whole-page heuristics, unchanged.
  for (const kind of Object.keys(LEGACY_ENGLISH) as PageKind[]) {
    if (found[kind]) continue;
    if (LEGACY_ENGLISH[kind].test(html)) {
      record(kind, {
        kind,
        source: "english-fallback",
        detail: "Matched the legacy English whole-page heuristic.",
        language: "en",
      });
    }
  }

  return { found, evidence };
}
