/**
 * POST /api/buybacks  { codes: string[] }
 *   Fetches each stock's ASX announcement HTML page and searches for
 *   Appendix 3C (buy-back announcement) or 3D (change to buy-back) text.
 *   Returns Record<string, { active: boolean, _status?: number, _err?: string }>
 *
 * GET  /api/buybacks?code=BHP
 *   Debug — shows raw fetch result for one ticker including HTML length and
 *   whether any buyback keywords were found.
 */

export const runtime = "edge";

const ASX_URL = (code: string) =>
  `https://www.asx.com.au/markets/trade-our-cash-market/announcements.${code.toLowerCase()}`;

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.asx.com.au/",
};

// Keywords to find in the HTML text (case-insensitive)
const KEYWORDS = ["appendix 3c", "appendix 3d", "buy-back", "buyback"];

function searchHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw));
}

async function checkCode(code: string) {
  const url = ASX_URL(code);
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { active: false, _status: res.status };
    const html = await res.text();
    return { active: searchHtml(html), _status: res.status };
  } catch (e) {
    return { active: false, _err: e instanceof Error ? e.message : String(e) };
  }
}

// ── POST — batch ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = (await request.json()) as { codes?: string[] };
  const codes = (body.codes ?? []).slice(0, 25);
  if (!codes.length) return Response.json({ error: "codes required" }, { status: 400 });

  const results = await Promise.all(codes.map(checkCode));
  const out: Record<string, object> = {};
  codes.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}

// ── GET — single-code debug ───────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "BHP").toUpperCase();
  const url = ASX_URL(code);
  const result: Record<string, unknown> = { code, url, runtime: "edge", keywords: KEYWORDS };

  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    result.status = res.status;
    result.ok = res.ok;
    if (res.ok) {
      const html = await res.text();
      const lower = html.toLowerCase();
      result.html_length = html.length;
      result.is_js_shell = html.length < 5000;
      result.buyback_found = searchHtml(html);
      result.keyword_matches = KEYWORDS.filter((kw) => lower.includes(kw));

      // Show snippets around every occurrence of "buy" to see what text ASX actually uses
      const buyContexts: string[] = [];
      let searchFrom = 0;
      while (buyContexts.length < 10) {
        const idx = lower.indexOf("buy", searchFrom);
        if (idx === -1) break;
        const snippet = html.slice(Math.max(0, idx - 40), idx + 80).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (snippet) buyContexts.push(snippet);
        searchFrom = idx + 3;
      }
      result.buy_contexts = buyContexts;

      // Also look for "3c" and "3d" patterns
      const formContexts: string[] = [];
      for (const pat of ["3c", "3d", "3-c", "3-d"]) {
        const idx = lower.indexOf(pat);
        if (idx !== -1) {
          formContexts.push(`[${pat}] ` + html.slice(Math.max(0, idx - 60), idx + 80).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        }
      }
      result.form_contexts = formContexts;

      // First 1000 chars of visible text (strip tags) to see page structure
      result.text_sample = html.slice(0, 3000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 800);
    } else {
      result.body = (await res.text()).slice(0, 400);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return Response.json(result);
}
