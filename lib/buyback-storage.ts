/**
 * Shared buyback storage contract.
 * Results are fetched from ASX announcements and cached in localStorage.
 */

export const BUYBACK_STORAGE_KEY = "qav_buybacks_v1";

export interface BuybackEntry {
  /** true = active buyback found in ASX announcements within the lookback window */
  active: boolean;
  /** headline of the most recent buyback announcement, if found */
  latestHeadline?: string;
  /** ISO date of the most recent announcement */
  latestDate?: string;
}

export interface StoredBuybacks {
  /** ISO timestamp of when this batch was fetched */
  timestamp: string;
  /** total number of codes checked */
  checkedCount: number;
  data: Record<string, BuybackEntry>;
}

/**
 * Keywords / document types that indicate an active on-market buyback.
 * Matched against both the announcement `header` and `document_type` fields.
 *   Appendix 3C = Announcement of buy-back
 *   Appendix 3D = Change to buy-back
 *   Appendix 3E = Cessation of buy-back (we intentionally exclude this)
 */
export const BUYBACK_KEYWORDS = [
  "buy-back",
  "buyback",
  "buy back",
  "appendix 3c",
  "appendix 3d",
];

/** How many months back to look for announcements */
export const BUYBACK_LOOKBACK_MONTHS = 12;
