/**
 * QAV scores of the funds in the Stock Doctor list, handed from the scorecard
 * to the ETF page.
 *
 * Doug, 2026-11-14: "the ETFs from the QAV list do have scores, even though
 * they're not businesses... it might be interesting to have them populate on
 * the ETF ranker as well."
 *
 * The two pages rank funds by different things and neither replaces the other.
 * The ETF page ranks ~390 ASX funds by 3PTL then net yield, with its own
 * seven-check Quality. The scorecard gives every row of the Stock Doctor export
 * a QAV score — Quality ÷ price-to-cashflow — and that export contains funds
 * too: 66 by the scorecard's name test on 14 Nov 2026, 59 of them already in
 * the ETF universe and 7 not (AQTY, B1SM, OPPT, V1AC, CDO, OPH, RF1).
 *
 * What a fund's QAV score IS: Stock Doctor reports a cash flow, EPS and equity
 * for a fund like any other listed entity, so the arithmetic runs. What it
 * MEANS is weaker than for a company — a fund's "operating cash flow" is mostly
 * distributions received and units traded — which is why the ETF page shows it
 * as a column beside its own rank and does not fold it in.
 *
 * WHICH ROWS ARE STORED. Every row with no industry group: that is the funds,
 * plus the listed investment companies and trusts Stock Doctor also leaves
 * unclassified (WAM, CAM, MXT ...). The ETF page picks from these — a code in
 * its own universe, or one the scorecard's name test calls a fund — so the
 * two pages do not need to share a list.
 *
 * Written by the scorecard on every scoring run, so it carries the SAME score
 * the stock list shows (Phase 2, the 3PTL, buybacks and overrides included),
 * not a re-derivation. This browser only: it is rebuilt whenever the scorecard
 * opens, on any device.
 */

export const FUND_SCORES_STORAGE_KEY = "qav_fund_scores_v1";

export interface FundScore {
  name: string;
  /** The scorecard's own fund test: the name says ETF or Fund. */
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
