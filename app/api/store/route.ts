/**
 * The server-side copy of what used to live only in one browser.
 *
 *   GET    /api/store?meta=1        -> { configured, signedIn, meta: { key: updatedAt } }
 *   GET    /api/store?keys=a,b      -> { ..., items: { key: { value, updatedAt } } }
 *   PUT    /api/store               { key, value, updatedAt } -> { stored, updatedAt }
 *   DELETE /api/store?key=a         -> { deleted }
 *   GET    /api/store?selftest=1    -> { ok, backend }   (no data, no sign-in)
 *
 * Doug, 2026-11-14: "I definitely want storage so I can access from anywhere"
 * and "I want Phase 2 data stored as well, using the master."
 *
 * WHAT IS STORED. Exactly the things the app already kept in localStorage, one
 * row per store, as the same JSON text: the Stock Doctor CSV, the Phase 2
 * scores and PE history, the 3PTL run, holdings, manual sentiment overrides,
 * buybacks, the commodity complex and red flags. Nothing is reshaped on the
 * way in or out, so the browser copy and the server copy are interchangeable
 * and the app keeps working offline or signed out on whatever it has locally.
 * (QAV score history has had its own table since September — /api/history.)
 *
 * WHICH COPY WINS. Each row carries the time the browser last wrote it. A PUT
 * is applied only if it is NEWER than what is stored, so a phone opening with
 * a stale copy can never overwrite the desktop's fresh one; the browser
 * compares the same timestamps to decide whether to pull or push
 * (lib/server-store.ts). Last writer wins, per store — right for one person
 * on a few devices, and no more machinery than that needs.
 *
 * WHO CAN READ IT. Nobody without the passcode cookie (lib/server-auth.ts).
 * With no QAV_PASSCODE set the whole route answers `configured: false`.
 *
 * BACKEND. Postgres, the same Neon database /api/history uses, in one table
 * created on first use. A preview deployment is deliberately NOT connected to
 * that database, so there — and only there, see `previewSandbox` — a
 * per-instance Map stands in, which is what lets sync be exercised end to end
 * before it ships. It forgets everything on a cold start and cannot be
 * selected in production.
 */
import { createPool, VercelPool } from "@vercel/postgres";
import { requireSession, previewSandbox } from "@/lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The stores that may be written. Anything else is refused, so the table
 *  cannot be used as a general-purpose bucket by whoever holds the passcode. */
const ALLOWED_KEYS = new Set([
  "qav_csv_v1",
  "qav_phase2_v1",
  "qav_trendline_v1",
  "qav_holdings_v1",
  "qav_sentiment_v1",
  "qav_buybacks_v1",
  "qav_commodity_v1",
  "qav_redflags_v1",
  "qav_asx_financials_v1",
]);

/** Generous for the largest store (Phase 2 is ~0.5MB) and well under Vercel's
 *  4.5MB request limit. */
const MAX_VALUE_CHARS = 3_000_000;

const NS = "main";
const NO_STORE = { "Cache-Control": "no-store" };

interface Item { value: string; updatedAt: string }

// ── Backends ────────────────────────────────────────────────────────────────

interface Backend {
  name: string;
  meta(ns: string): Promise<Record<string, string>>;
  get(ns: string, keys: string[]): Promise<Record<string, Item>>;
  /** Stores only if `updatedAt` is newer than what is there. Returns the
   *  timestamp now held and whether this write was the one applied. */
  put(ns: string, key: string, value: string, updatedAt: string): Promise<{ stored: boolean; updatedAt: string }>;
  del(ns: string, key: string): Promise<boolean>;
}

function connectionString(): string | undefined {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || undefined;
}

let pool: VercelPool | null = null;
function db(): VercelPool {
  if (!pool) pool = createPool({ connectionString: connectionString() });
  return pool;
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await db().sql`
    CREATE TABLE IF NOT EXISTS qav_store (
      ns         TEXT        NOT NULL,
      key        TEXT        NOT NULL,
      value      TEXT        NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (ns, key)
    )`;
  tableReady = true;
}

/** Whatever the driver hands back (Date or string) -> ISO string. */
function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

const postgres: Backend = {
  name: "postgres",
  async meta(ns) {
    await ensureTable();
    const res = await db().sql`SELECT key, updated_at FROM qav_store WHERE ns = ${ns}`;
    const out: Record<string, string> = {};
    for (const r of res.rows) out[String(r.key)] = iso(r.updated_at);
    return out;
  },
  async get(ns, keys) {
    await ensureTable();
    const out: Record<string, Item> = {};
    // One query per key: at most eight, and it keeps the SQL free of an
    // array parameter whose handling differs between drivers.
    for (const key of keys) {
      const res = await db().sql`SELECT value, updated_at FROM qav_store WHERE ns = ${ns} AND key = ${key}`;
      if (res.rows.length) out[key] = { value: String(res.rows[0].value), updatedAt: iso(res.rows[0].updated_at) };
    }
    return out;
  },
  async put(ns, key, value, updatedAt) {
    await ensureTable();
    const res = await db().sql`
      INSERT INTO qav_store (ns, key, value, updated_at)
      VALUES (${ns}, ${key}, ${value}, ${updatedAt})
      ON CONFLICT (ns, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
        WHERE qav_store.updated_at < EXCLUDED.updated_at
      RETURNING updated_at`;
    if (res.rows.length) return { stored: true, updatedAt: iso(res.rows[0].updated_at) };
    // Nothing returned: a newer copy was already there and was kept.
    const cur = await db().sql`SELECT updated_at FROM qav_store WHERE ns = ${ns} AND key = ${key}`;
    return { stored: false, updatedAt: cur.rows.length ? iso(cur.rows[0].updated_at) : updatedAt };
  },
  async del(ns, key) {
    await ensureTable();
    const res = await db().sql`DELETE FROM qav_store WHERE ns = ${ns} AND key = ${key}`;
    return (res.rowCount ?? 0) > 0;
  },
};

const memoryRows = new Map<string, Item>();
const memory: Backend = {
  name: "memory",
  async meta(ns) {
    const out: Record<string, string> = {};
    memoryRows.forEach((item, k) => { if (k.startsWith(`${ns}|`)) out[k.slice(ns.length + 1)] = item.updatedAt; });
    return out;
  },
  async get(ns, keys) {
    const out: Record<string, Item> = {};
    for (const key of keys) {
      const item = memoryRows.get(`${ns}|${key}`);
      if (item) out[key] = item;
    }
    return out;
  },
  async put(ns, key, value, updatedAt) {
    const cur = memoryRows.get(`${ns}|${key}`);
    if (cur && cur.updatedAt >= updatedAt) return { stored: false, updatedAt: cur.updatedAt };
    memoryRows.set(`${ns}|${key}`, { value, updatedAt });
    return { stored: true, updatedAt };
  },
  async del(ns, key) {
    return memoryRows.delete(`${ns}|${key}`);
  },
};

/** null when there is nowhere to store anything. */
function backend(): Backend | null {
  if (connectionString()) return postgres;
  return previewSandbox() ? memory : null;
}

function fail(e: unknown, status = 500) {
  return Response.json(
    { configured: true, error: e instanceof Error ? e.message : "store failed" },
    { status, headers: NO_STORE },
  );
}

// ── Self-test ───────────────────────────────────────────────────────────────

/**
 * Write, read back, refuse an older write, delete — in a namespace of its own,
 * so it touches none of the real rows and leaves nothing behind. Returns only
 * pass/fail. It needs no sign-in because it exposes and keeps nothing; it is
 * here so the Postgres path can be proven on production before a passcode
 * exists to sign in with.
 */
async function selfTest(b: Backend) {
  const ns = "selftest";
  const key = "qav_csv_v1";
  const t1 = new Date(Date.now() - 1000).toISOString();
  const t2 = new Date().toISOString();
  const steps: Record<string, boolean> = {};
  await b.del(ns, key);
  steps.write = (await b.put(ns, key, "first", t2)).stored === true;
  steps.readBack = (await b.get(ns, [key]))[key]?.value === "first";
  steps.olderWriteRefused = (await b.put(ns, key, "older", t1)).stored === false;
  steps.stillFirst = (await b.get(ns, [key]))[key]?.value === "first";
  steps.metaListsIt = typeof (await b.meta(ns))[key] === "string";
  steps.deleted = (await b.del(ns, key)) === true;
  steps.goneAfterDelete = (await b.get(ns, [key]))[key] === undefined;
  return { ok: Object.values(steps).every(Boolean), backend: b.name, steps };
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const b = backend();

  if (sp.get("selftest")) {
    if (!b) return Response.json({ ok: false, backend: null, reason: "no database connection string" }, { headers: NO_STORE });
    try { return Response.json(await selfTest(b), { headers: NO_STORE }); }
    catch (e) { return Response.json({ ok: false, backend: b.name, error: e instanceof Error ? e.message : "failed" }, { status: 500, headers: NO_STORE }); }
  }

  const denied = requireSession(request);
  if (denied) return denied;
  if (!b) return Response.json({ configured: false, reason: "no database connection string" }, { headers: NO_STORE });

  try {
    if (sp.get("meta")) {
      return Response.json({ configured: true, signedIn: true, meta: await b.meta(NS) }, { headers: NO_STORE });
    }
    const keys = (sp.get("keys") ?? "").split(",").map((k) => k.trim()).filter((k) => ALLOWED_KEYS.has(k));
    if (!keys.length) return Response.json({ error: "meta=1 or keys=… required" }, { status: 400, headers: NO_STORE });
    return Response.json({ configured: true, signedIn: true, items: await b.get(NS, keys) }, { headers: NO_STORE });
  } catch (e) { return fail(e); }
}

export async function PUT(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const b = backend();
  if (!b) return Response.json({ configured: false, reason: "no database connection string" }, { headers: NO_STORE });

  let body: { key?: unknown; value?: unknown; updatedAt?: unknown };
  try { body = await request.json(); } catch { return fail(new Error("invalid JSON"), 400); }
  const { key, value, updatedAt } = body;
  if (typeof key !== "string" || !ALLOWED_KEYS.has(key)) return fail(new Error("unknown key"), 400);
  if (typeof value !== "string" || value.length === 0) return fail(new Error("value must be a non-empty string"), 400);
  if (value.length > MAX_VALUE_CHARS) return fail(new Error("value too large"), 413);
  const when = typeof updatedAt === "string" ? new Date(updatedAt) : new Date(NaN);
  if (isNaN(when.getTime())) return fail(new Error("updatedAt must be an ISO timestamp"), 400);

  try {
    const result = await b.put(NS, key, value, when.toISOString());
    return Response.json({ configured: true, ...result }, { headers: NO_STORE });
  } catch (e) { return fail(e); }
}

export async function DELETE(request: Request) {
  const denied = requireSession(request);
  if (denied) return denied;
  const b = backend();
  if (!b) return Response.json({ configured: false, reason: "no database connection string" }, { headers: NO_STORE });
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!ALLOWED_KEYS.has(key)) return fail(new Error("unknown key"), 400);
  try {
    return Response.json({ configured: true, deleted: await b.del(NS, key) }, { headers: NO_STORE });
  } catch (e) { return fail(e); }
}
