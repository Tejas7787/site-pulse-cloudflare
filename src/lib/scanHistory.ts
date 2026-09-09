/**
 * Scan History — localStorage-based, per-browser, no PII.
 *
 * Each entry stores just enough data to display a summary card and link
 * to the full Convex-backed report page.  The full scan data lives in
 * the Convex `scans` table; this is only a lightweight index.
 */

export interface ScanHistoryEntry {
  /** Convex document id — navigates to /report/:id */
  scanId: string;
  /** The URL that was scanned */
  url: string;
  /** Overall health score 0-100 */
  score: number;
  /** Letter grade A-F */
  grade: string;
  /** Category scores */
  performanceScore: number;
  seoScore: number;
  securityScore: number;
  accessibilityScore: number;
  technicalHealthScore: number;
  /** Epoch ms when the scan completed */
  scannedAt: number;
}

const STORAGE_KEY = "sitepulse_scan_history";
const MAX_ENTRIES = 50;

/** Read the full history array (newest first). */
export function getScanHistory(): ScanHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ScanHistoryEntry[];
  } catch {
    return [];
  }
}

/** Append a scan to the front of the history.  Deduplicates by scanId. */
export function addScanToHistory(entry: ScanHistoryEntry): void {
  try {
    const history = getScanHistory().filter((e) => e.scanId !== entry.scanId);
    history.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Remove a single entry by scanId. */
export function removeScanFromHistory(scanId: string): void {
  try {
    const history = getScanHistory().filter((e) => e.scanId !== scanId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // ignore
  }
}

/** Clear all history. */
export function clearScanHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Extract a short display name from a URL. */
export function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Format an epoch-ms timestamp to a human-readable string. */
export function formatScanDate(ms: number): string {
  const d = new Date(ms);
  const now = Date.now();
  const diffMs = now - ms;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}
