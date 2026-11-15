/**
 * Stored 3PTL (3-Point Trendline) calculation results.
 * Auto-calculated via /api/trendline-v3 from Yahoo Finance monthly closes.
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
  /** null when no 3PTL could be drawn — see `unreadable`. */
  sentiment: TrendlineSentiment | null;
  /**
   * Set when the engine had under a year of monthly closes to work with (a new
   * listing, or a relisting) or could not fetch any. The stock's sentiment is
   * then left UNSCORED rather than defaulted to Watch — Doug, 2026-11-14.
   * The entry still exists so a run counts as having covered the code.
   */
  unreadable?: boolean;
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
  /** The engine read this stock as a FALLING KNIFE, which is why it is Bearish:
   *  lower highs not yet beaten since its low, or nothing but a safety net
   *  under it. The row is tagged, as a commodity-gated one is. */
  knife?: boolean;
}

/**
 * Which set of 3PTL rules a stored run was read with. BUMP THIS whenever the
 * engine's rules change (lib/trendline-v3.ts): a stored run carrying a
 * different stamp, or none, no longer counts as today's run, so the scorecard
 * reads the list again the next time it opens instead of showing yesterday's
 * rules under today's date.
 *
 * 2026-11-15-walk: the rebuilt walk went live — current month as the final bar,
 * the safety net and flat-bottom step, redraw at a sell, the flat-top fallback,
 * and the falling-knife reading.
 * 2026-11-15-knife-gate: the falling knife became a gate on every stock.
 */
export const TRENDLINE_ENGINE = "2026-11-15-knife-gate";

export interface StoredTrendlines {
  timestamp: string;        // ISO date of calculation run
  checkedCount: number;
  data: Record<string, TrendlineEntry>;
  /** TRENDLINE_ENGINE at the time of the run; absent on runs before it existed. */
  engine?: string;
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
