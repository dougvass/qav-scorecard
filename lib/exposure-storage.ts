/**
 * The browser's copy of the revenue reviews. CLIENT-ONLY — see
 * lib/revenue-exposure.ts for what a review is and why it is kept here rather
 * than in the repository.
 */
import { setSynced } from "./server-store";
import { EXPOSURE_STORAGE_KEY, RevenueReview, StoredExposure } from "./revenue-exposure";

const EMPTY: StoredExposure = { timestamp: null, reviews: {} };

export function loadExposure(): StoredExposure {
  try {
    const raw = localStorage.getItem(EXPOSURE_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredExposure>;
    if (!parsed || typeof parsed.reviews !== "object" || parsed.reviews === null) return EMPTY;
    return { timestamp: parsed.timestamp ?? null, reviews: parsed.reviews as Record<string, RevenueReview> };
  } catch {
    return EMPTY;
  }
}

export function saveExposure(reviews: Record<string, RevenueReview>): StoredExposure {
  const stored: StoredExposure = { timestamp: new Date().toISOString(), reviews };
  setSynced(EXPOSURE_STORAGE_KEY, JSON.stringify(stored));
  return stored;
}
