/**
 * Stored 3PTL (3-Point Trendline) calculation results.
 * Auto-calculated via /api/trendline from Yahoo Finance monthly OHLC data.
 * Takes precedence over SDMAX but is itself overridden by manual sentiment overrides.
 */

export const TRENDLINE_STORAGE_KEY = "qav_trendline_v1";

export type TrendlineSentiment = "Bullish" | "Josephine" | "Bearish";

export interface TrendlineEntry {
  sentiment: TrendlineSentiment;
  note?: string;
}

export interface StoredTrendlines {
  timestamp: string;        // ISO date of calculation run
  checkedCount: number;
  data: Record<string, TrendlineEntry>;
}

export const TRENDLINE_SCORES: Record<TrendlineSentiment, number> = {
  Bullish:    2,
  Josephine:  0,
  Bearish:   -1,
};
