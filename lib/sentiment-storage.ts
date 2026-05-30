/**
 * Manual 3PTL sentiment overrides.
 * Stored in localStorage so they persist across sessions.
 * An override takes precedence over the SDMAX-derived score.
 *
 * Tony's 3PTL:
 *   Bullish  (+2) = price is above the sell line (confirmed uptrend)
 *   Josephine (0) = price is between buy and sell lines
 *   Bearish  (-1) = price is below the buy line (confirmed downtrend)
 */

export const SENTIMENT_STORAGE_KEY = "qav_sentiment_v1";

export type SentimentOverride = "Bullish" | "Josephine" | "Bearish";

/** Map of ASX code → manual override. Absence = use SDMAX. */
export type StoredSentiments = Record<string, SentimentOverride>;

export const SENTIMENT_SCORES: Record<SentimentOverride, number> = {
  Bullish:   2,
  Josephine: 0,
  Bearish:  -1,
};
