/**
 * QAV score history — one snapshot per day, per stock.
 *
 * TWO-TIER by design:
 *   1. Postgres via /api/history — the durable home. Survives browser clears,
 *      shared across devices, queryable later.
 *   2. localStorage mirror — always written, so the feature works before the
 *      database is provisioned, offline, and as a same-day cache.
 *
 * Reads merge both, server winning on conflict. That means the app is useful
 * on day one with no infrastructure, and upgrades silently once POSTGRES_URL
 * exists — no migration step, because the client re-POSTs its local snapshots
 * on the next successful save.
 */

export const HISTORY_STORAGE_KEY = "qav_history_v1";

/** One stock on one day. Kept deliberately narrow — this is written ~450x per
 *  snapshot and read for every sparkline, so every field costs real bytes. */
export interface HistoryPoint {
  d: string;              // ISO date, yyyy-mm-dd
  qav: number | null;
  quality: number | null;
  pcf: number | null;
  sentiment: string | null;
  price: number | null;
}

/** code -> points, oldest first. */
export type HistorySeries = Record<string, HistoryPoint[]>;

export interface StoredHistory {
  updated: string;        // ISO timestamp of last write
  data: HistorySeries;
}

/** Today in the ASX's calendar sense — snapshots are keyed by local date so a
 *  late-evening run and the next morning's don't collapse into one row. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Merge two series, newer-wins per (code, date), result sorted oldest first. */
export function mergeSeries(a: HistorySeries, b: HistorySeries): HistorySeries {
  const out: HistorySeries = {};
  for (const src of [a, b]) {
    for (const [code, pts] of Object.entries(src)) {
      const byDate = new Map((out[code] ?? []).map((p) => [p.d, p]));
      for (const p of pts) byDate.set(p.d, p);   // later source wins
      out[code] = [...byDate.values()].sort((x, y) => x.d.localeCompare(y.d));
    }
  }
  return out;
}

/** Cap retained points per stock so the localStorage mirror cannot grow without
 *  bound. Weekly snapshots => 260 points is ~5 years, well inside the ~5MB
 *  origin quota. The server keeps everything; this only trims the mirror. */
export const MAX_LOCAL_POINTS = 260;

export function trimSeries(s: HistorySeries, max = MAX_LOCAL_POINTS): HistorySeries {
  const out: HistorySeries = {};
  for (const [code, pts] of Object.entries(s)) {
    out[code] = pts.length > max ? pts.slice(pts.length - max) : pts;
  }
  return out;
}

export function loadLocalHistory(): StoredHistory | null {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredHistory;
    return parsed?.data ? parsed : null;
  } catch { return null; }
}

export function saveLocalHistory(data: HistorySeries): StoredHistory | null {
  const stored: StoredHistory = { updated: new Date().toISOString(), data: trimSeries(data) };
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota exceeded — drop the oldest half rather than losing the feature.
    try {
      const halved = trimSeries(data, Math.floor(MAX_LOCAL_POINTS / 2));
      localStorage.setItem(HISTORY_STORAGE_KEY,
        JSON.stringify({ updated: stored.updated, data: halved }));
      return { updated: stored.updated, data: halved };
    } catch { return null; }
  }
  return stored;
}
