/**
 * The funds in the Stock Doctor list, handed from the scorecard to the ETF
 * page.
 *
 * The export carries ETFs and funds because Doug exports the unclassified rows
 * so as not to miss a company too new to have a GICS code. The scorecard sets
 * the funds aside when it loads the CSV (isSetAsideFund in lib/qav-scoring.ts)
 * and writes their codes and names here; the ETF page adds any that its bundled
 * universe lacks to its own run.
 *
 * HISTORY. Until 2026-11-15 the scorecard SCORED these rows and this record
 * carried the QAV score, shown as a column on the ETF page. The column was
 * removed on 2026-11-16 (no correlation with the ETF rank) and the funds now
 * leave the data set before scoring — Doug: "Bond funds like these should be
 * captured not in QAV but in the ETF under total return ... ETFs should be
 * pulled from the data set automatically." The score fields are kept in the
 * type so an older stored record still parses; they are written as null.
 *
 * This browser only: it is rebuilt whenever the scorecard opens, on any device.
 */

export const FUND_SCORES_STORAGE_KEY = "qav_fund_scores_v1";

export interface FundScore {
  name: string;
  /** An ETF or fund, which the ETF page ranks. False for a listed investment
   *  company: set aside from the scorecard too, but not ranked there. */
  isFund: boolean;
  qav: number | null;
  /** Mean of the criteria that could be scored, as a fraction (0.8 = 80%). */
  quality: number | null;
  pcf: number | null;
  /** How many criteria could be scored. */
  count: number | null;
  /** Buy / Watch / Josephine / Sell, as the scorecard shows it. */
  sentiment: string | null;
  onBuyList: boolean;
  /** On the reporting-season hold: Stock Doctor's numbers are over six months old. */
  hold: boolean;
  /** The period Stock Doctor's numbers are for, YYYY-MM-DD. */
  period: string | null;
}

export interface StoredFundScores {
  /** When the scorecard last scored. */
  timestamp: string;
  data: Record<string, FundScore>;
}

export function saveFundScores(data: Record<string, FundScore>): void {
  try {
    const stored: StoredFundScores = { timestamp: new Date().toISOString(), data };
    localStorage.setItem(FUND_SCORES_STORAGE_KEY, JSON.stringify(stored));
  } catch { /* quota or private mode — the ETF page simply shows no QAV column */ }
}

export function loadFundScores(): StoredFundScores | null {
  try {
    const raw = localStorage.getItem(FUND_SCORES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredFundScores;
    return parsed && parsed.data && typeof parsed.data === "object" ? parsed : null;
  } catch {
    return null;
  }
}
