// ── SitePulse PDF export ─────────────────────────────────────────────────────
// Builds a professional, branded, multi-page PDF from the EXACT saved scan
// document. This module is a pure function of its input: it never performs a
// scan, never fetches anything, and never invents missing data — anything the
// scan did not record is rendered as "not recorded" / "not verified", never as
// a fabricated value or a failure.
//
// Privacy: the cookie inventory, request/response headers, and any credential
// material are never rendered. Cookie identifiers and credential-looking
// strings that occur inside finding text are redacted before drawing.
//
// Output: standard PDF with vector (selectable) text, clickable URL links,
// per-page footers with page numbers, and explicit page breaks so nothing is
// clipped.

import { jsPDF } from "jspdf";

// ── Input types (structural subset of the saved scan document) ───────────────

export type PdfSeverity = "critical" | "warning" | "info";
export type PdfPriority = "critical" | "important" | "recommended" | "nice-to-have";
export type PdfFindingStatus = "fail" | "warning" | "unable-to-verify";
export type PdfMethod = "http" | "tls" | "browser";

export interface PdfFinding {
  category: string;
  severity: PdfSeverity;
  priority: PdfPriority;
  message: string;
  whyItMatters: string;
  /** Empty string when the saved finding has no evidence-supported fix. */
  howToFix: string;
  evidence?: string;
  evidenceUrl?: string;
  stage?: string;
  method?: PdfMethod;
  checkKey?: string;
  detectedAt?: number;
  confirmed?: boolean;
  status?: PdfFindingStatus;
}

export interface PdfCategoryChecks {
  score?: number;
  passed?: number;
  failed?: number;
  warnings?: number;
  notChecked?: number;
  applicable?: number;
  unverified?: number;
  notApplicable?: number;
  hasScore?: boolean;
  formula?: string;
  factors?: string[];
}

export interface PdfSummary {
  completeness: "complete" | "partial" | "blocked";
  limitations: string[];
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirects: number;
  redirectChain: string[];
  contentType?: string;
  durationMs: number;
  method: string;
  browserChecks: string;
  blocked: boolean;
  blockReason?: string;
  notHtml: boolean;
  incomplete: boolean;
  counts: {
    passed: number;
    failed: number;
    warnings: number;
    notApplicable: number;
    unverified: number;
    total: number;
  };
  categoryFormula: string;
  overallFormula: string;
  performanceBasis: string;
  overallScored: boolean;
}

export interface PdfCookie {
  // Used ONLY to redact cookie identifiers from free text — never rendered.
  name: string;
  domain?: string | null;
}

export interface PdfScanInput {
  url: string;
  finalUrl: string;
  status: number;
  redirects?: number;
  redirectChain?: string[];
  responseTime?: number;
  pageSizeFormatted?: string;
  title?: string;

  score: number;
  grade: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  betterThanPercent?: number;

  performanceScore?: number;
  seoScore?: number;
  securityScore?: number;
  accessibilityScore?: number;
  technicalHealthScore?: number;

  performanceChecks?: PdfCategoryChecks;
  seoChecks?: PdfCategoryChecks;
  securityChecks?: PdfCategoryChecks;
  accessibilityChecks?: PdfCategoryChecks;
  technicalHealthChecks?: PdfCategoryChecks;

  issues: PdfFinding[];
  topIssues?: PdfFinding[];
  quickWins?: Array<{ category: string; message: string; potentialGain: number; priority: PdfPriority }>;

  totalChecksCompleted?: number;
  totalPassed?: number;
  totalFailed?: number;
  totalWarnings?: number;
  totalUnverified?: number;
  totalNotApplicable?: number;
  overallScored?: boolean;
  summary?: PdfSummary;
  cookies?: PdfCookie[];

  scannedAt: number;
}

export interface PdfOptions {
  /** When the PDF is being generated (epoch ms). Defaults to Date.now(). */
  generatedAt?: number;
  /** Link back to the interactive report, rendered as a clickable link. */
  reportUrl?: string;
  /** Scan id shown in the closing block. */
  scanId?: string;
}

export interface PdfBuildResult {
  bytes: Uint8Array;
  pageCount: number;
  fileName: string;
}

// ── Design tokens (match the app's neo-brutal cream/ink/amber theme) ─────────

type RGB = [number, number, number];
const INK: RGB = [26, 26, 26];
const CREAM: RGB = [255, 251, 240];
const AMBER: RGB = [253, 230, 138];
const WHITE: RGB = [255, 255, 255];
const GRAY: RGB = [110, 110, 110];
const LIGHT_GRAY: RGB = [210, 206, 196];
const RED: RGB = [185, 28, 28];
const RED_BG: RGB = [254, 226, 226];
const AMBER_DARK: RGB = [180, 83, 9];
const AMBER_BG: RGB = [254, 243, 199];
const BLUE: RGB = [29, 78, 216];
const BLUE_BG: RGB = [219, 234, 254];
const GREEN: RGB = [4, 120, 87];
const GREEN_BG: RGB = [209, 250, 229];
const GRAY_BG: RGB = [243, 244, 246];

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN_L = 46;
const MARGIN_R = 46;
const MARGIN_T = 54;
const MARGIN_B = 54;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const BOTTOM = PAGE_H - MARGIN_B;

const CHIP_H = 13;
const CHIP_GAP = 4;

const CATEGORY_ORDER = ["Performance", "SEO", "Security", "Accessibility", "Technical Health"] as const;
const WEIGHT_LABELS: Record<string, string> = {
  Security: "30%",
  Performance: "25%",
  SEO: "25%",
  "Technical Health": "10%",
  Accessibility: "10%",
};
const PRIORITY_RANK: Record<PdfPriority, number> = { critical: 0, important: 1, recommended: 2, "nice-to-have": 3 };
const PRIORITY_LABEL: Record<PdfPriority, string> = {
  critical: "CRITICAL",
  important: "IMPORTANT",
  recommended: "RECOMMENDED",
  "nice-to-have": "NICE TO HAVE",
};
const SEVERITY_LABEL: Record<PdfSeverity, string> = { critical: "SEVERITY: CRITICAL", warning: "SEVERITY: WARNING", info: "SEVERITY: INFO" };
const SEVERITY_CHIP: Record<PdfSeverity, { bg: RGB; fg: RGB; border: RGB }> = {
  critical: { bg: RED_BG, fg: RED, border: RED },
  warning: { bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
  info: { bg: BLUE_BG, fg: BLUE, border: BLUE },
};
const PRIORITY_CHIP: Record<PdfPriority, { bg: RGB; fg: RGB; border: RGB }> = {
  critical: { bg: RED_BG, fg: RED, border: RED },
  important: { bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
  recommended: { bg: BLUE_BG, fg: BLUE, border: BLUE },
  "nice-to-have": { bg: GRAY_BG, fg: GRAY, border: GRAY },
};
const METHOD_LABEL: Record<string, string> = { http: "HTTP", tls: "TLS", browser: "Browser" };

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().slice(0, 10);
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname || "report"; } catch { return "report"; }
}

function safeFileName(scan: PdfScanInput, generatedAt: number): string {
  const host = hostnameOf(scan.finalUrl || scan.url).replace(/[^\w.-]+/g, "-") || "report";
  return `sitepulse-report-${host}-${fmtDate(generatedAt)}.pdf`;
}

/** True when a finding was directly observed (same rule the report page uses). */
function isConfirmed(f: PdfFinding): boolean {
  return (f.confirmed ?? true) && f.status !== "unable-to-verify";
}

function findingTrustLabel(f: PdfFinding): string {
  if (f.status === "unable-to-verify") return "UNABLE TO VERIFY";
  return isConfirmed(f) ? "CONFIRMED" : "POTENTIAL RISK";
}

const TRUST_CHIP: Record<string, { bg: RGB; fg: RGB; border: RGB }> = {
  CONFIRMED: { bg: GREEN_BG, fg: GREEN, border: GREEN },
  "POTENTIAL RISK": { bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
  "UNABLE TO VERIFY": { bg: GRAY_BG, fg: GRAY, border: GRAY },
};

// ── Sensitive-data redaction ─────────────────────────────────────────────────

/**
 * Builds a redactor that removes cookie identifiers (from the saved cookie
 * inventory) and credential-looking values from free text. Nothing else is
 * altered, so counts and findings still match the saved report.
 */
export function buildRedactor(scan: PdfScanInput): (s: string) => string {
  const literals: string[] = [];
  for (const c of scan.cookies ?? []) {
    if (c.name) {
      literals.push(`"${c.name}"`);
      if (c.name.length >= 5) literals.push(c.name);
    }
    if (c.domain) literals.push(`Domain=${c.domain}`);
  }
  // Note: bare cookie domains are NOT scrubbed — they are usually the scanned
  // host itself, which must stay visible. Only the cookie-specific "Domain=x"
  // form is redacted.
  const credentialRe =
    /(\b(?:authorization|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|token|secret|password|passwd|session[-_ ]?token|private[-_ ]?key)\b)\s*[:=]\s*(?:bearer\s+)?[^\s,;)]+/gi;
  const bearerRe = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
  return (s: string): string => {
    let out = String(s ?? "");
    for (const lit of literals) out = out.split(lit).join("[redacted]");
    out = out.replace(credentialRe, "$1: [redacted]");
    out = out.replace(bearerRe, "Bearer [redacted]");
    return out;
  };
}

// ── Low-level layout engine ──────────────────────────────────────────────────

type FontStyle = "normal" | "bold" | "italic";

interface TextOp {
  k: "text";
  lines: string[];
  x: number;
  size: number;
  style: FontStyle;
  color: RGB;
  lh: number;
  link?: string;
  keep?: number;
}
interface ChipSpec { text: string; bg: RGB; fg: RGB; border?: RGB; }
interface ChipsOp { k: "chips"; lines: ChipSpec[][]; x: number; keep?: number; }
interface GapOp { k: "gap"; h: number; keep?: number; }
interface RuleOp { k: "rule"; color: RGB; x: number; w: number; thick: number; keep?: number; }
interface ColsCell { ops: Op[]; x: number; w: number; }
interface ColsOp { k: "cols"; cells: ColsCell[]; h: number; keep?: number; }
type Op = TextOp | ChipsOp | GapOp | RuleOp | ColsOp;

interface RunBox { bg?: RGB; border?: RGB; padX?: number; padY?: number; }

function opHeight(op: Op): number {
  switch (op.k) {
    case "text": return op.lines.length * op.lh;
    case "chips": return op.lines.length * (CHIP_H + 3);
    case "gap": return op.h;
    case "rule": return op.thick + 4;
    case "cols": return op.h;
  }
}

interface Engine {
  doc: jsPDF;
  y: number;
  redact: (s: string) => string;
}

function setFont(doc: jsPDF, style: FontStyle, size: number): void {
  doc.setFont("helvetica", style);
  doc.setFontSize(size);
}

function textWidth(doc: jsPDF, text: string, style: FontStyle, size: number): number {
  setFont(doc, style, size);
  return doc.getTextWidth(text);
}

/** Split a single over-long token (e.g. a very long URL) at sensible break points. */
function splitLongToken(doc: jsPDF, token: string, width: number, style: FontStyle, size: number): string[] {
  const fits = (s: string) => textWidth(doc, s, style, size) <= width;
  const parts: string[] = [];
  let rest = token;
  while (!fits(rest) && rest.length > 1) {
    // Binary search for the largest prefix that fits.
    let lo = 1;
    let hi = rest.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(rest.slice(0, mid))) lo = mid;
      else hi = mid - 1;
    }
    let cut = Math.max(1, lo);
    // Prefer a break right after a URL-ish separator inside that prefix.
    for (let i = cut; i > 1; i--) {
      if ("/?&=_-.~%".includes(rest[i - 1])) { cut = i; break; }
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/** Word-wrap that never clips: long tokens are hard-split. */
function wrapText(doc: jsPDF, text: string, width: number, style: FontStyle, size: number): string[] {
  const out: string[] = [];
  const paragraphs = String(text ?? "").split(/\r?\n/);
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const word of words) {
      const pieces = textWidth(doc, word, style, size) > width
        ? splitLongToken(doc, word, width, style, size)
        : [word];
      for (const piece of pieces) {
        const cand = line ? `${line} ${piece}` : piece;
        if (!line || textWidth(doc, cand, style, size) <= width) line = cand;
        else { out.push(line); line = piece; }
      }
    }
    if (line) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

function maxLinesPerPage(lh: number): number {
  return Math.max(1, Math.floor((BOTTOM - MARGIN_T) / lh));
}

// ── Op factories ─────────────────────────────────────────────────────────────

function mkText(
  eng: Engine, text: string,
  o: { size: number; style?: FontStyle; color?: RGB; x?: number; link?: string; keep?: number; width?: number },
): TextOp[] {
  const size = o.size;
  const style = o.style ?? "normal";
  const lh = Math.round(size * 1.38 * 10) / 10;
  const x = o.x ?? MARGIN_L;
  const width = o.width ?? PAGE_W - x - MARGIN_R;
  const lines = wrapText(eng.doc, eng.redact(text), width, style, size);
  const chunk = maxLinesPerPage(lh);
  const ops: TextOp[] = [];
  for (let i = 0; i < lines.length; i += chunk) {
    ops.push({
      k: "text",
      lines: lines.slice(i, i + chunk),
      x, size, style, color: o.color ?? INK, lh,
      link: o.link,
      keep: i === 0 ? o.keep : undefined,
    });
  }
  return ops;
}

function mkChips(eng: Engine, chips: ChipSpec[], o: { x?: number; keep?: number } = {}): ChipsOp {
  const x = o.x ?? MARGIN_L;
  const lines: ChipSpec[][] = [];
  let cur: ChipSpec[] = [];
  let curW = 0;
  for (const chip of chips) {
    setFont(eng.doc, "bold", 7.5);
    const w = eng.doc.getTextWidth(chip.text) + 9;
    if (cur.length > 0 && curW + w + CHIP_GAP > CONTENT_W - (x - MARGIN_L)) {
      lines.push(cur); cur = []; curW = 0;
    }
    cur.push(chip); curW += w + CHIP_GAP;
  }
  if (cur.length > 0) lines.push(cur);
  if (lines.length === 0) lines.push([]);
  return { k: "chips", lines, x, keep: o.keep };
}

function mkGap(h: number): GapOp { return { k: "gap", h }; }
function mkRule(color: RGB = LIGHT_GRAY, thick = 0.7, x = MARGIN_L, w = CONTENT_W): RuleOp {
  return { k: "rule", color, x, w, thick };
}

function mkCols(eng: Engine, cells: Array<{ ops: Op[]; w: number }>, o: { gap?: number; keep?: number } = {}): ColsOp {
  const gap = o.gap ?? 12;
  const totalGaps = (cells.length - 1) * gap;
  const usable = CONTENT_W - totalGaps;
  const widthSum = cells.reduce((a, c) => a + c.w, 0);
  const scale = widthSum > 0 ? usable / widthSum : 1;
  let x = MARGIN_L;
  const placed: ColsCell[] = [];
  for (const c of cells) {
    const w = c.w * scale;
    placed.push({ ops: c.ops, x, w });
    x += w + gap;
  }
  const h = Math.max(0, ...cells.map((c) => c.ops.reduce((a, op) => a + opHeight(op), 0)));
  return { k: "cols", cells: placed, h, keep: o.keep };
}

// ── Drawing ──────────────────────────────────────────────────────────────────

function drawChipLine(doc: jsPDF, chips: ChipSpec[], x: number, yTop: number): void {
  let cx = x;
  for (const chip of chips) {
    setFont(doc, "bold", 7.5);
    const w = doc.getTextWidth(chip.text) + 9;
    doc.setFillColor(chip.bg[0], chip.bg[1], chip.bg[2]);
    doc.rect(cx, yTop, w, CHIP_H, "F");
    if (chip.border) {
      doc.setDrawColor(chip.border[0], chip.border[1], chip.border[2]);
      doc.setLineWidth(0.6);
      doc.rect(cx + 0.3, yTop + 0.3, w - 0.6, CHIP_H - 0.6);
    }
    doc.setTextColor(chip.fg[0], chip.fg[1], chip.fg[2]);
    doc.text(chip.text, cx + 4.5, yTop + CHIP_H - 3.8);
    cx += w + CHIP_GAP;
  }
}

function drawOp(doc: jsPDF, op: Op, y: number): void {
  switch (op.k) {
    case "text": {
      doc.setTextColor(op.color[0], op.color[1], op.color[2]);
      for (let i = 0; i < op.lines.length; i++) {
        const baseline = y + i * op.lh + op.size * 0.84;
        const line = op.lines[i];
        if (line === "") continue;
        setFont(doc, op.style, op.size);
        if (op.link) doc.textWithLink(line, op.x, baseline, { url: op.link });
        else doc.text(line, op.x, baseline);
      }
      break;
    }
    case "chips":
      for (let i = 0; i < op.lines.length; i++) drawChipLine(doc, op.lines[i], op.x, y + i * (CHIP_H + 3));
      break;
    case "rule":
      doc.setDrawColor(op.color[0], op.color[1], op.color[2]);
      doc.setLineWidth(op.thick);
      doc.line(op.x, y + op.thick, op.x + op.w, y + op.thick);
      break;
    case "cols":
      for (const cell of op.cells) {
        let cy = y;
        for (const inner of cell.ops) {
          drawOp(doc, { ...inner, x: ("x" in inner ? inner.x : 0) + cell.x } as Op, cy);
          cy += opHeight(inner);
        }
      }
      break;
    case "gap":
      break;
  }
}

/**
 * Runs ops down the page with explicit page breaks, optionally drawing a
 * background/border box behind each page-segment of the run (so a boxed block
 * that crosses a page break renders as two complete boxes — never clipped).
 * Returns nothing; advances eng.y.
 */
function runOps(eng: Engine, ops: Op[], box?: RunBox): void {
  const doc = eng.doc;
  interface Run { page: number; y0: number; y1: number; items: Array<{ op: Op; y: number }>; }

  // Pass 1 — simulate placement.
  const runs: Run[] = [];
  let page = doc.getCurrentPageInfo().pageNumber;
  let y = eng.y;
  let cur: Run | null = null;
  for (const op of ops) {
    const h = opHeight(op);
    const need = h + (op.keep ?? 0);
    if (y + need > BOTTOM + 0.01) {
      page += 1;
      y = MARGIN_T;
      cur = null;
    }
    if (!cur || cur.page !== page) {
      cur = { page, y0: y, y1: y, items: [] };
      runs.push(cur);
    }
    cur.items.push({ op, y });
    y += h;
    cur.y1 = y;
  }

  // Make sure every simulated page physically exists.
  while (doc.getNumberOfPages() < page) doc.addPage();

  // Pass 2 — draw.
  const padY = box?.padY ?? 7;
  let lastPage = doc.getCurrentPageInfo().pageNumber;
  for (const run of runs) {
    if (run.page !== lastPage) { doc.setPage(run.page); lastPage = run.page; }
    if (box && run.items.length > 0) {
      const top = run.y0 - padY;
      const h = run.y1 + padY - top;
      if (box.bg) {
        doc.setFillColor(box.bg[0], box.bg[1], box.bg[2]);
        doc.rect(MARGIN_L, top, CONTENT_W, h, "F");
      }
      if (box.border) {
        doc.setDrawColor(box.border[0], box.border[1], box.border[2]);
        doc.setLineWidth(1);
        doc.rect(MARGIN_L + 0.5, top + 0.5, CONTENT_W - 1, h - 1);
      }
    }
    for (const item of run.items) drawOp(doc, item.op, item.y);
  }
  eng.y = y;
}

// ── Compose helpers (label/value, headings, boxes) ───────────────────────────

function heading(eng: Engine, title: string): Op[] {
  return [
    mkGap(10),
    ...mkText(eng, title, { size: 15, style: "bold", keep: 34 }),
    mkGap(3),
    mkRule(INK, 1.4),
    mkGap(7),
  ];
}

function subheading(eng: Engine, title: string): Op[] {
  return [mkGap(6), ...mkText(eng, title, { size: 11, style: "bold", keep: 22 }), mkGap(2)];
}

function field(
  eng: Engine, label: string, value: string,
  o: { link?: string; color?: RGB; size?: number; width?: number } = {},
): Op[] {
  const size = o.size ?? 9.5;
  return [
    ...mkText(eng, label.toUpperCase(), { size: 7.5, style: "bold", color: GRAY, width: o.width, keep: size * 1.38 + 3 }),
    ...mkText(eng, value, { size, style: "bold", color: o.color ?? INK, link: o.link, width: o.width }),
  ];
}

function para(eng: Engine, text: string, o: { size?: number; style?: FontStyle; color?: RGB; keep?: number } = {}): Op[] {
  return mkText(eng, text, { size: o.size ?? 9, style: o.style ?? "normal", color: o.color ?? INK, keep: o.keep ?? 20 });
}

function bullets(eng: Engine, items: string[]): Op[] {
  const ops: Op[] = [];
  for (const item of items) {
    const lines = wrapText(eng.doc, eng.redact(item), CONTENT_W - 14, "normal", 9);
    ops.push(...mkText(eng, `• ${lines[0]}`, { size: 9, keep: 16 }));
    for (let i = 1; i < lines.length; i++) ops.push(...mkText(eng, lines[i], { size: 9, x: MARGIN_L + 12, width: CONTENT_W - 12 }));
    ops.push(mkGap(2));
  }
  return ops;
}

// ── Section composers ────────────────────────────────────────────────────────

function countsFor(scan: PdfScanInput): {
  passed: number; failed: number; warnings: number; notApplicable: number; unverified: number; total: number;
} {
  const s = scan.summary;
  if (s) {
    return {
      passed: s.counts.passed, failed: s.counts.failed, warnings: s.counts.warnings,
      notApplicable: s.counts.notApplicable, unverified: s.counts.unverified, total: s.counts.total,
    };
  }
  return {
    passed: scan.totalPassed ?? 0,
    failed: scan.totalFailed ?? 0,
    warnings: scan.totalWarnings ?? 0,
    notApplicable: scan.totalNotApplicable ?? 0,
    unverified: scan.totalUnverified ?? 0,
    total: scan.totalChecksCompleted ?? 0,
  };
}

function categoryData(scan: PdfScanInput) {
  const pick = (score: number | undefined, checks: PdfCategoryChecks | undefined) => ({
    score: score ?? checks?.score ?? 0,
    hasScore: checks?.hasScore ?? true,
    passed: checks?.passed ?? 0,
    failed: checks?.failed ?? 0,
    warnings: checks?.warnings ?? 0,
    unverified: checks?.unverified ?? checks?.notChecked ?? 0,
    notApplicable: checks?.notApplicable ?? 0,
    factors: checks?.factors ?? [],
    formula: checks?.formula,
  });
  return {
    Performance: pick(scan.performanceScore, scan.performanceChecks),
    SEO: pick(scan.seoScore, scan.seoChecks),
    Security: pick(scan.securityScore, scan.securityChecks),
    Accessibility: pick(scan.accessibilityScore, scan.accessibilityChecks),
    "Technical Health": pick(scan.technicalHealthScore, scan.technicalHealthChecks),
  } as Record<string, ReturnType<typeof pick>>;
}

function composeCover(eng: Engine, scan: PdfScanInput, opts: PdfOptions, generatedAt: number): void {
  const summary = scan.summary;

  // Brand band
  runOps(eng, [
    ...mkText(eng, "SitePulse", { size: 24, style: "bold", color: WHITE }),
    mkGap(2),
    ...mkText(eng, "WEBSITE HEALTH REPORT", { size: 10, style: "bold", color: AMBER }),
    mkGap(2),
    ...mkText(eng, `Report generated ${fmtDateTime(generatedAt)}  ·  Scan performed ${fmtDateTime(scan.scannedAt)}`, { size: 8.5, color: [230, 230, 230] }),
  ], { bg: INK, border: AMBER, padX: 14, padY: 13 });

  runOps(eng, [mkGap(6)]);

  if (opts.reportUrl) {
    runOps(eng, [
      ...mkText(eng, "View the interactive report:", { size: 8.5, style: "bold", color: GRAY, keep: 14 }),
      ...mkText(eng, opts.reportUrl, { size: 8.5, style: "bold", color: BLUE, link: opts.reportUrl }),
      mkGap(2),
    ]);
  }

  // Completeness notice — blocked/partial scans must be obvious.
  const completeness = summary?.completeness;
  if (completeness && completeness !== "complete") {
    const label = completeness === "blocked" ? "SCAN BLOCKED" : "PARTIAL SCAN";
    const reason = summary?.blockReason
      ? summary.blockReason
      : completeness === "blocked"
        ? "The target refused or challenge-protected the scan request."
        : "Some checks could not be completed for this target.";
    runOps(eng, [
      ...mkText(eng, label, { size: 9, style: "bold", color: AMBER_DARK, keep: 15 }),
      ...mkText(eng, reason, { size: 9, color: INK }),
      mkGap(1),
      ...mkText(eng, "Checks that could not be verified are reported as Unable to Verify — never as failures.", { size: 8.5, style: "italic", color: INK }),
    ], { bg: AMBER_BG, border: AMBER_DARK, padX: 10, padY: 8 });
    runOps(eng, [mkGap(4)]);
  }

  // Target details (2-column grid)
  const requestedUrl = summary?.requestedUrl ?? scan.url;
  const finalUrl = summary?.finalUrl ?? scan.finalUrl;
  const redirects = summary?.redirects ?? scan.redirects ?? 0;
  const status = summary?.status ?? scan.status;
  const method = summary?.method === "http" || !summary?.method ? "HTTP (server-side request)" : summary.method;
  const chain = summary?.redirectChain ?? scan.redirectChain ?? [];

  const halfW = (CONTENT_W - 16) / 2;
  const row = (a: Op[], b: Op[]) => runOps(eng, [mkCols(eng, [{ ops: a, w: 1 }, { ops: b, w: 1 }], { gap: 16, keep: 26 })]);

  row(
    field(eng, "Requested URL", requestedUrl, { link: /^https?:/i.test(requestedUrl) ? requestedUrl : undefined, width: halfW }),
    field(eng, "Final URL (after redirects)", finalUrl, { link: /^https?:/i.test(finalUrl) ? finalUrl : undefined, width: halfW }),
  );
  runOps(eng, [mkGap(7)]);
  row(
    field(eng, "HTTP status", `HTTP ${status}${redirects > 0 ? `  ·  ${redirects} redirect${redirects === 1 ? "" : "s"}` : ""}`,
      { color: status >= 200 && status < 400 ? GREEN : RED, width: halfW }),
    field(eng, "Scan completeness", completeness
      ? completeness === "complete" ? "Complete" : completeness === "blocked" ? "Blocked" : "Partial"
      : "Saved before evidence tracking", { width: halfW }),
  );
  runOps(eng, [mkGap(7)]);
  row(
    field(eng, "Detection method", method, { width: halfW }),
    field(eng, "Content type · duration", `${summary?.contentType ?? "not recorded"} · ${summary?.durationMs ?? scan.responseTime ?? "not recorded"} ms`, { width: halfW }),
  );
  runOps(eng, [mkGap(7)]);

  // Redirect chain — every hop rendered (and clickable), nothing truncated.
  if (chain.length > 0 || redirects > 0) {
    const hops = chain.length > 0 ? [...chain, finalUrl] : [requestedUrl, finalUrl];
    const seen = new Set<string>();
    const uniqueHops = hops.filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
    runOps(eng, [
      ...mkText(eng, "REDIRECT CHAIN", { size: 7.5, style: "bold", color: GRAY, keep: 15 }),
      ...uniqueHops.flatMap((hop, i) =>
        mkText(eng, `${i + 1}. ${hop}`, {
          size: 8.5, style: "bold", color: /^https?:/i.test(hop) ? BLUE : INK,
          link: /^https?:/i.test(hop) ? hop : undefined, keep: i === 0 ? 14 : undefined,
        }),
      ),
      mkGap(2),
    ]);
  }

  // Overall score band
  const overallScored = scan.overallScored ?? summary?.overallScored ?? true;
  const scoreText = overallScored ? `${scan.score}/100` : "—";
  const chips: ChipSpec[] = [];
  if (overallScored && scan.grade) chips.push({ text: `GRADE ${scan.grade}`, bg: AMBER, fg: INK, border: INK });
  if (scan.riskLevel) chips.push({ text: `${scan.riskLevel.toUpperCase()} RISK`, bg: WHITE, fg: INK, border: INK });
  if (scan.betterThanPercent) chips.push({ text: `BETTER THAN ${scan.betterThanPercent}% OF SCANNED SITES`, bg: WHITE, fg: GRAY, border: LIGHT_GRAY });

  runOps(eng, [
    ...mkText(eng, "OVERALL HEALTH SCORE", { size: 8, style: "bold", color: GRAY, keep: 42 }),
    ...mkText(eng, scoreText, { size: overallScored ? 34 : 26, style: "bold", color: INK }),
    ...(overallScored ? [] : mkText(eng, "Not enough verified checks to produce a score — no data, no score.", { size: 9, style: "italic", color: AMBER_DARK })),
    ...(chips.length > 0 ? [mkGap(5), mkChips(eng, chips)] : []),
    mkGap(2),
    ...mkText(eng, summary?.overallFormula ?? "Overall: legacy weighted formula (saved before evidence tracking).", { size: 8, style: "italic", color: GRAY }),
  ], { bg: CREAM, border: INK, padX: 12, padY: 10 });
  runOps(eng, [mkGap(6)]);

  // Check outcome counts (from saved data only)
  const counts = countsFor(scan);
  runOps(eng, [
    ...mkText(eng, "CHECK OUTCOMES (as saved)", { size: 8, style: "bold", color: GRAY, keep: 18 }),
    mkChips(eng, [
      { text: `PASSED ${counts.passed}`, bg: GREEN_BG, fg: GREEN, border: GREEN },
      { text: `FAILED ${counts.failed}`, bg: RED_BG, fg: RED, border: RED },
      { text: `WARNINGS ${counts.warnings}`, bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
      { text: `NOT APPLICABLE ${counts.notApplicable}`, bg: GRAY_BG, fg: GRAY, border: GRAY },
      { text: `UNABLE TO VERIFY ${counts.unverified}`, bg: GRAY_BG, fg: GRAY, border: GRAY },
      { text: `TOTAL CHECKS ${counts.total}`, bg: WHITE, fg: INK, border: INK },
    ]),
    mkGap(3),
    ...mkText(eng, "Only Passed/Failed/Warnings count toward scores. Unable to Verify and Not Applicable never count as failures.", { size: 8, style: "italic", color: GRAY }),
  ]);

  // Findings overview
  const issues = scan.issues ?? [];
  const confirmed = issues.filter(isConfirmed).length;
  const utv = issues.filter((f) => f.status === "unable-to-verify").length;
  const potential = issues.length - confirmed;
  runOps(eng, [mkGap(6)]);
  runOps(eng, [
    ...mkText(eng, "FINDINGS OVERVIEW", { size: 8, style: "bold", color: GRAY, keep: 18 }),
    mkChips(eng, [
      { text: `${issues.length} FINDING${issues.length === 1 ? "" : "S"}`, bg: WHITE, fg: INK, border: INK },
      { text: `${confirmed} CONFIRMED`, bg: GREEN_BG, fg: GREEN, border: GREEN },
      { text: `${potential} POTENTIAL`, bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
      ...(utv > 0 ? [{ text: `${utv} UNABLE TO VERIFY`, bg: GRAY_BG, fg: GRAY, border: GRAY }] : []),
    ]),
    mkGap(3),
    ...mkText(eng, "Confirmed = directly observed evidence. Potential = inferred risk or not yet verified — not a confirmed failure.", { size: 8, style: "italic", color: GRAY }),
  ]);

  // Category score table
  const cats = categoryData(scan);
  runOps(eng, heading(eng, "Category Scores"));
  const colWidths = [150, 54, 46, 46, 46, 48, 48, 65];
  const headerRow = mkCols(eng, ["CATEGORY", "SCORE", "PASS", "FAIL", "WARN", "N/A", "UTV", "WEIGHT"].map((t, i) => ({
    ops: mkText(eng, t, { size: 7.5, style: "bold", color: GRAY, x: MARGIN_L, width: colWidths[i] }),
    w: colWidths[i],
  })), { gap: 0 });
  runOps(eng, [headerRow, mkRule(INK, 1), mkGap(3)]);

  for (const cat of CATEGORY_ORDER) {
    const c = cats[cat];
    const cells = [
      { ops: mkText(eng, cat, { size: 9, style: "bold", width: colWidths[0] }), w: colWidths[0] },
      { ops: mkText(eng, c.hasScore ? `${c.score}` : "—", { size: 10, style: "bold", width: colWidths[1] }), w: colWidths[1] },
      { ops: mkText(eng, `${c.passed}`, { size: 9, width: colWidths[2] }), w: colWidths[2] },
      { ops: mkText(eng, `${c.failed}`, { size: 9, width: colWidths[3], color: c.failed > 0 ? RED : INK }), w: colWidths[3] },
      { ops: mkText(eng, `${c.warnings}`, { size: 9, width: colWidths[4], color: c.warnings > 0 ? AMBER_DARK : INK }), w: colWidths[4] },
      { ops: mkText(eng, `${c.notApplicable}`, { size: 9, width: colWidths[5] }), w: colWidths[5] },
      { ops: mkText(eng, `${c.unverified}`, { size: 9, width: colWidths[6] }), w: colWidths[6] },
      { ops: mkText(eng, WEIGHT_LABELS[cat] ?? "", { size: 9, width: colWidths[7] }), w: colWidths[7] },
    ];
    runOps(eng, [mkCols(eng, cells, { gap: 0 }), mkRule(LIGHT_GRAY, 0.6), mkGap(3)]);
  }
  runOps(eng, [
    ...mkText(eng, "N/A = Not Applicable · UTV = Unable to Verify (both excluded from scoring). A “—” means too few verified checks for a score.", { size: 8, style: "italic", color: GRAY }),
  ]);
}

function composeActionPlan(eng: Engine, scan: PdfScanInput): void {
  const issues = [...(scan.issues ?? [])].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  runOps(eng, heading(eng, "Prioritized Action Plan"));
  if (issues.length === 0) {
    runOps(eng, [
      ...para(eng, "No findings were recorded for this scan, so there is nothing to fix from this report. Re-run a scan after making changes to track new results."),
    ]);
  } else {
    runOps(eng, [
      ...para(eng, `Ordered by priority — ${issues.length} item${issues.length === 1 ? "" : "s"} drawn from the saved findings of this scan. Fixes are shown only where the evidence supports one.`, { color: GRAY, size: 8.5 }),
      mkGap(4),
    ]);
    let n = 0;
    for (const f of issues) {
      n += 1;
      const trust = findingTrustLabel(f);
      const ops: Op[] = [
        mkChips(eng, [
          { text: `${n}. ${PRIORITY_LABEL[f.priority]}`, ...PRIORITY_CHIP[f.priority] },
          { text: f.category.toUpperCase(), bg: WHITE, fg: INK, border: INK },
          { text: trust, ...TRUST_CHIP[trust] },
        ], { keep: 16 }),
        mkGap(2),
        ...mkText(eng, f.message, { size: 9.5, style: "bold", keep: f.howToFix ? 30 : 14 }),
      ];
      if (f.howToFix) {
        ops.push(
          ...mkText(eng, "FIX", { size: 7.5, style: "bold", color: GREEN, keep: 15 }),
          ...mkText(eng, f.howToFix, { size: 9 }),
          mkGap(2),
        );
      }
      runOps(eng, ops, { bg: CREAM, border: LIGHT_GRAY, padX: 9, padY: 7 });
      runOps(eng, [mkGap(5)]);
    }
  }

  const quickWins = scan.quickWins ?? [];
  if (quickWins.length > 0) {
    runOps(eng, subheading(eng, "Quick wins (low effort, score gain)"));
    for (const qw of quickWins) {
      runOps(eng, [
        mkChips(eng, [
          { text: qw.category.toUpperCase(), bg: WHITE, fg: INK, border: INK },
          { text: `+${qw.potentialGain} PTS POTENTIAL`, bg: GREEN_BG, fg: GREEN, border: GREEN },
        ], { keep: 15 }),
        mkGap(2),
        ...mkText(eng, qw.message, { size: 9, keep: 16 }),
      ], { bg: CREAM, border: LIGHT_GRAY, padX: 9, padY: 7 });
      runOps(eng, [mkGap(4)]);
    }
  }
}

function composeFindings(eng: Engine, scan: PdfScanInput): void {
  const issues = scan.issues ?? [];
  const confirmed = issues.filter(isConfirmed).length;
  const utv = issues.filter((f) => f.status === "unable-to-verify").length;
  const potential = issues.length - confirmed;

  runOps(eng, heading(eng, `Findings (${issues.length})`));
  if (issues.length === 0) {
    runOps(eng, [
      ...para(eng, "No findings recorded for this scan. Checks that passed are not listed individually — see the Category Scores and Check Outcomes above.", { color: GRAY }),
    ]);
    return;
  }
  runOps(eng, [
    mkChips(eng, [
      { text: `${confirmed} CONFIRMED`, bg: GREEN_BG, fg: GREEN, border: GREEN },
      { text: `${potential} POTENTIAL`, bg: AMBER_BG, fg: AMBER_DARK, border: AMBER_DARK },
      ...(utv > 0 ? [{ text: `OF WHICH ${utv} UNABLE TO VERIFY`, bg: GRAY_BG, fg: GRAY, border: GRAY }] : []),
    ]),
    mkGap(3),
    ...para(eng, "Every finding below is reproduced from the saved scan result with its evidence, detection method and status. Unverified checks are labelled and never shown as confirmed failures.", { size: 8.5, color: GRAY }),
    mkGap(5),
  ]);

  let n = 0;
  for (const f of issues) {
    n += 1;
    const trust = findingTrustLabel(f);
    const affectedUrl = f.evidenceUrl || scan.summary?.finalUrl || scan.finalUrl;
    const ops: Op[] = [
      mkChips(eng, [
        { text: `#${n}`, bg: INK, fg: WHITE },
        { text: SEVERITY_LABEL[f.severity], ...SEVERITY_CHIP[f.severity] },
        { text: PRIORITY_LABEL[f.priority], ...PRIORITY_CHIP[f.priority] },
        { text: trust, ...TRUST_CHIP[trust] },
      ], { keep: 18 }),
      mkGap(3),
      ...mkText(eng, f.message, { size: 10.5, style: "bold", keep: 18 }),
      mkGap(1),
      ...mkText(eng, `${f.category}${f.checkKey ? ` · ${f.checkKey}` : ""}`, { size: 8, style: "bold", color: GRAY, keep: 14 }),
      mkGap(2),
      ...field(eng, "Affected URL", affectedUrl, { link: /^https?:/i.test(affectedUrl) ? affectedUrl : undefined, size: 8.5 }),
      mkGap(3),
      ...mkText(eng, "EVIDENCE", { size: 7.5, style: "bold", color: BLUE, keep: 15 }),
      ...mkText(eng, f.evidence || "Not recorded — this finding was saved before evidence tracking was added.", {
        size: 9, color: f.evidence ? INK : GRAY, style: f.evidence ? "normal" : "italic",
      }),
      mkGap(2),
      ...mkText(eng, [
        f.method ? `Method: ${METHOD_LABEL[f.method] ?? f.method}` : null,
        f.stage ? `Stage: ${f.stage}` : null,
        f.detectedAt ? `Collected: ${fmtDateTime(f.detectedAt)}` : null,
      ].filter(Boolean).join("  ·  ") || "Method/stage not recorded for this legacy finding.", { size: 7.5, color: GRAY, keep: 15 }),
      mkGap(3),
      ...mkText(eng, "WHY IT MATTERS", { size: 7.5, style: "bold", color: AMBER_DARK, keep: 15 }),
      ...mkText(eng, f.whyItMatters || "Not recorded.", { size: 9 }),
    ];
    if (f.howToFix) {
      ops.push(
        mkGap(3),
        ...mkText(eng, "RECOMMENDED FIX", { size: 7.5, style: "bold", color: GREEN, keep: 15 }),
        ...mkText(eng, f.howToFix, { size: 9 }),
      );
    }
    runOps(eng, ops, { bg: CREAM, border: INK, padX: 10, padY: 9 });
    runOps(eng, [mkGap(7)]);
  }
}

function composeMethodology(eng: Engine, scan: PdfScanInput, opts: PdfOptions, generatedAt: number): void {
  const summary = scan.summary;
  runOps(eng, heading(eng, "Methodology, Limitations & Disclaimer"));

  const method = summary?.method === "http" || !summary?.method ? "HTTP (server-side request)" : summary.method;
  runOps(eng, subheading(eng, "How this scan works"));
  runOps(eng, para(
    eng,
    `SitePulse connects to the target from a server-side controlled HTTP client, records the requested URL, redirect chain, final URL, HTTP status, response headers, content type and duration, then analyzes the final response body against established web standards. Detection method used: ${method}. ${summary?.browserChecks ?? "Browser-engine checks were not recorded for this report."}`,
  ));

  runOps(eng, subheading(eng, "Scoring methodology"));
  const cats = categoryData(scan);
  runOps(eng, para(eng, `Category scores: ${summary?.categoryFormula ?? "legacy weighted formula (saved before evidence tracking)."}`));
  runOps(eng, para(eng, `Overall score: ${summary?.overallFormula ?? "legacy weighted formula (saved before evidence tracking)."} Category weights: Security 30%, Performance 25%, SEO 25%, Technical Health 10%, Accessibility 10%.`));
  runOps(eng, para(eng, `Performance basis: ${summary?.performanceBasis ?? "HTTP response timing (server-side request) — not a browser lab test."}`));
  const formulaLines = CATEGORY_ORDER
    .map((cat) => ({ cat, c: cats[cat] }))
    .filter(({ c }) => Boolean(c.formula))
    .map(({ cat, c }) => `${cat} formula: ${c.formula}`);
  if (formulaLines.length > 0) runOps(eng, bullets(eng, formulaLines));
  const factorLines = CATEGORY_ORDER
    .map((cat) => ({ cat, c: cats[cat] }))
    .filter(({ c }) => c.factors.length > 0)
    .map(({ cat, c }) => `${cat}: ${c.factors.join(" · ")}`);
  if (factorLines.length > 0) runOps(eng, bullets(eng, factorLines));
  runOps(eng, para(eng, "Only checks evaluated against observed evidence count toward a score. Checks that are Unable to Verify or Not Applicable are excluded entirely — they neither help nor hurt — so incomplete data can never produce a 0/100.", { size: 8.5, style: "italic", color: GRAY }));

  runOps(eng, subheading(eng, "Limitations"));
  const limitations = summary?.limitations ?? [
    "Saved before evidence tracking: this report predates per-finding evidence records, so some evidence and method fields are not available.",
    "No browser engine was available for this scan: JavaScript-rendered DOM checks and lab performance metrics were not performed and are never guessed.",
  ];
  runOps(eng, bullets(eng, limitations));

  // The required, explicit security disclaimer.
  runOps(eng, [
    ...mkText(eng, "IMPORTANT — SECURITY DISCLAIMER", { size: 8.5, style: "bold", color: AMBER_DARK, keep: 16 }),
    ...mkText(eng, "An HTTP scan cannot prove a website is completely secure. It only reports the specific configuration evidence observed at scan time. Issues outside the scope of HTTP-level checks — server compromise, application logic flaws, account takeover risk, injection attacks that require authenticated input, DDoS readiness and more — are not covered. A clean report is not a security certification, and an unverified check is never a confirmed failure.", { size: 9, keep: 20 }),
  ], { bg: AMBER_BG, border: AMBER_DARK, padX: 10, padY: 9 });

  runOps(eng, [mkGap(5)]);
  runOps(eng, para(
    eng,
    "Privacy: this PDF contains no cookies, authentication tokens, API keys, private credentials or request headers — the scan never collects them. Cookie identifiers observed in evidence text are redacted above. Only publicly accessible responses are analyzed; nothing is submitted to the target and nothing on the target is modified.",
    { size: 8.5, color: GRAY },
  ));

  runOps(eng, [mkGap(6), mkRule(LIGHT_GRAY, 0.7), mkGap(3)]);
  runOps(eng, para(
    eng,
    `Generated by SitePulse · ${fmtDateTime(generatedAt)}${opts.scanId ? ` · Scan ID: ${opts.scanId}` : ""} · Source: saved scan result from ${fmtDateTime(scan.scannedAt)}`,
    { size: 8, color: GRAY },
  ));
}

// ── Page furniture (headers + footers with page numbers) ─────────────────────

function drawPageFurniture(doc: jsPDF, scan: PdfScanInput, generatedAt: number): void {
  const pages = doc.getNumberOfPages();
  const host = hostnameOf(scan.summary?.finalUrl || scan.finalUrl || scan.url);
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    if (p > 1) {
      doc.setTextColor(GRAY[0], GRAY[1], GRAY[2]);
      setFont(doc, "bold", 8);
      doc.text("SitePulse · Website Health Report", MARGIN_L, MARGIN_T - 16);
      doc.setTextColor(GRAY[0], GRAY[1], GRAY[2]);
      setFont(doc, "normal", 8);
      const right = host;
      doc.text(right, PAGE_W - MARGIN_R - doc.getTextWidth(right), MARGIN_T - 16);
      doc.setDrawColor(LIGHT_GRAY[0], LIGHT_GRAY[1], LIGHT_GRAY[2]);
      doc.setLineWidth(0.7);
      doc.line(MARGIN_L, MARGIN_T - 10, PAGE_W - MARGIN_R, MARGIN_T - 10);
    }
    // Footer
    doc.setDrawColor(LIGHT_GRAY[0], LIGHT_GRAY[1], LIGHT_GRAY[2]);
    doc.setLineWidth(0.7);
    doc.line(MARGIN_L, PAGE_H - MARGIN_B + 14, PAGE_W - MARGIN_R, PAGE_H - MARGIN_B + 14);
    doc.setTextColor(GRAY[0], GRAY[1], GRAY[2]);
    setFont(doc, "normal", 7.5);
    doc.text(`SitePulse — free website health checker · Generated ${fmtDateTime(generatedAt)}`, MARGIN_L, PAGE_H - MARGIN_B + 26);
    const pageLabel = `Page ${p} of ${pages}`;
    setFont(doc, "bold", 7.5);
    doc.text(pageLabel, PAGE_W - MARGIN_R - doc.getTextWidth(pageLabel), PAGE_H - MARGIN_B + 26);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the PDF for a saved scan. Pure and synchronous: no network, no
 * re-scan — the output is a rendering of `scan` exactly as saved (with
 * sensitive identifiers redacted).
 */
export function buildScanPdf(scan: PdfScanInput, opts: PdfOptions = {}): PdfBuildResult {
  const generatedAt = opts.generatedAt ?? Date.now();
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: false });

  const host = hostnameOf(scan.summary?.finalUrl || scan.finalUrl || scan.url);
  doc.setProperties({
    title: `SitePulse Website Health Report - ${host}`,
    subject: `Website health report for ${scan.summary?.requestedUrl ?? scan.url}`,
    creator: "SitePulse",
    author: "SitePulse",
  });

  const eng: Engine = { doc, y: MARGIN_T, redact: buildRedactor(scan) };

  // Everything before page furniture:
  composeCover(eng, scan, opts, generatedAt);
  composeActionPlan(eng, scan);
  composeFindings(eng, scan);
  composeMethodology(eng, scan, opts, generatedAt);

  drawPageFurniture(doc, scan, generatedAt);

  const pageCount = doc.getNumberOfPages();
  const bytes = new Uint8Array(doc.output("arraybuffer"));
  return { bytes, pageCount, fileName: safeFileName(scan, generatedAt) };
}
