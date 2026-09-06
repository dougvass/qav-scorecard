/**
 * QAV score history — durable storage.
 *
 *   GET  /api/history            -> { configured, data: { CODE: [points...] } }
 *   GET  /api/history?code=BOL   -> one stock's full series
 *   POST /api/history            -> upsert a snapshot: { date, rows: [...] }
 *
 * Backed by Postgres (the Vercel/Neon integration sets POSTGRES_URL). When no
 * connection string is present every route returns `configured: false` instead
 * of throwing, so the client falls back to its localStorage mirror and the
 * feature still works — the app must never break because the DB isn't set up.
 *
 * No ORM and no migration tool for one table: `ensureTable` runs a CREATE TABLE
 * IF NOT EXISTS on first use, which is idempotent and costs one round trip.
 */
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Row {
  code: string;
  qav: number | null;
  quality: number | null;
  pcf: number | null;
  sentiment: string | null;
  price: number | null;
}

function configured(): boolean {
  return !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS qav_history (
      snapshot_date DATE   NOT NULL,
      code          TEXT   NOT NULL,
      qav           REAL,
      quality       REAL,
      pcf           REAL,
      sentiment     TEXT,
      price         REAL,
      PRIMARY KEY (snapshot_date, code)
    )`;
  tableReady = true;
}

/** yyyy-mm-dd, whatever the driver hands back (Date or string). */
function iso(d: unknown): string {
  if (d instanceof Date) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return String(d).slice(0, 10);
}

export async function GET(request: Request) {
  if (!configured()) {
    return Response.json({ configured: false, data: {}, reason: "POSTGRES_URL not set" });
  }
  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  try {
    await ensureTable();
    const res = code
      ? await sql`SELECT snapshot_date, code, qav, quality, pcf, sentiment, price
                    FROM qav_history WHERE code = ${code} ORDER BY snapshot_date`
      : await sql`SELECT snapshot_date, code, qav, quality, pcf, sentiment, price
                    FROM qav_history ORDER BY snapshot_date`;

    const data: Record<string, unknown[]> = {};
    for (const r of res.rows) {
      const c = String(r.code);
      (data[c] ??= []).push({
        d: iso(r.snapshot_date),
        qav: r.qav, quality: r.quality, pcf: r.pcf,
        sentiment: r.sentiment, price: r.price,
      });
    }
    return Response.json({ configured: true, stocks: Object.keys(data).length, data });
  } catch (e) {
    return Response.json(
      { configured: true, data: {}, error: e instanceof Error ? e.message : "query failed" },
      { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as { date?: string; rows?: Row[] };
  const date = body.date;
  const rows = (body.rows ?? []).filter((r) => r?.code);
  if (!date || !rows.length) {
    return Response.json({ error: "date and rows required" }, { status: 400 });
  }
  if (!configured()) {
    return Response.json({ configured: false, written: 0, reason: "POSTGRES_URL not set" });
  }

  try {
    await ensureTable();
    // One multi-row INSERT rather than ~450 statements. Postgres caps a
    // statement at 65535 parameters; at 7 per row we chunk well under that,
    // and chunking also keeps any single statement comfortably fast.
    const CHUNK = 500;
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const tuples = slice.map((r) => {
        const b = params.length;
        params.push(date, r.code.toUpperCase(), r.qav, r.quality, r.pcf, r.sentiment, r.price);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      });
      const text =
        `INSERT INTO qav_history (snapshot_date, code, qav, quality, pcf, sentiment, price)
         VALUES ${tuples.join(",")}
         ON CONFLICT (snapshot_date, code) DO UPDATE SET
           qav = EXCLUDED.qav, quality = EXCLUDED.quality, pcf = EXCLUDED.pcf,
           sentiment = EXCLUDED.sentiment, price = EXCLUDED.price`;
      const res = await sql.query(text, params);
      written += res.rowCount ?? slice.length;
    }
    return Response.json({ configured: true, written, date });
  } catch (e) {
    return Response.json(
      { configured: true, written: 0, error: e instanceof Error ? e.message : "insert failed" },
      { status: 500 });
  }
}
