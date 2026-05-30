/**
 * ASX buyback detection via the MarkitDigital API that powers asx.com.au.
 *
 * Confirmed working endpoints (discovered via browser DevTools):
 *   Search:  asx.api.markitdigital.com/asx-research/1.0/search/predictive?searchText={code}
 *   Ann:     asx.api.markitdigital.com/asx-research/1.0/markets/announcements?entityXids={xid}&...
 *
 * POST /api/buybacks  { codes: string[] }  — batch ≤25 codes
 * GET  /api/buybacks?code=BOL              — debug single ticker
 */

export const runtime = "edge";

const MARKIT_BASE = "https://asx.api.markitdigital.com/asx-research/1.0";

const SEARCH_URL = (code: string) =>
  `${MARKIT_BASE}/search/predictive?searchText=${encodeURIComponent(code)}`;

const ANNOUNCEMENTS_URL = (entityXid: string) => {
  const today = new Date().toISOString().slice(0, 10);
  return `${MARKIT_BASE}/markets/announcements?entityXids=${entityXid}&page=0&itemsPerPage=25&summaryCountsDate=${today}`;
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, */*",
  Origin: "https://www.asx.com.au",
  Referer: "https://www.asx.com.au/",
};

const BUYBACK_PATTERNS = [
  "buy-back", "buyback", "buy back",
  "market buy",    // "Market Buy-Back"
  "appendix 3c", "appendix 3d",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBuyback(text: string): boolean {
  const t = text.toLowerCase();
  return BUYBACK_PATTERNS.some((p) => t.includes(p));
}

function searchJson(obj: unknown): boolean {
  if (typeof obj === "string") return isBuyback(obj);
  if (Array.isArray(obj)) return obj.some(searchJson);
  if (obj && typeof obj === "object")
    return Object.values(obj as Record<string, unknown>).some(searchJson);
  return false;
}

async function safeFetch(url: string, options?: RequestInit) {
  return fetch(url, { signal: AbortSignal.timeout(9_000), ...options });
}

// ── Step 1: get entityXid for an ASX code ─────────────────────────────────────

async function getEntityXid(code: string): Promise<string | null> {
  try {
    const res = await safeFetch(SEARCH_URL(code), { headers: HEADERS });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;

    // Walk whichever array shape the API returns
    const items: unknown[] =
      (data?.data as Record<string, unknown>)?.items as unknown[] ??
      (data?.results as unknown[]) ??
      (data?.items as unknown[]) ??
      (Array.isArray(data) ? data as unknown[] : []);

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const sym = String(rec.symbol ?? rec.code ?? rec.asxCode ?? rec.ticker ?? "").toUpperCase();
      if (sym === code.toUpperCase()) {
        const xid = rec.xidEntity ?? rec.entityXid ?? rec.entityXids ?? rec.xid ?? rec.id;
        if (xid) return String(xid);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Step 2: check announcements for a buy-back ────────────────────────────────

async function checkAnnouncements(entityXid: string): Promise<boolean> {
  try {
    const res = await safeFetch(ANNOUNCEMENTS_URL(entityXid), { headers: HEADERS });
    if (!res.ok) return false;
    return searchJson(await res.json());
  } catch {
    return false;
  }
}

// ── Full pipeline ──────────────────────────────────────────────────────────────

async function checkCode(code: string) {
  const entityXid = await getEntityXid(code);
  if (!entityXid) return { active: false, _err: `entityXid not found for ${code}` };
  const active = await checkAnnouncements(entityXid);
  return { active, entityXid };
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

// ── GET — debug ────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "BOL").toUpperCase();
  const result: Record<string, unknown> = { code, runtime: "edge" };

  // Step 1 — entity lookup
  const searchUrl = SEARCH_URL(code);
  result.search_url = searchUrl;
  try {
    const res = await safeFetch(searchUrl, { headers: HEADERS });
    result.search_status = res.status;
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      result.search_sample = JSON.stringify(data).slice(0, 600);

      const items: unknown[] =
        (data?.data as Record<string, unknown>)?.items as unknown[] ??
        (data?.results as unknown[]) ??
        (data?.items as unknown[]) ??
        (Array.isArray(data) ? data as unknown[] : []);

      let xid: string | null = null;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const sym = String(rec.symbol ?? rec.code ?? rec.asxCode ?? rec.ticker ?? "").toUpperCase();
        if (sym === code) {
          const v = rec.entityXid ?? rec.entityXids ?? rec.xid ?? rec.id;
          if (v) { xid = String(v); break; }
        }
      }
      result.entity_xid = xid;

      // Step 2 — announcements
      if (xid) {
        const annUrl = ANNOUNCEMENTS_URL(xid);
        result.announcements_url = annUrl;
        const annRes = await safeFetch(annUrl, { headers: HEADERS });
        result.announcements_status = annRes.status;
        if (annRes.ok) {
          const ann = await annRes.json();
          result.buyback_found = searchJson(ann);
          result.announcements_sample = JSON.stringify(ann).slice(0, 800);
        } else {
          result.announcements_body = (await annRes.text()).slice(0, 300);
        }
      }
    } else {
      result.search_body = (await res.text()).slice(0, 300);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return Response.json(result);
}
