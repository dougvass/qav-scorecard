/**
 * POST /api/buybacks
 *
 * Accepts { codes: string[] } — up to 25 ASX ticker codes per call.
 * For each code, fetches the 50 most recent ASX announcements and searches
 * for on-market buyback keywords in the announcement header/type.
 *
 * Returns: Record<string, { active: boolean, latestHeadline?: string, latestDate?: string, _err?: string }>
 *
 * GET /api/buybacks?code=BHP — debug single ticker, returns raw ASX response info.
 */

import { NextResponse } from "next/server";
import { BUYBACK_KEYWORDS, BUYBACK_LOOKBACK_MONTHS, BuybackEntry } from "@/lib/buyback-storage";

// ASX announcements endpoint — two URL patterns tried in order
const ASX_URLS = (code: string) => [
  `https://www.asx.com.au/asx/1/company/${code}/announcements?count=50&market_sensitive=false`,
  `https://www.asx.com.au/asx/1/company/${code.toUpperCase()}/announcements?count=50`,
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
  Referer: "https://www.asx.com.au/markets/company/",
  Origin: "https://www.asx.com.au",
  "Cache-Control": "no-cache",
};

function isBuyback(text: string): boolean {
  const t = text.toLowerCase();
  return BUYBACK_KEYWORDS.some((kw) => t.includes(kw));
}

async function checkCode(code: string): Promise<BuybackEntry & { _status?: number; _err?: string }> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - BUYBACK_LOOKBACK_MONTHS);

  for (const url of ASX_URLS(code)) {
    try {
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(9_000),
        cache: "no-store",
      });

      if (!res.ok) {
        // Continue to next URL variant on non-200
        continue;
      }

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
        if (isBuyback(header)) {
          return { active: true, latestHeadline: header, latestDate: dateStr, _status: res.status };
        }
      }

      return { active: false, _status: res.status };
    } catch (err) {
      // try next URL variant
      const msg = err instanceof Error ? err.message : String(err);
      if (url === ASX_URLS(code).at(-1)) {
        return { active: false, _err: msg };
      }
    }
  }

  return { active: false, _err: "All URL variants failed" };
}

// ─── POST — batch check ───────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const codes: string[] = body?.codes ?? [];

    if (!Array.isArray(codes) || codes.length === 0) {
      return NextResponse.json({ error: "codes array required" }, { status: 400 });
    }

    const batch = codes.slice(0, 25);
    const entries = await Promise.all(batch.map(checkCode));
    const result: Record<string, BuybackEntry & { _err?: string }> = {};
    batch.forEach((code, i) => { result[code] = entries[i]; });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      { status: 500 }
    );
  }
}

// ─── GET — single-code debug ──────────────────────────────────────────────────

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "BHP";

  const result: Record<string, unknown> = { code, tested_urls: [] };

  for (const asxUrl of ASX_URLS(code)) {
    const attempt: Record<string, unknown> = { url: asxUrl };
    try {
      const res = await fetch(asxUrl, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(9_000),
        cache: "no-store",
      });
      attempt.status = res.status;
      attempt.ok = res.ok;
      if (res.ok) {
        const json = await res.json();
        const data = json?.data ?? [];
        attempt.announcement_count = data.length;
        attempt.first_3 = data.slice(0, 3).map((a: Record<string, unknown>) => ({
          header: a.header,
          document_type: a.document_type,
          date: a.document_release_date,
        }));
        attempt.buyback_hits = data.filter((a: Record<string, unknown>) =>
          isBuyback(String(a.header ?? a.document_type ?? ""))
        ).length;
      } else {
        attempt.body_preview = (await res.text()).slice(0, 300);
      }
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
    }
    (result.tested_urls as unknown[]).push(attempt);
  }

  return NextResponse.json(result);
}
