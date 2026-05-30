/**
 * POST /api/buybacks
 *
 * Accepts { codes: string[] } — up to 25 ASX ticker codes per call.
 * For each code, fetches the 50 most recent ASX announcements and searches
 * for on-market buyback keywords in the announcement header/type.
 *
 * Returns: Record<string, { active: boolean, latestHeadline?: string, latestDate?: string }>
 *
 * The client is responsible for batching larger lists into chunks of ≤25.
 */

import { NextResponse } from "next/server";
import { BUYBACK_KEYWORDS, BUYBACK_LOOKBACK_MONTHS, BuybackEntry } from "@/lib/buyback-storage";

const ASX_ANNOUNCEMENTS_URL = (code: string) =>
  `https://www.asx.com.au/asx/1/company/${code}/announcements?count=50&market_sensitive=false`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.asx.com.au/",
  Origin: "https://www.asx.com.au",
};

function isBuybackAnnouncement(header: string): boolean {
  const h = header.toLowerCase();
  return BUYBACK_KEYWORDS.some((kw) => h.includes(kw));
}

async function checkCode(code: string): Promise<BuybackEntry> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - BUYBACK_LOOKBACK_MONTHS);

  try {
    const res = await fetch(ASX_ANNOUNCEMENTS_URL(code), {
      headers: HEADERS,
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return { active: false };

    const json = await res.json();
    const announcements: Array<{
      header?: string;
      document_type?: string;
      document_release_date?: string;
    }> = json?.data ?? [];

    for (const ann of announcements) {
      const dateStr = ann.document_release_date ?? "";
      if (dateStr && new Date(dateStr) < cutoff) continue;

      const header = ann.header ?? ann.document_type ?? "";
      if (isBuybackAnnouncement(header)) {
        return {
          active: true,
          latestHeadline: header,
          latestDate: dateStr,
        };
      }
    }

    return { active: false };
  } catch {
    // Timeout, network error, or ASX blocking this IP — treat as unknown (not scored)
    return { active: false };
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const codes: string[] = body?.codes ?? [];

    if (!Array.isArray(codes) || codes.length === 0) {
      return NextResponse.json({ error: "codes array required" }, { status: 400 });
    }

    // Cap at 25 per request — callers must batch
    const batch = codes.slice(0, 25);

    // Run all in parallel — each has its own 8s timeout
    const entries = await Promise.all(batch.map((code) => checkCode(code)));

    const result: Record<string, BuybackEntry> = {};
    batch.forEach((code, i) => {
      result[code] = entries[i];
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
