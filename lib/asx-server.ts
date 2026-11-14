/**
 * The ASX announcement feed and its documents. SERVER-ONLY.
 *
 * Shared by the red-flag route and the route that reads a company's own report
 * when Stock Doctor is a period behind. All verified 2026-10-08:
 *   search    {BASE}/search/predictive?searchText=CODE   -> use `xidEntity`,
 *             NOT `xid`; `xid` returns an empty announcement list and looks
 *             like a dead endpoint.
 *   announce  {BASE}/markets/announcements?entityXids={xidEntity}&...
 *   the PDF   {BASE}/file/{documentKey}                  -> no auth, no token
 */

export const BASE = "https://asx.api.markitdigital.com/asx-research/1.0";
export const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

export interface Ann { headline: string; types: string[]; date: string; key: string; kb: number }

export async function jget(url: string, timeout = 15_000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function entityXid(code: string): Promise<string | null> {
  const d = await jget(`${BASE}/search/predictive?searchText=${encodeURIComponent(code)}`);
  const items = ((d.data as Record<string, unknown>)?.items ?? []) as Record<string, unknown>[];
  for (const it of items) {
    if (String(it.symbol ?? "").toUpperCase() === code.toUpperCase()) {
      return it.xidEntity != null ? String(it.xidEntity) : null;
    }
  }
  return null;
}

export function sizeKb(s: string): number {
  const m = /([\d.]+)\s*KB/i.exec(s ?? "");
  if (m) return parseFloat(m[1]);
  const g = /([\d.]+)\s*MB/i.exec(s ?? "");
  return g ? parseFloat(g[1]) * 1024 : Number.POSITIVE_INFINITY;
}

/** A page is 120 announcements. A company on a daily buy-back fills one in a
 *  few months (LNW: eight), so to judge the reporting cycle the feed is paged
 *  until it reaches back to the balance date — within reason. */
const PAGE_SIZE = 120;
const MAX_PAGES = 4;

export async function announcements(xid: string, reachBack?: string | null): Promise<Ann[]> {
  const today = new Date().toISOString().slice(0, 10);
  const back = reachBack && /^\d{4}-\d{2}-\d{2}/.test(reachBack) ? reachBack.slice(0, 10) : null;
  const out: Ann[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await jget(
      `${BASE}/markets/announcements?entityXids=${xid}&page=${page}&itemsPerPage=${PAGE_SIZE}&summaryCountsDate=${today}`,
      20_000,
    );
    const items = ((d.data as Record<string, unknown>)?.items ?? []) as Record<string, unknown>[];
    for (const it of items) {
      out.push({
        headline: String(it.headline ?? ""),
        types: (it.announcementTypes as string[]) ?? [],
        date: String(it.date ?? ""),
        key: String(it.documentKey ?? ""),
        kb: sizeKb(String(it.fileSize ?? "")),
      });
    }
    if (!back || items.length < PAGE_SIZE) break;
    const oldest = out.reduce((min, a) => (a.date && (!min || a.date < min) ? a.date : min), "");
    if (!oldest || oldest.slice(0, 10) <= back) break;
  }
  return out;
}
