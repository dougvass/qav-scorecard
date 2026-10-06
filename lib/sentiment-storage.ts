/**
 * Manual 3PTL sentiment overrides.
 * Stored in localStorage so they persist across sessions.
 * An override takes precedence over the SDMAX-derived score.
 *
 * Tony's 3PTL:
 *   Bullish  (+2) = price is above both lines (confirmed uptrend)
 *   Josephine (0) = above both lines, but below last month's close — the
 *                   uptick test. This is the ONLY thing Josephine now means.
 *   Watch     (0) = price is between the buy and sell lines, "not a sell nor
 *                   a buy" (Doug, 2026-10-06, renaming what used to be called
 *                   a between-the-lines Josephine).
 *   Bearish  (-1) = price is below the sell line (confirmed downtrend)
 *
 * Watch and Josephine both score 0, so the score cannot tell them apart — the
 * badge and the sentiment filter use the dip marker for that.
 */

export const SENTIMENT_STORAGE_KEY = "qav_sentiment_v1";

export type SentimentOverride = "Bullish" | "Watch" | "Josephine" | "Bearish";

/** Map of ASX code → manual override. Absence = use SDMAX. */
export type StoredSentiments = Record<string, SentimentOverride>;

export const SENTIMENT_SCORES: Record<SentimentOverride, number> = {
  Bullish:   2,
  Watch:     0,
  Josephine: 0,
  Bearish:  -1,
};


/** The four sentiment states as filter keys, in display order. */
export type SentimentKey = "bullish" | "watch" | "josephine" | "bearish";

export const SENTIMENT_KEYS: { key: SentimentKey; label: string }[] = [
  { key: "bullish",   label: "Bullish" },
  { key: "watch",     label: "Watch" },
  { key: "josephine", label: "Josephine" },
  { key: "bearish",   label: "Bearish" },
];

/**
 * Which state a sentiment score belongs to.
 *
 * Watch and Josephine both score 0, so `isDip` is the only thing that can
 * separate them. Defined here once because the buy-list stats and the table
 * rows each filter independently, and they had already drifted apart.
 */
export function sentimentKeyOf(
  score: number | null | undefined,
  isDip: boolean,
): SentimentKey | null {
  if (score === 2) return "bullish";
  if (score === -1) return "bearish";
  if (score === 0) return isDip ? "josephine" : "watch";
  return null;
}

/** True when a scored stock carries the Josephine dip marker. */
export function isJosephineDip(stock: unknown): boolean {
  return (stock as Record<string, unknown>)?._positiveJosephine === 1;
}
