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
  /**
   * Month of the most recent BUY event in the walk — a breach of the buy line —
   * as "YYYY-MM", or null if the engine reported none.
   *
   * This is what Bible Column I actually asks for. Its wording: "Does the 5
   * year monthly chart show a recent upturn since the last financial results
   * (results of the date, not reporting date)? By 'recent upturn', we mean 'has
   * it breached the buy line'?" — scored "Positive = 1. Negative = blank", with
   * "we aren't going to penalise it if the answer is a no", which is why a no
   * is null rather than 0.
   *
   * So the score needs two things: the breach month (here) and the BALANCE date
   * of the last reported results (`_lastPeriod` on the stock, from the CSV's
   * "Last Period Analysed", which is the results date rather than the
   * announcement date the Bible warns against). enrichWithTrendlines compares
   * them.
   *
   * Only v3 supplies this, because only a CAUSAL walk has trustworthy event
   * dates — the engine's L2 could previously reach years forward, which is why
   * this criterion was left unscored until the walk was fixed.
   */
  lastBuyBreach?: string | null;
  /** @deprecated Never set: the note strings it was derived from were never
   *  written by any engine, so S_new_upturn was always null. Superseded by
   *  lastBuyBreach + the balance date. */
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


/**
 * Normalise whatever an engine reports into the stored vocabulary.
 *
 * v3 says Buy / Sell / Watch / Josephine; v1 says Bullish / Josephine /
 * Bearish. Accepting both means the auto run can be pointed at either engine
 * without touching the storage layer. An unknown or missing value becomes
 * Watch, which scores 0 — the neutral choice for a stock the engine could not
 * read (insufficient data), and what v1 already did by defaulting.
 */
export function toStoredSentiment(s: string | null | undefined): TrendlineSentiment {
  switch ((s ?? "").trim().toLowerCase()) {
    case "buy":
    case "bullish":   return "Bullish";
    case "sell":
    case "bearish":   return "Bearish";
    case "josephine": return "Josephine";
    case "watch":     return "Watch";
    default:          return "Watch";
  }
}
