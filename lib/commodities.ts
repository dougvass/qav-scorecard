/**
 * Commodity 3PTL gate — QAV rule: a stock whose UNDERLYING commodity is in
 * Sell (Bearish) status is itself a sell / do-not-buy, regardless of its own
 * chart. Commodity sentiment comes from the same 3PTL engine as stocks
 * (/api/trendline?commodities=1) where Yahoo Finance has a live monthly feed.
 * Iron ore has no reachable feed but IS auto-classified, from a monthly series
 * embedded in the API off the Market Index workbook (refresh it when a new
 * workbook is downloaded). Coal, lithium and nickel remain MANUAL — read the
 * tradingeconomics.com chart and set their sentiment by hand in the UI.
 */

import type { TrendlineSentiment } from "./trendline-storage";

export interface CommodityDef {
  key: string;
  label: string;
  /** Yahoo symbol served by /api/trendline?commodities=1; "embedded" for a
   *  series carried inside the API; null means manual-only */
  symbol: string | null;
  /** Reference chart for the human read (Tony's 3PTL by eye) */
  teUrl: string;
}

export const COMMODITIES: CommodityDef[] = [
  { key: "GOLD",      label: "Gold",       symbol: "GC=F",    teUrl: "https://tradingeconomics.com/commodity/gold" },
  { key: "SILVER",    label: "Silver",     symbol: "SI=F",    teUrl: "https://tradingeconomics.com/commodity/silver" },
  { key: "COPPER",    label: "Copper",     symbol: "HG=F",    teUrl: "https://tradingeconomics.com/commodity/copper" },
  { key: "OIL",       label: "Oil (WTI)",  symbol: "CL=F",    teUrl: "https://tradingeconomics.com/commodity/crude-oil" },
  { key: "BRENT",     label: "Brent",      symbol: "BZ=F",    teUrl: "https://tradingeconomics.com/commodity/brent-crude-oil" },
  { key: "NATGAS",    label: "Nat Gas",    symbol: "NG=F",    teUrl: "https://tradingeconomics.com/commodity/natural-gas" },
  { key: "ALUMINIUM", label: "Aluminium",  symbol: "ALI=F",   teUrl: "https://tradingeconomics.com/commodity/aluminum" },
  { key: "PLATINUM",  label: "Platinum",   symbol: "PL=F",    teUrl: "https://tradingeconomics.com/commodity/platinum" },
  { key: "PALLADIUM", label: "Palladium",  symbol: "PA=F",    teUrl: "https://tradingeconomics.com/commodity/palladium" },
  { key: "URANIUM",   label: "Uranium",    symbol: "U-UN.TO", teUrl: "https://tradingeconomics.com/commodity/uranium" },
  // Iron ore has no reachable live feed (Yahoo's TIO=F froze in 2021,
  // marketindex.com.au 403s server-side), so the API classifies it from a
  // monthly series embedded from the Market Index workbook — auto, but lagged
  // by up to a month. The chip still accepts a manual override.
  { key: "IRONORE",   label: "Iron Ore",   symbol: "embedded", teUrl: "https://tradingeconomics.com/commodity/iron-ore" },
  // Coal and Nickel are in the World Bank Pink Sheet (see PINK_SHEET_SERIES),
  // so they are automatic now — "pink" marks a series with no Yahoo symbol.
  { key: "COAL",      label: "Coal",       symbol: "pink",    teUrl: "https://tradingeconomics.com/commodity/coal" },
  { key: "NICKEL",    label: "Nickel",     symbol: "pink",    teUrl: "https://tradingeconomics.com/commodity/nickel" },
  // Manual-only. Lithium has NO free monthly price series: FRED carries only a
  // miners equity index, the Pink Sheet has neither lithium nor cobalt, stooq
  // and Yahoo futures have nothing usable, and SMM, Fastmarkets, Benchmark and
  // the LME are paywalled. Set it from the TE chart.
  { key: "LITHIUM",   label: "Lithium",    symbol: null,      teUrl: "https://tradingeconomics.com/commodity/lithium" },
];

/**
 * ASX resource stocks → underlying commodity. A starting map of the common
 * QAV-universe names — edit freely. Diversified miners are mapped to their
 * dominant earnings driver (BHP/RIO → iron ore); adjust to taste (e.g. MIN
 * sits across lithium, iron ore and mining services).
 */
export const STOCK_COMMODITY: Record<string, string> = {
  // Gold
  NST: "GOLD", EVN: "GOLD", GOR: "GOLD", RRL: "GOLD", PRU: "GOLD",
  WGX: "GOLD", RMS: "GOLD", CMM: "GOLD", RSG: "GOLD", WAF: "GOLD",
  GMD: "GOLD", BGL: "GOLD", VAU: "GOLD", OBM: "GOLD", AMI: "GOLD",
  PNR: "GOLD", KCN: "GOLD", EMR: "GOLD", CYL: "GOLD", AUC: "GOLD",
  ALK: "GOLD", TTM: "GOLD",
  // Silver
  SVL: "SILVER", ADT: "SILVER",
  // Copper
  SFR: "COPPER", AIS: "COPPER", "29M": "COPPER",
  // Oil & gas
  WDS: "OIL", STO: "OIL", BPT: "OIL", KAR: "OIL", CVN: "OIL",
  // Iron ore
  BHP: "IRONORE", RIO: "IRONORE", FMG: "IRONORE", CIA: "IRONORE",
  MGX: "IRONORE", GRR: "IRONORE", FEX: "IRONORE",
  // Coal
  WHC: "COAL", YAL: "COAL", SMR: "COAL", CRN: "COAL", NHC: "COAL", TER: "COAL",
  // Uranium
  PDN: "URANIUM", BOE: "URANIUM", DYL: "URANIUM", LOT: "URANIUM",
  BMN: "URANIUM", AGE: "URANIUM",
  // Lithium
  PLS: "LITHIUM", LTR: "LITHIUM", IGO: "LITHIUM", MIN: "LITHIUM",
  // Nickel
  NIC: "NICKEL",
  // Aluminium / alumina
  AWC: "ALUMINIUM", S32: "ALUMINIUM",
};

// ── Storage ────────────────────────────────────────────────────────────────

export const COMMODITY_STORAGE_KEY = "qav_commodity_v1";

export interface CommodityAutoEntry {
  sentiment: TrendlineSentiment;
  note?: string;
}

export interface StoredCommodities {
  /** ISO date of the last auto-calculation run */
  timestamp: string | null;
  /** auto 3PTL results keyed by commodity key (only feed-backed commodities) */
  auto: Record<string, CommodityAutoEntry>;
  /** manual sentiment settings keyed by commodity key — win over auto */
  manual: Record<string, TrendlineSentiment>;
}

/** Manual setting wins over the auto calculation; null = unknown/unset. */
export function effectiveCommoditySentiment(
  stored: StoredCommodities | null,
  key: string,
): TrendlineSentiment | null {
  if (!stored) return null;
  return stored.manual[key] ?? stored.auto[key]?.sentiment ?? null;
}

/**
 * Yahoo symbols for the commodities that have a reachable live feed.
 *
 * Lives here, not in a route, because both /api/trendline (v1) and
 * /api/trendline-v3 classify the same complex and a second copy of this plus
 * the embedded series below is exactly the kind of duplication that let the
 * two sentiment filters drift apart.
 *
 * Uranium uses the Sprott Physical Uranium Trust (U-UN.TO, holds physical
 * U3O8) as its price proxy — actively traded, history through today. It is
 * quoted in CAD, which does not matter because only the trend is read.
 */
export const COMMODITY_SYMBOLS: Record<string, string> = {
  GOLD:      "GC=F",
  SILVER:    "SI=F",
  COPPER:    "HG=F",
  OIL:       "CL=F",     // WTI crude
  BRENT:     "BZ=F",
  NATGAS:    "NG=F",     // Henry Hub
  ALUMINIUM: "ALI=F",
  PLATINUM:  "PL=F",
  PALLADIUM: "PA=F",
  URANIUM:   "U-UN.TO",  // Sprott physical trust proxy
};

/**
 * Commodities with no live feed we can reach, carried as an embedded monthly
 * series. Yahoo's TIO=F froze in 2021 and marketindex.com.au 403s server-side,
 * so iron ore is classified from the Market Index workbook's Commodities tab —
 * automatic, but lagged by up to two months, which `asOf` makes visible rather
 * than silent. The chip still accepts a manual override.
 *
 * REFRESH: re-extract when a new workbook is downloaded. Source column is
 * "Iron Ore (USD/t)"; the header sits on row 3 and data starts on row 4.
 * Last refreshed from asx-workbook-20261002.xlsx (72 months, 2020-09..2026-08).
 * Coal, lithium and nickel are NOT in that tab and stay manual-only.
 */
export const EMBEDDED_MONTHLY: Record<string, { asOf: string; bars: [string, number][] }> = {
  IRONORE: {
    asOf: "2026-08",
    bars: [
      ["2020-09",123.98], ["2020-10",120.19], ["2020-11",129.31], ["2020-12",158.15], ["2021-01",168.13], ["2021-02",165.61],
      ["2021-03",166.9], ["2021-04",179.63], ["2021-05",205.73], ["2021-06",214.55], ["2021-07",211.99], ["2021-08",159.25],
      ["2021-09",119.65], ["2021-10",121.23], ["2021-11",94.97], ["2021-12",112.5], ["2022-01",131.15], ["2022-02",141.99],
      ["2022-03",150.84], ["2022-04",150.77], ["2022-05",133.51], ["2022-06",130], ["2022-07",107.22], ["2022-08",104.76],
      ["2022-09",98.31], ["2022-10",92.43], ["2022-11",93.25], ["2022-12",111.28], ["2023-01",123.37], ["2023-02",125.75],
      ["2023-03",127.06], ["2023-04",116.14], ["2023-05",105.07], ["2023-06",112.57], ["2023-07",112.46], ["2023-08",109.4],
      ["2023-09",120.79], ["2023-10",118.91], ["2023-11",130.46], ["2023-12",139.92], ["2024-01",135.13], ["2024-02",114.57],
      ["2024-03",109.53], ["2024-04",110.91], ["2024-05",117.52], ["2024-06",106.31], ["2024-07",105.94], ["2024-08",98.7],
      ["2024-09",93.83], ["2024-10",103.78], ["2024-11",102.44], ["2024-12",103.61], ["2025-01",101.59], ["2025-02",106.9],
      ["2025-03",102.51], ["2025-04",99.76], ["2025-05",99.12], ["2025-06",94.17], ["2025-07",99.12], ["2025-08",101.81],
      ["2025-09",105.29], ["2025-10",105.83], ["2025-11",104.84], ["2025-12",107.13], ["2026-01",105.62], ["2026-02",99.06],
      ["2026-03",106.38], ["2026-04",107.18], ["2026-05",104.52], ["2026-06",100.2], ["2026-07",98], ["2026-08",96.05]
    ],
  },
};

/**
 * Our commodity key → its series name in the World Bank Pink Sheet
 * ("Monthly Prices" sheet, names on row 5).
 *
 * This is the preferred source for everything listed here: gapless monthly
 * closes since 1960, updated monthly, and a month fresher than the Market
 * Index workbook. Yahoo's monthly FUTURES series have calendar gaps — gold was
 * missing 8 of 61 months — and the engine indexes time by array position, so a
 * gap silently compresses it. Feeding gapless closes moved Aluminium and
 * Platinum from wrong to right against HQ's own run with no engine change.
 *
 * Units differ from other sources (iron ore in $/dmtu rather than $/t), which
 * does not matter: 3PTL reads a trend, so it is scale-invariant.
 *
 * Palladium and Uranium are NOT in the Pink Sheet and keep their Yahoo
 * futures, calendar-normalised at fetch time. Lithium has no series at all.
 */
export const PINK_SHEET_SERIES: Record<string, string> = {
  GOLD:      "Gold",
  SILVER:    "Silver",
  COPPER:    "Copper",
  OIL:       "Crude oil, WTI",
  BRENT:     "Crude oil, Brent",
  NATGAS:    "Natural gas, US",
  ALUMINIUM: "Aluminum",
  PLATINUM:  "Platinum",
  IRONORE:   "Iron ore, cfr spot",
  NICKEL:    "Nickel",
  COAL:      "Coal, Australian",
};
