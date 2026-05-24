import { NextResponse } from "next/server";

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
  if (json.errors) throw new Error(`MS GraphQL errors: ${JSON.stringify(json.errors)}`);
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

    return NextResponse.json(ratings, {
      headers: {
        // Cache for 4 hours — MS ratings don't change intraday
        "Cache-Control": "public, max-age=14400, stale-while-revalidate=3600",
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
