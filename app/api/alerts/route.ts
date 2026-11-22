/**
 * Holding alerts, from the browser.
 *
 *   GET  /api/alerts                    -> what is switched on, and the last run
 *   POST /api/alerts { action: "check" } -> who is a sell right now (sends nothing,
 *                                          remembers nothing)
 *   POST /api/alerts { action: "run" }   -> the same pass the daily job makes
 *   POST /api/alerts { action: "test" }  -> a test email
 *
 * All of it needs the passcode: the answers name his holdings. The daily job
 * itself is /api/alerts/cron. The rule is lib/alerts.ts; where the data comes
 * from and where messages go is lib/alerts-server.ts.
 */
import { requireSession } from "@/lib/server-auth";
import { channels, deliver, hasDatabase, loadState, ownOrigin, runAlerts, storedInput, RunInput } from "@/lib/alerts-server";
import { toReading, Reading } from "@/lib/alerts";
import { StoredExposure, normaliseExposure } from "@/lib/revenue-exposure";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const refused = requireSession(request);
  if (refused) return refused;
  return Response.json({
    configured: true, signedIn: true,
    channels: channels(),
    database: hasDatabase(),
    cronProtected: !!process.env.CRON_SECRET,
    state: await loadState(),
  }, { headers: NO_STORE });
}

/** A preview has no database, so a check there is given its inputs. On
 *  production the store is the source and anything sent is ignored. */
function bodyInput(b: Record<string, unknown>): RunInput | null {
  if (hasDatabase() || !Array.isArray(b.codes)) return null;
  const manual: Record<string, Reading | undefined> = {};
  const m = (b.manual ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(m)) { const r = toReading(m[k]); if (r) manual[k] = r; }
  return {
    codes: (b.codes as unknown[]).filter((c): c is string => typeof c === "string").slice(0, 60),
    exposure: b.exposure && typeof (b.exposure as StoredExposure).reviews === "object" ? normaliseExposure(b.exposure as StoredExposure) : null,
    manual,
  };
}

export async function POST(request: Request) {
  const refused = requireSession(request);
  if (refused) return refused;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* no body */ }
  const action = String(body.action ?? "check");

  if (action === "test") {
    const on = channels();
    if (!on.email) {
      return Response.json({ ok: false, sent: [], errors: ["Email is not switched on yet."] }, { headers: NO_STORE });
    }
    const when = new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
    const r = await deliver({
      subject: "QAV alerts: test message",
      text: `This is a test from the QAV scorecard, sent ${when} Sydney time. If you can read it, sell alerts will reach you here.`,
      html: `<p style="font:15px/1.5 -apple-system,Segoe UI,sans-serif">This is a test from the QAV scorecard, sent ${when} Sydney time. If you can read it, sell alerts will reach you here.</p>`,
    });
    return Response.json({ ok: r.errors.length === 0, ...r }, { headers: NO_STORE });
  }

  const real = action === "run";
  const result = await runAlerts({
    origin: ownOrigin(request),
    cookie: request.headers.get("cookie"),
    input: bodyInput(body) ?? await storedInput(),
    send: real,
    remember: real,
  });
  return Response.json({ ...result, channels: channels() }, { headers: NO_STORE });
}
