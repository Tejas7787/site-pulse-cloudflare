// Multilingual site-page detection — the four legal/utility pages a site
// owner expects to be able to link, recognised in English, French, German and
// Spanish, so a translated page is never reported as missing.

import { describe, expect, test } from "bun:test";
import { detectSitePages, foldText } from "../src/lib/siteIdentity";

const page = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head>${head}<title>Example</title></head><body>${body}</body></html>`;

describe("English detection (preserved)", () => {
  test("recognises the classic English link labels", () => {
    // Neutral paths on purpose, so the match has to come from the label.
    const result = detectSitePages(
      page(`
        <a href="/legal">Privacy Policy</a>
        <a href="/policies">Terms of Service</a>
        <a href="/company">About Us</a>
        <a href="/help">Contact Us</a>
      `),
    );
    expect(result.found).toEqual({ privacy: true, terms: true, about: true, contact: true });
    expect(result.evidence.privacy?.source).toBe("link-label");
    expect(result.evidence.privacy?.language).toBe("en");
  });

  test("the legacy whole-page heuristics still count as a fallback", () => {
    // No links at all — only body copy mentioning the pages, exactly what the
    // old regex-based detection used to see.
    const result = detectSitePages(
      page(`<p>We respect your privacy policy and our terms of service.</p><p>support@example.com</p>`),
    );
    expect(result.found.privacy).toBe(true);
    expect(result.found.terms).toBe(true);
    expect(result.found.contact).toBe(true);
    expect(result.evidence.privacy?.source).toBe("english-fallback");
  });
});

describe("French detection", () => {
  test("privacy, terms, about and contact links in French", () => {
    const result = detectSitePages(
      page(`
        <a href="/fr/confidentialite">Politique de confidentialité</a>
        <a href="/fr/conditions-generales">Conditions générales d'utilisation</a>
        <a href="/fr/a-propos">À propos</a>
        <a href="/fr/nous-contacter">Nous contacter</a>
      `),
    );
    expect(result.found).toEqual({ privacy: true, terms: true, about: true, contact: true });
    expect(result.evidence.privacy?.language).toBe("fr");
    expect(result.evidence.privacy?.detail).toContain("confidentialite");
  });

  test("a French page title alone is enough", () => {
    const result = detectSitePages(
      page(`<p>Bienvenue</p>`, `<title>Politique de confidentialité — ACME</title>`),
    );
    expect(result.found.privacy).toBe(true);
    expect(result.evidence.privacy?.source).toBe("page-title");
    expect(result.evidence.privacy?.language).toBe("fr");
  });
});

describe("German detection", () => {
  test("Datenschutz, AGB, Über uns and Kontakt", () => {
    const result = detectSitePages(
      page(`
        <a href="/datenschutz">Datenschutzerklärung</a>
        <a href="/agb">AGB</a>
        <a href="/ueber-uns">Über uns</a>
        <a href="/kontakt">Kontakt</a>
      `),
    );
    expect(result.found).toEqual({ privacy: true, terms: true, about: true, contact: true });
    expect(result.evidence.privacy?.language).toBe("de");
    expect(result.evidence.terms?.language).toBe("de");
  });

  test("umlaut-free paths (ueber-uns, datenschutzerklaerung) are recognised", () => {
    const result = detectSitePages(
      page(`<a href="/de/datenschutzerklaerung">Details</a><a href="/de/ueber-uns">Firma</a>`),
    );
    expect(result.found.privacy).toBe(true);
    expect(result.found.about).toBe(true);
    expect(result.evidence.privacy?.source).toBe("link-href");
  });
});

describe("Spanish detection", () => {
  test("Política de privacidad, Términos, Sobre nosotros and Contacto", () => {
    const result = detectSitePages(
      page(`
        <a href="/es/politica-de-privacidad">Política de privacidad</a>
        <a href="/es/terminos-y-condiciones">Términos y condiciones</a>
        <a href="/es/sobre-nosotros">Sobre nosotros</a>
        <a href="/es/contacto">Contacto</a>
      `),
    );
    expect(result.found).toEqual({ privacy: true, terms: true, about: true, contact: true });
    expect(result.evidence.privacy?.language).toBe("es");
    expect(result.evidence.contact?.language).toBe("es");
  });
});

describe("URL patterns and translated alternates", () => {
  test("a localised path counts even when the link text is neutral", () => {
    const result = detectSitePages(page(`<a href="/fr/conditions-generales-d-utilisation">Légal</a>`));
    expect(result.found.terms).toBe(true);
    expect(result.evidence.terms?.source).toBe("link-href");
  });

  test("locale prefixes and file extensions are ignored when matching", () => {
    const result = detectSitePages(
      page(`<a href="/de/blog/datenschutz.html">Mehr</a><a href="/en-us/contact.php">Reach us</a>`),
    );
    expect(result.found.privacy).toBe(true);
    expect(result.found.contact).toBe(true);
  });

  test("percent-encoded accented paths are decoded before matching", () => {
    const result = detectSitePages(page(`<a href="/fr/politique-de-confidentialit%C3%A9">Info</a>`));
    expect(result.found.privacy).toBe(true);
  });

  test("a declared hreflang alternate means the translated page exists", () => {
    const result = detectSitePages(
      page(
        `<p>English page with no visible legal links.</p>`,
        `<link rel="alternate" hreflang="de" href="https://example.de/datenschutz">
         <link rel="alternate" hreflang="fr" href="https://example.fr/confidentialite">
         <link rel="alternate" hreflang="es" href="https://example.es/aviso-legal">`,
      ),
    );
    expect(result.found.privacy).toBe(true);
    expect(result.found.terms).toBe(true); // aviso legal is a Spanish legal-terms page
    expect(result.evidence.privacy?.source).toBe("hreflang");
    expect(result.evidence.privacy?.language).toBe("de");
  });

  test("an anchor carrying hreflang also counts as a translated page", () => {
    const result = detectSitePages(
      page(`<a hreflang="es" href="https://example.es/privacidad">Español</a>`),
    );
    expect(result.found.privacy).toBe(true);
  });
});

describe("no false positives", () => {
  test("a French site with none of the four pages still reports them missing", () => {
    const result = detectSitePages(
      page(`<h1>Bienvenue sur notre boutique</h1><p>Nos produits sont fabriqués en France.</p>`),
    );
    expect(result.found).toEqual({ privacy: false, terms: false, about: false, contact: false });
  });

  test("unrelated words do not match (contacting, aboutness)", () => {
    const result = detectSitePages(
      page(`<a href="/blog">Contacting customers; aboutness explained</a>`),
    );
    expect(result.found.contact).toBe(false);
    expect(result.found.about).toBe(false);
  });

  test("an English alternate is not evidence of a translated page", () => {
    const result = detectSitePages(
      page(
        `<p>No links here.</p>`,
        `<link rel="alternate" hreflang="en" href="https://example.com/datenschutz">`,
      ),
    );
    // The page still counts as existing — the locale only labels the language,
    // it never turns a real page into a "missing" one.
    expect(result.found.privacy).toBe(true);
    expect(result.evidence.privacy?.source).toBe("hreflang");
    expect(result.evidence.privacy?.language).toBe("en");
  });

  test("foldText strips accents and collapses whitespace", () => {
    expect(foldText("Politique de Confidentialité")).toBe("politique de confidentialite");
    expect(foldText("  Über   Uns  ")).toBe("uber uns");
  });
});
