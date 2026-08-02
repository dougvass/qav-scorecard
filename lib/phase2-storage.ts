/**
 * Shared Phase 2 storage contract.
 * Imported by both the /phase2 page and the main scorecard page.
 */

export const PHASE2_STORAGE_KEY = "qav_phase2_v1";

export interface Phase2Entry {
  S_pe_hi_lo: number | null;
  S_equity_inc: number | null;
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
