/**
 * ASX buyback detection using the MarkitDigital API that powers asx.com.au.
 *
 * Three-step chain per ticker:
 *  1. GET https://www.asx.com.au/token.json          → bearer token
 *  2. GET asx.api.markitdigital.com/.../predictive?searchText={code}
 *                                                     → entityXid for the ticker
 *  3. GET asx.api.markitdigital.com/.../announcements?entityXids={xid}
 *                                                     → announcement list
 *     Search result JSON for "buy-back", "Market Buy-Back", etc.
 *
 * POST /api/buybacks  { codes: string[] }  — batch check (≤25 codes)
 * GET  /api/buybacks?code=BOL              — debug single ticker
 */

export const runtime = "edge";

// ── Constants ─────────────────────────────────────────────────────────────────

// Token endpoint — the correct URL is still TBD; we try a few candidates
const TOKEN_CANDIDATES = [
  "https://asx.api.markitdigital.com/asx-research/1.0/token",
  "https://asx.api.markitdigital.com/token.json",
  "https://www.asx.com.au/asx/json/token.json",
];

// Search/predictive endpoint — try multiple sub-paths until one returns 200
const SEARCH_CANDIDATES = (code: string) => [
  `https://asx.api.markitdigital.com/asx-research/1.0/company/predictive?searchText=${encodeURIComponent(code)}&size=5`,
  `https://asx.api.markitdigital.com/asx-research/1.0/markets/company/predictive?searchText=${encodeURIComponent(code)}&size=5`,
  `https://asx.api.markitdigital.com/asx-research/1.0/search?q=${encodeURIComponent(code)}&size=5`,
  `https://asx.api.markitdigital.com/asx-research/1.0/company/search?q=${encodeURIComponent(code)}&size=5`,
  `https://asx.api.markitdigital.com/asx-research/1.0/company/lookup?asxCode=${encodeURIComponent(code)}`,
];

const ANNOUNCEMENTS_URL = (entityXid: string) => {
  const today = new Date().toISOString().slice(0, 10);
  return `https://asx.api.markitdigital.com/asx-research/1.0/markets/announcements?entityXids=${entityXid}&page=0&itemsPerPage=25&summaryCountsDate=${today}`;
};

const BUYBACK_PATTERNS = [
  "buy-back",
  "buyback",
  "buy back",
  "market buy",     // "Market Buy-Back"
  "appendix 3c",
  "appendix 3d",
];

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBuyback(text: string): boolean {
  const t = text.toLowerCase();
  return BUYBACK_PATTERNS.some((p) => t.includes(p));
}

function searchJson(obj: unknown): boolean {
  if (typeof obj === "string") return isBuyback(obj);
  if (Array.isArray(obj)) return obj.some(searchJson);
  if (obj && typeof obj === "object") return Object.values(obj as Record<string, unknown>).some(searchJson);
  return false;
}

// ── Step 1: get bearer token ──────────────────────────────────────────────────

async function getToken(): Promise<string | null> {
  for (const url of TOKEN_CANDIDATES) {
    try {
      const res = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) continue;
      const data = await res.json() as Record<string, unknown>;
      const tok = (data.token ?? data.access_token ?? data.value ?? null) as string | null;
      if (tok) return tok;
    } catch { /* try next */ }
  }
  return null; // no token found — try unauthenticated
}

// ── Step 2: look up entityXid for an ASX code ─────────────────────────────────

function extractXidFromData(data: unknown, code: string): string | null {
  if (!data || typeof data !== "object") return null;
  // Try known response shapes
  const obj = data as Record<string, unknown>;
  const items: unknown[] =
    (obj?.data as Record<string, unknown>)?.items as unknown[] ??
    (obj?.results as unknown[]) ??
    (obj?.items as unknown[]) ??
    (obj?.data as unknown[]) ??
    (Array.isArray(data) ? data as unknown[] : []);

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const sym = String(rec.symbol ?? rec.code ?? rec.asxCode ?? rec.ticker ?? "").toUpperCase();
    if (sym === code.toUpperCase()) {
      const xid = rec.entityXid ?? rec.entityXids ?? rec.xid ?? rec.id;
      if (xid) return String(xid);
    }
  }
  return null;
}

async function getEntityXid(code: string, token: string | null): Promise<{ xid: string | null; usedUrl: string | null }> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  for (const url of SEARCH_CANDIDATES(code)) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(6_000) });
      if (!res.ok) continue;
      const data = await res.json();
      const xid = extractXidFromData(data, code);
      if (xid) return { xid, usedUrl: url };
    } catch { /* try next */ }
  }
  return { xid: null, usedUrl: null };
}

// ── Step 3: check announcements for buy-back ──────────────────────────────────

async function checkAnnouncements(entityXid: string, token: string | null): Promise<boolean> {
  try {
    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(ANNOUNCEMENTS_URL(entityXid), {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return searchJson(json);
  } catch {
    return false;
  }
}

// ── Full pipeline for one code ────────────────────────────────────────────────

async function checkCode(code: string, token: string | null) {
  const { xid, usedUrl } = await getEntityXid(code, token);
  if (!xid) return { active: false, _err: `No entityXid found for ${code}` };
  const active = await checkAnnouncements(xid, token);
  return { active, entityXid: xid, _searchUrl: usedUrl };
}

// ── POST — batch ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = (await request.json()) as { codes?: string[] };
  const codes = (body.codes ?? []).slice(0, 25);
  if (!codes.length) return Response.json({ error: "codes required" }, { status: 400 });

  // Fetch token once, share across all codes in the batch
  const token = await getToken();
  const results = await Promise.all(codes.map((c) => checkCode(c, token)));
  const out: Record<string, object> = {};
  codes.forEach((c, i) => { out[c] = results[i]; });
  return Response.json(out);
}

// ── GET — debug one ticker ────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "BOL").toUpperCase();
  const result: Record<string, unknown> = { code, runtime: "edge" };

  // ── A. Test announcements directly with BOL's known entityXid (no auth needed?) ──
  // This tells us immediately whether the API is open or requires a token.
  const KNOWN_BOL_XID = "204124452";
  const testUrl = ANNOUNCEMENTS_URL(KNOWN_BOL_XID);
  result.direct_test_url = testUrl;
  try {
    const r = await fetch(testUrl, { headers: BASE_HEADERS, signal: AbortSignal.timeout(8_000) });
    result.direct_test_status = r.status;
    if (r.ok) {
      const data = await r.json();
      result.direct_test_buyback_found = searchJson(data);
      result.direct_test_sample = JSON.stringify(data).slice(0, 600);
    } else {
      result.direct_test_body = (await r.text()).slice(0, 300);
    }
  } catch (e) { result.direct_test_err = String(e); }

  // ── B. Try token candidates ───────────────────────────────────────────────
  const tokenResults: Record<string, unknown>[] = [];
  let token: string | null = null;
  for (const url of TOKEN_CANDIDATES) {
    const tr: Record<string, unknown> = { url };
    try {
      const r = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(5_000) });
      tr.status = r.status;
      if (r.ok) {
        const ct = r.headers.get("content-type") ?? "";
        tr.content_type = ct;
        if (ct.includes("json")) {
          const data = await r.json() as Record<string, unknown>;
          tr.fields = Object.keys(data);
          tr.sample = JSON.stringify(data).slice(0, 200);
          const tok = (data.token ?? data.access_token ?? data.value ?? null) as string | null;
          if (tok && !token) { token = tok; tr.token_found = true; }
        }
      } else {
        tr.body_preview = (await r.text()).slice(0, 100);
      }
    } catch (e) { tr.err = String(e); }
    tokenResults.push(tr);
  }
  result.token_candidates = tokenResults;
  result.token_found = !!token;

  // ── C. Try search/predictive candidates ──────────────────────────────────
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const searchResults: Record<string, unknown>[] = [];
  let entityXid: string | null = null;
  let workingSearchUrl: string | null = null;
  for (const url of SEARCH_CANDIDATES(code)) {
    const sr: Record<string, unknown> = { url };
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6_000) });
      sr.status = r.status;
      if (r.ok) {
        const data = await r.json();
        sr.sample = JSON.stringify(data).slice(0, 300);
        const xid = extractXidFromData(data, code);
        sr.xid_found = xid;
        if (xid && !entityXid) { entityXid = xid; workingSearchUrl = url; }
      } else {
        sr.body = (await r.text()).slice(0, 150);
      }
    } catch (e) { sr.err = String(e); }
    searchResults.push(sr);
    if (entityXid) break; // stop once we find a working one
  }
  result.search_candidates = searchResults;
  result.entity_xid = entityXid;
  result.working_search_url = workingSearchUrl;

  // ── D. Announcements with found entityXid ────────────────────────────────
  if (entityXid) {
    const annUrl = ANNOUNCEMENTS_URL(entityXid);
    result.announcements_url = annUrl;
    try {
      const r = await fetch(annUrl, { headers, signal: AbortSignal.timeout(8_000) });
      result.announcements_status = r.status;
      if (r.ok) {
        const data = await r.json();
        result.buyback_found = searchJson(data);
        result.announcements_sample = JSON.stringify(data).slice(0, 600);
      } else {
        result.announcements_body = (await r.text()).slice(0, 300);
      }
    } catch (e) { result.announcements_err = String(e); }
  }

  return Response.json(result);
}
