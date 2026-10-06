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
