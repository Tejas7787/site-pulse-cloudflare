import { useEffect, useState } from "react";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import {
  domainFromUrl,
  previousScoreFor,
  saveScoreToHistory,
  type ScoreRecord,
} from "../lib/scoreHistory";

/**
 * "vs last scan" delta chip, or nothing when there is no earlier scan to
 * compare against.
 *
 * The previous score is captured once in the lazy state initializer — before
 * this scan is written to history — and the write happens in an effect, so no
 * state is set from inside an effect. Give it a `key={scan.scannedAt}` so a
 * brand new scan re-captures its own baseline.
 */
export function ScoreTrend({ scan }: { scan: ScoreRecord }) {
  const domain = domainFromUrl(scan.url);
  const [previousScore] = useState<number | null>(() =>
    previousScoreFor(domain, scan.scannedAt),
  );

  useEffect(() => {
    saveScoreToHistory(domain, {
      score: scan.score,
      scannedAt: scan.scannedAt,
      url: scan.url,
    });
  }, [domain, scan.score, scan.scannedAt, scan.url]);

  if (previousScore === null) return null;

  const delta = scan.score - previousScore;
  const trend = delta > 2 ? "up" : delta < -2 ? "down" : "flat";
  const tone =
    trend === "up"
      ? "text-emerald-600"
      : trend === "down"
        ? "text-red-600"
        : "text-[#1a1a1a]/40";

  return (
    <div className="mt-2 flex items-center gap-1.5" data-testid="score-trend">
      {trend === "up" ? (
        <TrendingUp className={`size-4 ${tone}`} aria-hidden="true" />
      ) : trend === "down" ? (
        <TrendingDown className={`size-4 ${tone}`} aria-hidden="true" />
      ) : (
        <Minus className={`size-4 ${tone}`} aria-hidden="true" />
      )}
      <span className={`text-xs font-bold ${tone}`}>
        {trend === "up" ? `+${delta}` : trend === "down" ? `${delta}` : "Same"} vs last
        scan
      </span>
    </div>
  );
}
