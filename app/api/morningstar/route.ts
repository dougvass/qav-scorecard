import { NextResponse } from "next/server";

/**
 * MorningStar star ratings for the ASX universe, from its public screener.
 *
 * TWO THINGS WERE WRONG HERE, found 2026-11-14 — production was serving `{}`:
 *
 * 1. The route was PRERENDERED. A GET handler that reads nothing from the
 *    request is treated by Next as static, so it ran once at BUILD time and the
 *    result was frozen until the next deploy (`x-vercel-cache: PRERENDER`).
 *    "Load MS Ratings" was therefore never loading anything live. Hence
 *    `force-dynamic` below; the CDN still caches a good answer for four hours.
 *
 * 2. Any GraphQL error was fatal. MorningStar's API currently answers with the
 *    securities AND one "Internal Server Error" per security — its
 *    `equityResearchStarRating` resolver is failing, so every rating comes back
 *    null. The old code threw on `json.errors`, the loop broke on the first
 *    page, and the route returned an empty object. Errors are now tolerated
 *    whenever data came back with them, so the day the field recovers the
 *    ratings flow again without a deploy.
 *
 * Until it does there are simply no ratings to be had from this source, and the
 * response says so (`x-ms-rated: 0`) rather than looking like a success — the
 * page shows "MorningStar: no ratings" instead of "MorningStar loaded".
 */
export const dynamic = "force-dynamic";

const GRAPHQL_URL = "https://graphapi.prd.morningstar.com.au/graphql";
const PAGE_SIZE = 500;
const MAX_PAGES = 8;
const DELAY_MS = 300;

const SCREENER_QUERY = `
query Screener($page: Int!, $pageSize: Int!) {
  screener(
    page: $page
    pageSize: $pageSize
    universeIds: ["E0EXG$XASX"]
    sortOrder: "symbol asc"
  ) {
    total
    securities {
      id
      symbol
      name
      closePrice
      equityResearchStarRating
    }
  }
}
`;

interface MSSecurityRaw {
  id: string;
  symbol: string;
  name: string;
  closePrice: number | null;
  equityResearchStarRating: number | null;
}

async function fetchPage(page: number): Promise<{
  total: number;
  securities: MSSecurityRaw[];
}> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: SCREENER_QUERY,
      variables: { page, pageSize: PAGE_SIZE },
    }),
  });
  if (!res.ok) throw new Error(`MS GraphQL page ${page}: HTTP ${res.status}`);
  const json = await res.json();
  // Partial success is still success: keep whatever data came back. Only a
  // response with errors and NO screener data is a failure.
  if (!json?.data?.screener) {
    throw new Error(`MS GraphQL errors: ${JSON.stringify(json?.errors ?? "no data").slice(0, 300)}`);
  }
  return json.data.screener;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function GET() {
  try {
    const ratings: Record<
      string,
      { secId: string | null; name: string; closePrice: number | null; starRating: number | null }
    > = {};

    let total: number | null = null;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let screener: { total: number; securities: MSSecurityRaw[] };
      try {
        screener = await fetchPage(page);
      } catch (e) {
        console.warn(`MS screener page ${page} failed:`, e);
        break;
      }

      if (total === null) total = screener.total;
      const securities = screener.securities ?? [];
      if (!securities.length) break;

      for (const sec of securities) {
        if (sec.symbol) {
          ratings[sec.symbol] = {
            secId: sec.id,
            name: sec.name,
            closePrice: sec.closePrice,
            starRating: sec.equityResearchStarRating,
          };
        }
      }

      if (total !== null && Object.keys(ratings).length >= total) break;
      if (page < MAX_PAGES) await sleep(DELAY_MS);
    }

    const rated = Object.values(ratings).filter((r) => r.starRating != null).length;
    return NextResponse.json(ratings, {
      headers: {
        // A good answer is cached at the edge for 4 hours — ratings don't
        // change intraday. An answer with NO ratings is kept only 15 minutes,
        // so a broken upstream is re-checked soon without being hammered.
        // `max-age=0, must-revalidate` is the half that reaches the browser:
        // Vercel strips s-maxage, and without it the browser may keep serving
        // its own stale copy (see the note in api/cash-rate).
        "Cache-Control": rated > 0
          ? "public, max-age=0, must-revalidate, s-maxage=14400, stale-while-revalidate=3600"
          : "public, max-age=0, must-revalidate, s-maxage=900",
        "x-ms-rated": String(rated),
      },
    });
  } catch (err) {
    console.error("MorningStar API error:", err);
    return NextResponse.json(
      { error: "Failed to fetch MorningStar ratings" },
      { status: 500 }
    );
  }
}
