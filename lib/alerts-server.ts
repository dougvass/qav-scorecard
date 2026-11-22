/**
 * The alert job: read the holdings, read the market, and tell him what changed.
 * SERVER-ONLY. The rule itself is lib/alerts.ts.
 *
 * WHERE EVERYTHING COMES FROM
 *   holdings, revenue reviews, hand-set commodities
 *       the server store (the same passcode-protected rows the browser mirrors;
 *       see app/api/store). Read straight from the table: the job runs with
 *       nobody signed in.
 *   each holding's 3PTL
 *       this deployment's own /api/trendline-v3. Called over HTTP rather than
 *       imported because that route has to run on the edge runtime — Yahoo
 *       answers it there and not from a Node function.
 *   the commodity complex
 *       this deployment's own /api/commodities.
 *
 * WHERE IT GOES. Email through Resend, and a text message through Twilio, each
 * switched on by its own environment variables and silent without them:
 *   RESEND_API_KEY, ALERT_EMAIL_TO          [ALERT_EMAIL_FROM]
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ALERT_SMS_TO
 * The keys are created and set in Vercel by the site's owner. Nothing here
 * logs them or returns them.
 *
 * WHAT IT REMEMBERS. One row, namespace "alerts": which holdings were a sell
 * at the last run and why. That is what turns "is a sell" into "has BECOME a
 * sell" — without it the same message would go out every evening.
 */
import { createPool, VercelPool } from "@vercel/postgres";
import { COMMODITY_STORAGE_KEY } from "@/lib/commodities";
import { EXPOSURE_STORAGE_KEY, StoredExposure } from "@/lib/revenue-exposure";
import {
  AlertState, EMPTY_STATE, Reading, TrendRead, Verdict, Change,
  evaluateHoldings, diffAlerts, renderMessage, toReading,
} from "@/lib/alerts";

/** A literal, not an import: lib/holdings-storage.ts is a browser module. */
const HOLDINGS_STORAGE_KEY = "qav_holdings_v1";
const STORE_NS = "main";
const ALERT_NS = "alerts";
const STATE_KEY = "state";

// ── The store, read directly ─────────────────────────────────────────────────

function connectionString(): string | undefined {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || undefined;
}

export function hasDatabase(): boolean {
  return !!connectionString();
}

let pool: VercelPool | null = null;
function db(): VercelPool {
  if (!pool) pool = createPool({ connectionString: connectionString() });
  return pool;
}

async function kvGet(ns: string, key: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  try {
    const res = await db().sql`SELECT value FROM qav_store WHERE ns = ${ns} AND key = ${key}`;
    return res.rows.length ? String(res.rows[0].value) : null;
  } catch {
    return null;          // the table does not exist until something is stored
  }
}

async function kvPut(ns: string, key: string, value: string): Promise<void> {
  if (!hasDatabase()) return;
  await db().sql`
    INSERT INTO qav_store (ns, key, value, updated_at)
    VALUES (${ns}, ${key}, ${value}, ${new Date().toISOString()})
    ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function loadState(): Promise<AlertState> {
  const s = parse<AlertState>(await kvGet(ALERT_NS, STATE_KEY));
  return s && typeof s.alerts === "object" && s.alerts ? { ...EMPTY_STATE, ...s } : EMPTY_STATE;
}

// ── Channels ─────────────────────────────────────────────────────────────────

export interface Channels { email: boolean; sms: boolean }

export function channels(): Channels {
  const e = process.env;
  return {
    email: !!(e.RESEND_API_KEY && e.ALERT_EMAIL_TO),
    sms: !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM && e.ALERT_SMS_TO),
  };
}

async function sendEmail(subject: string, text: string, html: string): Promise<string | null> {
  const e = process.env;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Resend's shared sender delivers to the account's own address with no
        // domain to verify, which is all a one-person alert needs.
        from: e.ALERT_EMAIL_FROM || "QAV alerts <onboarding@resend.dev>",
        to: String(e.ALERT_EMAIL_TO).split(",").map((s) => s.trim()).filter(Boolean),
        subject, text, html,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return null;
    const body = await res.text();
    return `email refused (HTTP ${res.status}): ${body.slice(0, 160)}`;
  } catch (err) {
    return `email failed: ${err instanceof Error ? err.message : "network"}`;
  }
}

async function sendSms(body: string): Promise<string | null> {
  const e = process.env;
  try {
    const form = new URLSearchParams({ To: String(e.ALERT_SMS_TO), From: String(e.TWILIO_FROM), Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return null;
    const text = await res.text();
    return `text message refused (HTTP ${res.status}): ${text.slice(0, 160)}`;
  } catch (err) {
    return `text message failed: ${err instanceof Error ? err.message : "network"}`;
  }
}

/** Send through every channel that is switched on. Returns what went wrong, if anything. */
export async function deliver(msg: { subject: string; text: string; html: string; sms: string }): Promise<{ sent: string[]; errors: string[] }> {
  const on = channels();
  const sent: string[] = [];
  const errors: string[] = [];
  if (on.email) {
    const err = await sendEmail(msg.subject, msg.text, msg.html);
    if (err) errors.push(err); else sent.push("email");
  }
  if (on.sms) {
    const err = await sendSms(msg.sms);
    if (err) errors.push(err); else sent.push("text message");
  }
  return { sent, errors };
}

// ── The market, from this deployment's own routes ────────────────────────────

/** `cookie` is passed through so a protected preview deployment lets its own
 *  function call its own routes; production has no such wall. */
async function ownJson(origin: string, path: string, cookie: string | null, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(origin + path, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(40_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function readTrend(origin: string, cookie: string | null, codes: string[]): Promise<Record<string, TrendRead>> {
  const out: Record<string, TrendRead> = {};
  for (let i = 0; i < codes.length; i += 25) {
    const batch = codes.slice(i, i + 25);
    const d = await ownJson(origin, "/api/trendline-v3", cookie, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes: batch }),
    });
    for (const code of batch) {
      const r = d[code] as Record<string, unknown> | undefined;
      if (!r || r.error) continue;
      out[code] = {
        sentiment: toReading(r.sentiment),
        knife: !!r.knife,
        note: typeof r.note === "string" ? r.note : null,
        price: typeof r.price === "number" ? r.price : null,
        sell: typeof r.sell === "number" ? r.sell : null,
      };
    }
  }
  return out;
}

async function readCommodities(origin: string, cookie: string | null): Promise<Record<string, Reading | null>> {
  const d = await ownJson(origin, "/api/commodities", cookie);
  const out: Record<string, Reading | null> = {};
  const all = (d.commodities ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(all)) out[key] = toReading(all[key]?.sentiment);
  return out;
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface RunInput {
  codes: string[];
  exposure: StoredExposure | null;
  manual: Record<string, Reading | undefined>;
}

/** What the store holds for the job. */
export async function storedInput(): Promise<RunInput> {
  const holdings = parse<{ codes?: unknown }>(await kvGet(STORE_NS, HOLDINGS_STORAGE_KEY));
  const exposure = parse<StoredExposure>(await kvGet(STORE_NS, EXPOSURE_STORAGE_KEY));
  const commodity = parse<{ manual?: Record<string, unknown> }>(await kvGet(STORE_NS, COMMODITY_STORAGE_KEY));
  const manual: Record<string, Reading | undefined> = {};
  for (const k of Object.keys(commodity?.manual ?? {})) {
    const r = toReading(commodity?.manual?.[k]);
    if (r) manual[k] = r;
  }
  return {
    codes: Array.isArray(holdings?.codes) ? (holdings!.codes as unknown[]).filter((c): c is string => typeof c === "string") : [],
    exposure: exposure && typeof exposure.reviews === "object" && exposure.reviews ? exposure : null,
    manual,
  };
}

export interface RunResult {
  ok: boolean;
  holdings: number;
  verdicts: Verdict[];
  change: Change | null;
  sent: string[];
  errors: string[];
  commodities: Record<string, Reading | null>;
}

/**
 * One pass. With `remember` the result becomes the new "last run"; a dry run
 * (the check from the browser, a preview) leaves the remembered state alone.
 */
export async function runAlerts(opts: {
  origin: string;
  cookie: string | null;
  input: RunInput;
  send: boolean;
  remember: boolean;
}): Promise<RunResult> {
  const { origin, cookie, input } = opts;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const state = await loadState();
  const empty: RunResult = { ok: true, holdings: input.codes.length, verdicts: [], change: null, sent: [], errors: [], commodities: {} };
  if (!input.codes.length) return empty;

  let trend: Record<string, TrendRead>;
  let commodities: Record<string, Reading | null>;
  try {
    [trend, commodities] = await Promise.all([readTrend(origin, cookie, input.codes), readCommodities(origin, cookie)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "the market data could not be read";
    if (opts.remember) await kvPut(ALERT_NS, STATE_KEY, JSON.stringify({ ...state, lastRun: now.toISOString(), lastError: message }));
    return { ...empty, ok: false, errors: [message] };
  }

  const verdicts = evaluateHoldings(input.codes, trend, commodities, input.manual, input.exposure);
  const change = diffAlerts(state, verdicts, today);
  const news = change.fresh.length > 0 || change.cleared.length > 0;

  let sent: string[] = [];
  let errors: string[] = [];
  if (opts.send && news) {
    const asOf = now.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " Sydney time";
    ({ sent, errors } = await deliver(renderMessage(change, verdicts, origin + "/", asOf)));
  }

  if (opts.remember) {
    // If a message was owed and none got out, keep the OLD picture: the next
    // run then still sees the change and tries again, rather than a sell going
    // unreported because one send failed.
    const delivered = !news || !opts.send || sent.length > 0;
    await kvPut(ALERT_NS, STATE_KEY, JSON.stringify({
      alerts: delivered ? change.next : state.alerts,
      lastRun: now.toISOString(),
      lastSent: sent.length ? now.toISOString() : state.lastSent,
      lastError: errors.length ? errors.join("; ") : null,
    } satisfies AlertState));
  }

  return { ok: errors.length === 0, holdings: input.codes.length, verdicts, change, sent, errors, commodities };
}

/** The address this deployment's own routes answer on without a login wall.
 *  A production deployment's unique URL sits behind Vercel's protection; its
 *  production domain does not. */
export function ownOrigin(request: Request): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_ENV === "production" && prod) return `https://${prod}`;
  return new URL(request.url).origin;
}
