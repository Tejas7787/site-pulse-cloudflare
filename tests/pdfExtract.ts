// Minimal PDF text extractor for tests.
//
// Works on uncompressed PDFs (jsPDF default): pulls every string shown with a
// Tj/TJ operator out of the content, unescapes PDF string escapes and returns
// them joined by newlines. This is the actual selectable text a PDF reader
// would expose.

const ESCAPES: Record<string, string> = {
  n: "\n", r: "\r", t: "\t", b: "\b", f: "\f",
  "(": "(", ")": ")", "\\": "\\",
};

function unescapePdfString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") { out += ch; continue; }
    i++;
    if (i >= raw.length) break;
    const next = raw[i];
    if (next >= "0" && next <= "7") {
      let oct = next;
      while (oct.length < 3 && i + 1 < raw.length && raw[i + 1] >= "0" && raw[i + 1] <= "7") {
        oct += raw[++i];
      }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    out += ESCAPES[next] ?? next;
  }
  return out;
}

/** Extract all shown text from a PDF, one shown string per line. */
export function extractPdfText(bytes: Uint8Array | ArrayBuffer): string {
  const raw = new TextDecoder("latin1").decode(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  const out: string[] = [];

  // (string) Tj
  const tjRe = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  // [ (string) num (string) ] TJ
  const tjArrayRe = /\[((?:\((?:\\.|[^\\()])*\)|[^\]])*)\]\s*TJ/g;
  const strRe = /\((?:\\.|[^\\()])*\)/g;

  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(raw)) !== null) out.push(unescapePdfString(m[1]));
  while ((m = tjArrayRe.exec(raw)) !== null) {
    const parts = m[1].match(strRe) ?? [];
    out.push(parts.map((p) => unescapePdfString(p.slice(1, -1))).join(""));
  }
  return out.join("\n");
}

/** Collapse all whitespace — used to assert wrapped/hard-split strings survive intact. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, "");
}

/** Collapse runs of whitespace to single spaces and trim. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Count non-overlapping occurrences. */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Count /URI link annotations in the raw PDF. */
export function countUriAnnotations(bytes: Uint8Array): number {
  const raw = new TextDecoder("latin1").decode(bytes);
  return countOccurrences(raw, "/URI");
}
