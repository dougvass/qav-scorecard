/**
 * /api/buybacks  — runs on Vercel Edge Runtime (Cloudflare-backed edge nodes).
 * Edge IPs differ from Lambda IPs and are less likely to be blocked by ASX.
 *
 * POST { codes: string[] }  — batch check up to 25 codes
 * GET  ?code=BHP            — single-code debug: shows raw ASX response
 */

export const runtime = "edge";

import { BUYBACK_KEYWORDS, BUYBACK_LOOKBACK_MONTHS } from "@/lib/buyback-storage";

const ASX_URL = (code: string) =>
  `https://www.asx.com.au/asx/1/company/${code.toUpperCase()}/announcements?count=50&market_sensitive=false`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-AU,en-GB;q=0.9,en;q=0.8",
  Referer: "https://www.asx.com.au/markets/company/",
};

function isBuyback(header: string, docType: string) {
  const t = `${header} ${docType}`.toLowerCase();
  return BUYBACK_KEYWORDS.some((kw) => t.includes(kw));
}

interface Announcement {
  header?: string;
  document_type?: string;
  document_release_date?: string;
}

async function checkCode(code: string) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - BUYBACK_LOOKBACK_MONTHS);

  try {
    const res = await fetch(ASX_URL(code), {
      headers: HEADERS,
      signal: AbortSignal.timeout(9_000),
    });

    if (!res.ok) {
      return { active: false, _status: res.status };
    }

    const json = (await res.json()) as { data?: Announcement[] };
    const anns = json?.data ?? [];

    for (const ann of anns) {
      const dateStr = ann.document_release_date ?? "";
      if (dateStr && new Date(dateStr) < cutoff) continue;
      if (isBuyback(ann.header ?? "", ann.document_type ?? "")) {
        return {
          active: true,
          latestHeadline: ann.header,
          latestDate: dateStr,
          _status: res.status,
        };
      }
    }

    return { active: false, _status: res.status, _count: anns.length };
  } catch (e) {
    return { active: false, _err: e instanceof Error ? e.message : String(e) };
  }
}

// ── POST — batch ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = (await request.json()) as { codes?: string[] };
  const codes = (body.codes ?? []).slice(0, 25);

  if (codes.length === 0) {
    return Response.json({ error: "codes array required" }, { status: 400 });
  }

  const results = await Promise.all(codes.map(checkCode));
  const out: Record<string, object> = {};
  codes.forEach((c, i) => { out[c] = results[i]; });

  return Response.json(out);
}

// ── GET — single-code debug ───────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code") ?? "BHP";
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - BUYBACK_LOOKBACK_MONTHS);

  const result: Record<string, unknown> = {
    code,
    url: ASX_URL(code),
    runtime: "edge",
    keywords: BUYBACK_KEYWORDS,
    cutoff: cutoff.toISOString().slice(0, 10),
  };

  try {
    const res = await fetch(ASX_URL(code), {
      headers: HEADERS,
      signal: AbortSignal.timeout(9_000),
    });
    result.status = res.status;
    result.ok = res.ok;

    if (res.ok) {
      const json = (await res.json()) as { data?: Announcement[] };
      const anns = json?.data ?? [];
      result.total = anns.length;
      result.buyback_hits = anns.filter((a) =>
        isBuyback(a.header ?? "", a.document_type ?? "")
      ).length;
      result.recent_5 = anns.slice(0, 5).map((a) => ({
        header: a.header,
        document_type: a.document_type,
        date: a.document_release_date,
        is_buyback: isBuyback(a.header ?? "", a.document_type ?? ""),
      }));
    } else {
      result.body = (await res.text()).slice(0, 400);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return Response.json(result);
}
