/**
 * Commodity 3PTL gate — QAV rule: a stock whose UNDERLYING commodity is in
 * Sell (Bearish) status is itself a sell / do-not-buy, regardless of its own
 * chart. Commodity sentiment comes from the same 3PTL engine as stocks
 * (/api/trendline?commodities=1) where Yahoo Finance has a live monthly feed;
 * commodities with no reliable feed (probed 2026-07-09: iron ore, coal,
 * lithium, nickel) are MANUAL — read the tradingeconomics.com chart and set
 * their sentiment by hand in the UI.
 */

import type { TrendlineSentiment } from "./trendline-storage";

export interface CommodityDef {
  key: string;
  label: string;
  /** Yahoo symbol served by /api/trendline?commodities=1 — null means manual-only */
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
  // Manual-only: no live Yahoo series — set sentiment from the TE chart
  { key: "IRONORE",   label: "Iron Ore",   symbol: null,      teUrl: "https://tradingeconomics.com/commodity/iron-ore" },
  { key: "COAL",      label: "Coal",       symbol: null,      teUrl: "https://tradingeconomics.com/commodity/coal" },
  { key: "LITHIUM",   label: "Lithium",    symbol: null,      teUrl: "https://tradingeconomics.com/commodity/lithium" },
  { key: "NICKEL",    label: "Nickel",     symbol: null,      teUrl: "https://tradingeconomics.com/commodity/nickel" },
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
