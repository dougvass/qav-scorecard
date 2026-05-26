// Raw row from Stock Doctor CSV export
export interface StockRow {
  Code: string;
  Name: string;
  "Industry Group": string;
  "Last Period Analysed": string;
  "Trading Status": string;
  "Avg Trade 3M ($000)": number | null;
  "SDMAX Status": string;
  "Price Chg 5yr (%)": number | null;
  "Price Chg 6mth (%)": number | null;
  "CF: Net Operating ($)": number | null;
  "NPAT Bef Abnormals ($)": number | null;
  "Shares Outstanding (M)": number | null;
  "Share Price ($)": number | null;
  "Price to CashFlow": number | null;
  "Market Cap ($M)": number | null;
  "Div Yield (%)": number | null;
  PE: number | null;
  "Equity ($)": number | null;
  "EPS Bef Abnormals (c)": number | null;
  "EPS (¢) Fcst yr1": number | null;
  "Rev Gth 1yr (%)": number | null;
  "Rev Gth 2yr (% pa)": number | null;
  "Financial Health Rating": string;
  "Financial Health Trend": string;
  "EPS After Abnormals (c)": number | null;
  "Interest Coverage": number | null;
  "Net Debt to Equity": number | null;
  "Prof Pretax Gth 1yr (%)": number | null;
  "Prof Pretax Gth 2yr (% pa)": number | null;
  "Star Stock Status": string;
  "Consensus Tgt ($)": number | null;
  "CEO/MD + Chairman Holdings ($)": number | null;
  "All Directors' Holdings ($)": number | null;
  "ROIC (%)": number | null;
  [key: string]: string | number | null;
}

// All Phase 0 score columns
export interface ScoreColumns {
  S_sentiment_long: number | null;   // AJ
  S_pcf: number | null;              // AL
  S_div_yield: number | null;        // AM
  S_pe_lt_dy: number | null;         // AN
  S_sp_lt_neps: number | null;       // AS
  "S_sp_lt_1.3neps": number | null;  // AT
  S_geps_pe: number | null;          // AU
  S_sp_lt_iv1: number | null;        // AX
  S_sp_lt_iv2: number | null;        // AY
  "S_sp_lt_0.5iv2": number | null;   // AZ
  S_star: number | null;             // BA
  S_sp_lt_iv4: number | null;        // BE
  S_fh_rating: number | null;        // BF
  S_fh_trend: number | null;         // BG
  S_ownership: number | null;        // BH
  // Phase extras (blank on Phase 0 only runs)
  S_sentiment_short: number | null;  // AK — 3PTL
  S_pe_hi_lo: number | null;         // AQ — history
  S_equity_inc: number | null;       // AR — history
  S_sp_lt_iv3: number | null;        // BD — MorningStar
}

// Derived metrics
export interface DerivedMetrics {
  IV1: number | null;
  IV2: number | null;
  PCF: number | null;
  Count: number;
  TotalScore: number;
  Quality: number | null;
  QAV: number | null;
}

// Full scored stock
export type ScoredStock = StockRow & ScoreColumns & DerivedMetrics;

// MorningStar rating entry
export interface MSRating {
  secId: string | null;
  name: string;
  closePrice: number | null;
  starRating: number | null;
}

export type MSRatings = Record<string, MSRating>;

// Score column metadata for display
export interface ScoreColMeta {
  key: keyof ScoreColumns;
  label: string;
  description: string;
  phase: 0 | 1 | 2 | 3;
}

export const SCORE_COL_META: ScoreColMeta[] = [
  { key: "S_sentiment_long",  label: "Sentiment",   description: "Long-term price trend proxy (5yr + 6mth + SDMAX)", phase: 0 },
  { key: "S_sentiment_short", label: "3PTL",         description: "Short-term 3 Point Trendline (Phase 1)", phase: 1 },
  { key: "S_pcf",             label: "PCF",          description: "Price/CashFlow ≤ 7 → 2pts", phase: 0 },
  { key: "S_div_yield",       label: "Div Yield",    description: "Dividend yield > 9.3% → 1pt", phase: 0 },
  { key: "S_pe_lt_dy",        label: "PE<DY",        description: "PE ≤ Div Yield → 1pt", phase: 0 },
  { key: "S_pe_hi_lo",        label: "PE Hi/Lo",     description: "Current trailing PE ≤ midpoint of 3-yr range → 1pt (Yahoo Finance)", phase: 2 },
  { key: "S_equity_inc",      label: "Equity Inc",   description: "Stockholders' equity increasing YoY × 3 consecutive years → 1pt (Yahoo Finance)", phase: 2 },
  { key: "S_sp_lt_neps",      label: "SP<NEPS",      description: "Share price below net equity per share", phase: 0 },
  { key: "S_sp_lt_1.3neps",   label: "SP<1.3NEPS",   description: "Share price below 1.3× NEPS", phase: 0 },
  { key: "S_geps_pe",         label: "GEPS/PE",      description: "Earnings growth vs PE → 2/-1/0", phase: 0 },
  { key: "S_sp_lt_iv1",       label: "SP<IV1",       description: "Price below Intrinsic Value 1 (EPS/RRR)", phase: 0 },
  { key: "S_sp_lt_iv2",       label: "SP<IV2",       description: "Price below Intrinsic Value 2 (FEPS/hurdle)", phase: 0 },
  { key: "S_sp_lt_0.5iv2",    label: "SP<½IV2",      description: "Price below 50% of IV2 (deep value)", phase: 0 },
  { key: "S_sp_lt_iv3",       label: "MS Stars",     description: "MorningStar 4–5★ = below fair value (Phase 3)", phase: 3 },
  { key: "S_sp_lt_iv4",       label: "SP<Target",    description: "Price below consensus analyst target", phase: 0 },
  { key: "S_star",            label: "Star Stock",   description: "Stock Doctor Star status (Star Growth = 1)", phase: 0 },
  { key: "S_fh_rating",       label: "FH Rating",    description: "Financial Health: Strong/Satisfactory → 1", phase: 0 },
  { key: "S_fh_trend",        label: "FH Trend",     description: "Recovering=2, Steady=1, Deteriorating=-1", phase: 0 },
  { key: "S_ownership",       label: "Ownership",    description: "Directors own ≥10% of market cap → 2pts", phase: 0 },
];
