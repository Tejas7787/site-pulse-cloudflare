/**
 * Score history — localStorage only, per browser, no PII.
 *
 * Both the landing page and the report page used to keep their own copy of
 * this logic. It now lives here so the two views read and write the same
 * store, and so the "vs last scan" delta is derived in exactly one place
 * (see components/ScoreTrend.tsx for the UI).
 */

export interface ScoreEntry {
  /** Overall health score 0-100 */
  score: number;
  /** Epoch ms when the scan completed */
  scannedAt: number;
  /** The URL that was scanned */
  url: string;
}

/** A scan we can compare against history (subset of the saved report). */
export interface ScoreRecord {
  url: string;
  score: number;
  scannedAt: number;
}

const STORAGE_KEY = "sitepulse_history";
const MAX_ENTRIES_PER_DOMAIN = 5;

/** Extract a short display name from a URL. Falls back to the raw string. */
export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Read the history for one domain (newest first). */
export function getScoreHistory(domain: string): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const all = parsed as Record<string, ScoreEntry[]>;
    return Array.isArray(all[domain]) ? all[domain] : [];
  } catch {
    // Storage blocked (private mode / policy) — history is optional.
    return [];
  }
}

/** Append a scan to the front of the domain's history. Deduplicates by timestamp. */
export function saveScoreToHistory(domain: string, entry: ScoreEntry): void {
  try {
    const existing = getScoreHistory(domain);
    const next = [entry, ...existing.filter((e) => e.scannedAt !== entry.scannedAt)].slice(
      0,
      MAX_ENTRIES_PER_DOMAIN,
    );
    const raw = localStorage.getItem(STORAGE_KEY);
    const store: Record<string, ScoreEntry[]> = raw
      ? (JSON.parse(raw) as Record<string, ScoreEntry[]>)
      : {};
    store[domain] = next;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable — losing history must never break a scan.
  }
}

/**
 * The last score for this domain that is NOT the given scan.
 *
 * Excluding the current scan matters: the report page opens right after the
 * landing page has already stored the same scan, and without the exclusion
 * the "vs last scan" delta would always read "Same".
 */
export function previousScoreFor(domain: string, scannedAt: number): number | null {
  const previous = getScoreHistory(domain).find((e) => e.scannedAt !== scannedAt);
  return previous ? previous.score : null;
}
