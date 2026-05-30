/**
 * POST /api/buybacks  { codes: string[] }
 *   For each code:
 *   1. Fetch the ASX announcement HTML page to extract the Next.js build ID
 *   2. Fetch the pre-rendered JSON data file at /_next/data/{buildId}/...
 *   3. Walk the JSON and search for Appendix 3C / 3D (buyback) document types
 *
 * GET /api/buybacks?code=BOL
 *   Debug — shows the full pipeline result for one ticker.
 */

export const runtime = "edge";

const ASX_HTML_URL = (code: string) =>
  `https://www.asx.com.au/markets/trade-our-cash-market/announcements.${code.toLowerCase()}`;

const ASX_JSON_URL = (buildId: string, code: string) =>
  `https://www.asx.com.au/_next/data/${buildId}/markets/trade-our-cash-market/announcements.${code.toLowerCase()}.json`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-AU,en;q=0.9",
  Referer: "https://www.asx.com.au/",
};

const JSON_HEADERS = {
  ...HEADERS,
  Accept: "application/json, */*",
  "x-nextjs-data": "1",
};

// Document types / keywords that indicate an active buy-back
const BUYBACK_PATTERNS = [
  "appendix 3c", "appendix 3d",
  "buy-back", "buyback", "buy back",
  "3c", "3d",   // short form used in ASX JSON document_type fields
];

function isBuybackText(text: string): boolean {
  const t = text.toLowerCase();
  // "3c" and "3d" are short so only match when they appear as a document type
  // (surrounded by quotes or whitespace in JSON/HTML), not as part of other strings.
  if (t === "3c" || t === "3d") return true;
  return BUYBACK_PATTERNS.slice(0, -2).some((kw) => t.includes(kw));
}

function searchJson(obj: unknown): boolean {
  if (typeof obj === "string") return isBuybackText(obj);
  if (Array.isArray(obj)) return obj.some(searchJson);
  if (obj && typeof obj === "object") return Object.values(obj).some(searchJson);
  return false;
}

/** Extract Next.js build ID from the HTML's __NEXT_DATA__ script tag */
function extractBuildId(html: string): string | null {
  // <script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123",...}</script>
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return data?.buildId ?? null;
  } catch {
    return null;
  }
}

async function checkCode(code: string): Promise<{
  active: boolean;
  method?: string;
  _status?: number;
  _json_status?: number;
  _err?: string;
}> {
  // Step 1: fetch HTML to get the build ID
  let buildId: string | null = null;
  let htmlStatus = 0;
  try {
    const res = await fetch(ASX_HTML_URL(code), {
      headers: HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    htmlStatus = res.status;
    if (res.ok) {
      const html = await res.text();
      buildId = extractBuildId(html);
    }
  } catch (e) {
    return { active: false, _err: `HTML fetch: ${e instanceof Error ? e.message : e}` };
  }

  if (!buildId) {
    return { active: false, _status: htmlStatus, _err: "Could not find Next.js buildId in page HTML" };
  }

  // Step 2: fetch the Next.js pre-rendered JSON data
  const jsonUrl = ASX_JSON_URL(buildId, code);
  try {
    const res = await fetch(jsonUrl, {
      headers: JSON_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { active: false, _status: htmlStatus, _json_status: res.status, _err: `JSON fetch: ${res.status}` };
    }
    const json = await res.json();
    const active = searchJson(json);
    return { active, method: "nextjs-data", _status: htmlStatus, _json_status: res.status };
  } catch (e) {
    return { active: false, _status: htmlStatus, _err: `JSON fetch: ${e instanceof Error ? e.message : e}` };
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
  const code = (searchParams.get("code") ?? "BOL").toUpperCase();

  const result: Record<string, unknown> = {
    code,
    html_url: ASX_HTML_URL(code),
    runtime: "edge",
  };

  // Step 1: get HTML + build ID
  let buildId: string | null = null;
  try {
    const res = await fetch(ASX_HTML_URL(code), {
      headers: HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    result.html_status = res.status;
    if (res.ok) {
      const html = await res.text();
      result.html_length = html.length;
      buildId = extractBuildId(html);
      result.build_id = buildId;

      // Also show a fragment of the __NEXT_DATA__ for debugging
      const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]{1,2000}?)<\/script>/);
      result.next_data_sample = m ? m[1].slice(0, 500) : "NOT FOUND";
    }
  } catch (e) {
    result.html_error = e instanceof Error ? e.message : String(e);
  }

  if (!buildId) {
    result.result = "FAILED — no buildId found";
    return Response.json(result);
  }

  // Step 2: fetch Next.js JSON data
  const jsonUrl = ASX_JSON_URL(buildId, code);
  result.json_url = jsonUrl;
  try {
    const res = await fetch(jsonUrl, {
      headers: JSON_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    result.json_status = res.status;
    if (res.ok) {
      const json = await res.json();
      result.buyback_found = searchJson(json);
      // Show a condensed sample of the JSON to understand its structure
      result.json_sample = JSON.stringify(json).slice(0, 1000);
    } else {
      result.json_body = (await res.text()).slice(0, 400);
    }
  } catch (e) {
    result.json_error = e instanceof Error ? e.message : String(e);
  }

  return Response.json(result);
}
