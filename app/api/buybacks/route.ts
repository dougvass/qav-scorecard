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

const TOKEN_URL = "https://www.asx.com.au/token.json";

const SEARCH_URL = (code: string) =>
  `https://asx.api.markitdigital.com/asx-research/1.0/data/predictive?searchText=${encodeURIComponent(code)}&size=5`;

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
  try {
    const res = await fetch(TOKEN_URL, {
      headers: BASE_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    // Try common token field names
    return (
      (data.token as string) ??
      (data.access_token as string) ??
      (data.value as string) ??
      null
    );
  } catch {
    return null;
  }
}

// ── Step 2: look up entityXid for an ASX code ─────────────────────────────────

async function getEntityXid(code: string, token: string | null): Promise<string | null> {
  try {
    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(SEARCH_URL(code), {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;

    // Walk common response shapes to find entityXid matching the exact ticker
    const items: unknown[] =
      (data?.data as Record<string, unknown>)?.items as unknown[] ??
      (data?.results as unknown[]) ??
      (data?.items as unknown[]) ??
      (Array.isArray(data) ? data : []);

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const sym = String(rec.symbol ?? rec.code ?? rec.ticker ?? "").toUpperCase();
      if (sym === code.toUpperCase()) {
        const xid = rec.entityXid ?? rec.entityXids ?? rec.xid ?? rec.id;
        if (xid) return String(xid);
      }
    }
    return null;
  } catch {
    return null;
  }
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
  const entityXid = await getEntityXid(code, token);
  if (!entityXid) return { active: false, _err: `No entityXid found for ${code}` };
  const active = await checkAnnouncements(entityXid, token);
  return { active, entityXid };
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

  // Step 1 — token
  const tokenRes = await fetch(TOKEN_URL, {
    headers: BASE_HEADERS,
    signal: AbortSignal.timeout(8_000),
  }).catch((e) => ({ ok: false, status: 0, json: async () => ({}), text: async () => String(e) } as unknown as Response));

  result.token_status = tokenRes.status;
  let token: string | null = null;
  if (tokenRes.ok) {
    const td = await tokenRes.json() as Record<string, unknown>;
    result.token_fields = Object.keys(td);
    token = (td.token ?? td.access_token ?? td.value ?? null) as string | null;
    result.token_found = !!token;
    result.token_preview = token ? token.slice(0, 20) + "…" : null;
  } else {
    result.token_body = (await tokenRes.text().catch(() => "")).slice(0, 200);
  }

  // Step 2 — entity lookup
  const searchUrl = SEARCH_URL(code);
  result.search_url = searchUrl;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const searchRes = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(8_000) })
    .catch((e) => ({ ok: false, status: 0, json: async () => ({}), text: async () => String(e) } as unknown as Response));

  result.search_status = searchRes.status;
  let entityXid: string | null = null;
  if (searchRes.ok) {
    const sd = await searchRes.json() as Record<string, unknown>;
    result.search_sample = JSON.stringify(sd).slice(0, 600);
    // Try to extract entityXid
    const items: unknown[] =
      (sd?.data as Record<string, unknown>)?.items as unknown[] ??
      (sd?.results as unknown[]) ??
      (sd?.items as unknown[]) ??
      (Array.isArray(sd) ? sd : []);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const sym = String(rec.symbol ?? rec.code ?? rec.ticker ?? "").toUpperCase();
      if (sym === code) {
        const xid = rec.entityXid ?? rec.entityXids ?? rec.xid ?? rec.id;
        if (xid) { entityXid = String(xid); break; }
      }
    }
    result.entity_xid = entityXid;
  } else {
    result.search_body = (await searchRes.text().catch(() => "")).slice(0, 300);
  }

  // Step 3 — announcements
  if (entityXid) {
    const annUrl = ANNOUNCEMENTS_URL(entityXid);
    result.announcements_url = annUrl;
    const annRes = await fetch(annUrl, { headers, signal: AbortSignal.timeout(8_000) })
      .catch((e) => ({ ok: false, status: 0, json: async () => ({}), text: async () => String(e) } as unknown as Response));
    result.announcements_status = annRes.status;
    if (annRes.ok) {
      const ad = await annRes.json();
      result.buyback_found = searchJson(ad);
      result.announcements_sample = JSON.stringify(ad).slice(0, 800);
    } else {
      result.announcements_body = (await annRes.text().catch(() => "")).slice(0, 300);
    }
  }

  return Response.json(result);
}
