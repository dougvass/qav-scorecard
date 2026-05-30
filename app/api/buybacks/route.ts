/**
 * /api/buybacks — debug endpoint only.
 *
 * The main buyback checking now runs entirely client-side (browser → ASX)
 * to avoid Vercel datacenter IPs being blocked by ASX.
 *
 * GET /api/buybacks?code=BHP
 *   Returns raw ASX announcement data for a single ticker so you can
 *   inspect what the server sees vs what the browser sees.
 */

import { NextResponse } from "next/server";
import { BUYBACK_KEYWORDS } from "@/lib/buyback-storage";

const ASX_URL = (code: string) =>
  `https://www.asx.com.au/asx/1/company/${code.toUpperCase()}/announcements?count=50&market_sensitive=false`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
  Referer: "https://www.asx.com.au/markets/company/",
  Origin: "https://www.asx.com.au",
};

function isBuyback(text: string) {
  const t = text.toLowerCase();
  return BUYBACK_KEYWORDS.some((kw) => t.includes(kw));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code") ?? "BHP";
  const url = ASX_URL(code);

  const result: Record<string, unknown> = {
    code,
    url,
    note: "This is the SERVER view. The browser may get a different response if ASX blocks Vercel IPs.",
  };

  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(9_000),
      cache: "no-store",
    });
    result.status = res.status;
    result.ok = res.ok;

    if (res.ok) {
      const json = await res.json();
      const data: Record<string, unknown>[] = json?.data ?? [];
      result.total_announcements = data.length;
      result.buyback_hits = data.filter((a) =>
        isBuyback(`${a.header ?? ""} ${a.document_type ?? ""}`)
      ).length;
      result.first_5 = data.slice(0, 5).map((a) => ({
        header: a.header,
        document_type: a.document_type,
        date: a.document_release_date,
        is_buyback: isBuyback(`${a.header ?? ""} ${a.document_type ?? ""}`),
      }));
    } else {
      result.body_preview = (await res.text()).slice(0, 500);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(result);
}
