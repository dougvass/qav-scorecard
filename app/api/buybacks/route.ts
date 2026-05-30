/**
 * GET /api/buybacks?code=BHP
 *
 * Debug endpoint — shows what the Vercel edge sees when calling the ASX
 * announcements API. Useful for checking if ASX changes their endpoint.
 *
 * Note: Buyback entry is now manual (via the Buybacks panel in the UI)
 * because the ASX /asx/1/company/{code}/announcements endpoint returned 404.
 */

export const runtime = "edge";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = (searchParams.get("code") ?? "BHP").toUpperCase();
  const url = `https://www.asx.com.au/asx/1/company/${code}/announcements?count=20&market_sensitive=false`;

  const result: Record<string, unknown> = { code, url, runtime: "edge" };

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "application/json",
        Referer: "https://www.asx.com.au/",
      },
      signal: AbortSignal.timeout(9_000),
    });
    result.status = res.status;
    result.ok = res.ok;
    if (res.ok) {
      const json = (await res.json()) as { data?: unknown[] };
      result.announcement_count = (json?.data ?? []).length;
      result.sample = (json?.data ?? []).slice(0, 3);
    } else {
      result.body = (await res.text()).slice(0, 500);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return Response.json(result);
}
