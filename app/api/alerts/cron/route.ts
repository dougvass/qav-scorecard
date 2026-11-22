/**
 * The daily look at the holdings. Vercel calls this on the schedule in
 * vercel.json; see lib/alerts-server.ts for what a run does.
 *
 * WHO MAY CALL IT. With CRON_SECRET set in Vercel, only a request carrying it
 * — which is what Vercel's scheduler sends. Without it the route still works,
 * and is safe to leave open because of what it cannot be made to do: it
 * returns nothing but "ok", it runs at most once in twenty minutes however
 * often it is asked, and it writes only to the address already configured, and
 * only when the picture has changed.
 */
import { hasDatabase, loadState, ownOrigin, runAlerts, storedInput } from "@/lib/alerts-server";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MIN_GAP_MS = 20 * 60_000;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false }, { status: 401 });
  }
  if (!hasDatabase()) return Response.json({ ok: false });
  const state = await loadState();
  if (state.lastRun && Date.now() - Date.parse(state.lastRun) < MIN_GAP_MS) return Response.json({ ok: true });
  const r = await runAlerts({
    origin: ownOrigin(request), cookie: null, input: await storedInput(), send: true, remember: true,
  });
  return Response.json({ ok: r.ok });
}
