/**
 * Stored 3PTL (3-Point Trendline) calculation results.
 * Auto-calculated via /api/trendline from Yahoo Finance monthly OHLC data.
 * Takes precedence over SDMAX but is itself overridden by manual sentiment overrides.
 */

export const TRENDLINE_STORAGE_KEY = "qav_trendline_v1";

/**
 * The between-the-lines state is WATCH, not Josephine. Doug, 2026-10-06: "we
 * don't want a josephine between lines, rename to Watch, and keep Josephine
 * label for stocks that are above the buy line but price has dipped lower than
 * previous month close."
 *
 *   Bullish   above both lines
 *   Josephine above both lines, but below last month's close (the uptick test)
 *   Watch     between the buy and sell lines — "not a sell nor a buy"
 *   Bearish   below the sell line
 *
 * Watch and Josephine both score 0: Tony's scale has no separate slot, so the
 * split is a labelling one, not a scoring one.
 *
 * v3 emits these four directly. v1, which production runs, calls the
 * between-the-lines state "Josephine" and flags the dip case in its note — so
 * a v1 Josephine WITHOUT that note is a Watch, and the UI renders it as one.
 */
export type TrendlineSentiment = "Bullish" | "Watch" | "Josephine" | "Bearish";

export interface TrendlineEntry {
  sentiment: TrendlineSentiment;
  note?: string;
  /** true when the 3PTL detected a recent breakout above resistance — maps to Bible Col R (New 3PT Upturn) */
  newUpturn?: boolean;
}

export interface StoredTrendlines {
  timestamp: string;        // ISO date of calculation run
  checkedCount: number;
  data: Record<string, TrendlineEntry>;
}

export const TRENDLINE_SCORES: Record<TrendlineSentiment, number> = {
  Bullish:    2,
  Watch:      0,
  Josephine:  0,
  Bearish:   -1,
};
