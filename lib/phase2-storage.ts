/**
 * Shared Phase 2 storage contract.
 * Imported by both the /phase2 page and the main scorecard page.
 */

export const PHASE2_STORAGE_KEY = "qav_phase2_v1";

export interface Phase2Entry {
  S_pe_hi_lo: number | null;
  S_equity_inc: number | null;
}

export interface StoredPhase2 {
  timestamp: string;   // ISO date of last upload
  source: string;      // filename
  data: Record<string, Phase2Entry>;
}
