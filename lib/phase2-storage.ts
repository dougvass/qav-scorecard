/**
 * Shared Phase 2 storage contract.
 * Imported by both the /phase2 page and the main scorecard page.
 */

export const PHASE2_STORAGE_KEY = "qav_phase2_v1";

export interface Phase2Entry {
  S_pe_hi_lo: number | null;
  S_equity_inc: number | null;
  /** Reported historical PEs, oldest first, "Current" excluded — lets the
   *  PE Hi/Lo score be recomputed against today's PE. See scorePeHiLoLive. */
  peHistory?: number[];
  /** Balance date of the last reported numbers (ISO yyyy-mm-dd) — data-
   *  freshness rule: don't buy on numbers older than 6 months. */
  lastPeriod?: string | null;
}

/** Months between an ISO date and now (fractional). */
export function monthsOld(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (30.44 * 24 * 3600 * 1000);
}

/** Data-freshness threshold (months). */
export const STALE_MONTHS = 6;

export interface StoredPhase2 {
  timestamp: string;   // ISO date of last upload
  source: string;      // filename
  data: Record<string, Phase2Entry>;
}

/**
 * PE Hi/Lo scored against TODAY's PE rather than the workbook's frozen one.
 *
 * Tony's test is "is the current PE the lowest of the last six?" — and PE moves
 * with the share price every day, so a score computed at scrape time is stale
 * as soon as the price moves. Measured against QAV HQ on 2026-09-06 the frozen
 * score agreed only 47% of the time, and the errors were one-directional: we
 * kept awarding +2 ("lowest PE") to stocks that had rallied so hard their live
 * PE was now the highest (A1M stored 7.11 vs live 16.33, AAL 9.81 vs 25.42),
 * which inflates Quality on exactly the stocks that have already run up.
 *
 * Six values = the five most recent REPORTED PEs plus today's live one, which
 * is how the workbook's own AO_calc is defined (slot 6 holds "Current").
 *
 * Returns null when there is not enough history to judge, so the caller can
 * fall back to whatever the workbook holds rather than wiping a hand-entered
 * value.
 */
export function scorePeHiLoLive(livePe: number | null, history?: number[]): number | null {
  if (livePe === null || !isFinite(livePe) || livePe <= 0) return null;
  if (!history || history.length < 2) return null;
  const six = [...history.slice(-5), livePe];
  const min = Math.min(...six), max = Math.max(...six);
  if (livePe <= min) return 2;    // lowest of the six
  if (livePe >= max) return -1;   // highest — actively expensive
  return 0;
}
