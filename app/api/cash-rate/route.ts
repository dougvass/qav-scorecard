/**
 * The current RBA cash rate target, read from the RBA's own published table.
 *
 *   GET /api/cash-rate  ->  { rate, since, publicationDate, seriesId, source,
 *                             fetchedAt, stale }
 *
 * Source: https://www.rba.gov.au/statistics/tables/csv/f1-data.csv — table F1,
 * series FIRMMCRTD, "Cash Rate Target on date", daily. That is the rate in
 * force, which is what the market hurdle needs.
 *
 * Two other RBA sources were tried and rejected:
 *   * f1.1-data.csv is series FIRMMCRT, a MONTHLY AVERAGE. It reported 4.36 for
 *     September 2026 because the rise to 4.60 took effect on the 30th, so it
 *     understates the rate in force for most of any month containing a change.
 *   * the HTML page at /statistics/cash-rate/ carries the right numbers in its
 *     first table row, but scraping markup is more fragile than a published
 *     series with a stable ID.
 *
 * `since` is derived by walking back through the daily series to the first date
 * carrying the current value, which is the effective date of the last change
 * (30-Sep-2026 for 4.60). The response is cached at the edge for six hours;
 * the RBA publishes once a day and the rate changes at most monthly.
 */
import { DEFAULT_CASH_RATE } from "@/lib/qav-scoring";

export const runtime = "edge";

const CSV_URL = "https://www.rba.gov.au/statistics/tables/csv/f1-data.csv";
const SERIES_ID = "FIRMMCRTD";
const TITLE = "Cash Rate Target";
const DATE_RE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;

/** Minimal CSV row splitter — the RBA file is plain, unquoted values. */
function cells(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

interface Parsed {
  rate: number;
  since: string | null;
  publicationDate: string | null;
  seriesId: string | null;
}

function parse(csv: string): Parsed | null {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);

  // Find the Cash Rate Target column from the "Title" header row rather than
  // assuming index 1, so a column added upstream cannot silently shift it.
  let col = -1;
  let publicationDate: string | null = null;
  let seriesId: string | null = null;
  for (let i = 0; i < lines.length && i < 40; i++) {
    const c = cells(lines[i]);
    if (c[0] === "Title") {
      for (let j = 1; j < c.length; j++) if (c[j] === TITLE) { col = j; break; }
    }
    if (c[0] === "Publication date") publicationDate = c[1] || null;
    if (c[0] === "Series ID" && col >= 0) seriesId = c[col] || null;
  }
  if (col < 0) return null;

  // Last dated row carrying a value, then walk back for the effective date.
  const dates: string[] = [];
  const vals: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!c[0] || !DATE_RE.test(c[0])) continue;
    const v = c[col];
    if (!v || v.toUpperCase() === "N/A") continue;
    dates.push(c[0]);
    vals.push(v);
  }
  if (!vals.length) return null;

  const current = vals[vals.length - 1];
  const rate = parseFloat(current);
  if (!isFinite(rate)) return null;
  let since: string | null = null;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] !== current) break;
    since = dates[i];
  }
  return { rate, since, publicationDate, seriesId };
}

export async function GET() {
  const headers = {
    "Cache-Control": "public, s-maxage=21600, stale-while-revalidate=86400",
  };
  // `stale: true` means the caller is looking at the compiled-in fallback and
  // should say so rather than present it as the live rate.
  const fallback = {
    rate: DEFAULT_CASH_RATE, since: null, publicationDate: null,
    seriesId: SERIES_ID, source: CSV_URL, fetchedAt: new Date().toISOString(),
    stale: true as boolean, error: "" as string,
  };
  try {
    const res = await fetch(CSV_URL, {
      headers: { "User-Agent": "qav-scorecard/1.0", Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) {
      fallback.error = `RBA returned ${res.status}`;
      return Response.json(fallback, { headers });
    }
    const parsed = parse(await res.text());
    if (!parsed) {
      fallback.error = "could not find the Cash Rate Target series in the RBA table";
      return Response.json(fallback, { headers });
    }
    return Response.json({
      ...parsed,
      source: CSV_URL,
      fetchedAt: new Date().toISOString(),
      stale: false,
    }, { headers });
  } catch (e) {
    fallback.error = e instanceof Error ? e.message : "fetch failed";
    return Response.json(fallback, { headers });
  }
}
