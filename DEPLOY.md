# Deploying QAV Scorecard to Vercel

## What's here

A complete Next.js QAV scorecard app:
- Upload a Stock Doctor CSV → instant Phase 0 scoring (15 columns)
- Click "Load MS Ratings" → adds MorningStar analyst star ratings (Phase 3)
- Ranked buy list, sortable table, expandable score breakdown per stock

## Steps to deploy (one-time, ~5 minutes)

### 1. Create a GitHub repository

Go to https://github.com/new and create a **public** or **private** repo:
- Name: `qav-scorecard` (or anything you like)
- Leave "Initialize with README" **unchecked**
- Click **Create repository**

Copy the HTTPS URL shown, e.g. `https://github.com/vassdoug/qav-scorecard.git`

### 2. Push this code to GitHub

Open Terminal and run (replacing the URL with yours):

```bash
cd "/Users/dvass/Library/Mobile Documents/com~apple~CloudDocs/QAV_Claude_project/web"

git remote add origin https://github.com/YOUR_USERNAME/qav-scorecard.git
git branch -M main
git push -u origin main
```

If prompted for credentials, use your GitHub username + a Personal Access Token
(GitHub → Settings → Developer Settings → Personal access tokens → Fine-grained token
 with "Contents: read and write" permission on the repo).

### 3. Connect Vercel to the GitHub repo

Option A — **Replace the existing v0-asx-stock-filter project**:
1. Go to https://vercel.com/vassdoug-8429s-projects/v0-asx-stock-filter/settings
2. Click **Git** in the left sidebar
3. Under "Connected Git Repository" → click **Connect Git Repository**
4. Select GitHub → choose `qav-scorecard`
5. Set **Root Directory** to `/` (or leave blank)
6. Click **Save** → Vercel will deploy automatically

Option B — **Create a brand-new project** (keeps the old v0 project intact):
1. Go to https://vercel.com/new
2. Click **Import Git Repository** → choose `qav-scorecard`
3. Deploy → you get a new `.vercel.app` URL

### 4. Done!

Every `git push origin main` will trigger an automatic redeploy.

---

## Local dev (optional)

If you install Node.js (https://nodejs.org):

```bash
cd "/Users/dvass/Library/Mobile Documents/com~apple~CloudDocs/QAV_Claude_project/web"
npm install
npm run dev
# Open http://localhost:3000
```

---

## Day-to-day: getting a CSV in

Three ways, all ending in the same place:

1. **Straight from Stock Doctor (no download).** On the scorecard, open
   *Stock Doctor bookmark* and drag **QAV ← Stock Doctor** to the bookmarks
   bar. Then, signed in to Stock Doctor, open *Tools → Stock Filter* and click
   it. It loads the saved filter `2. QAV_checklist`, fetches the export and
   hands it to the scorecard in a new tab — about three seconds. It signs
   nobody in; if the session has expired it says so. See `lib/sd-bridge.ts`.
2. **Drop the file**, as before.
3. **Do nothing.** The last CSV is remembered in the browser
   (`lib/csv-storage.ts`), so the site reopens on it; the "Loaded …" line says
   when it was loaded and turns amber once it is a day old. *New CSV* forgets it.

However it arrives, every check that has not already run **today** then starts
by itself — 3PTL, Commodities, MorningStar, Buybacks. Red flags stay on their
button (each stock is an ASX feed plus a PDF that can run to 18MB).

## Your data on every device: the passcode

Signed out, everything stays in the browser it was loaded in, exactly as
before. Signed in, the same stores are also kept on the server — the Stock
Doctor CSV, Phase 2 (scores and PE history), the 3PTL run, holdings, manual
overrides, buybacks, commodities and red flags — so the site opens the same on
any device. They sit behind one passcode because the URL is public and the CSV
is Stock Doctor subscriber data.

**Turn it on (once):**

1. Vercel → this project → **Settings → Environment Variables**.
2. Add `QAV_PASSCODE`, value = the passcode you want, environment
   **Production**. Make it long; it is the only thing protecting the data.
3. **Redeploy** (Deployments → the latest → ⋯ → Redeploy). Environment
   variables only take effect on a new deployment.
4. Open the site, click **Sign in**, enter it. That browser's data goes up.

Until step 2 is done the site has no sign-in button at all and nothing is
stored on the server. Changing `QAV_PASSCODE` later signs every device out.

Check it without signing in: `/api/auth` says whether a passcode is set,
`/api/auth?selftest=1` and `/api/store?selftest=1` exercise the session code
and the database round trip and return pass/fail only.

**On the iPhone:** open the site in Safari, sign in, then Share → **Add to
Home Screen**. It opens full-screen with its own icon, already holding your
data; any check that has not run today starts by itself. A fresh Stock Doctor
export still has to come from the desktop (the bookmark above) — the phone
then picks it up the next time it is opened.

How it decides which copy wins: each store carries the time it was last
written, and the newer one wins, per store (`lib/server-store.ts`).

## What the scoring covers

| Column | Phase | Description |
|--------|-------|-------------|
| S_sentiment_long | 0 | Long-term trend proxy (5yr + 6mth + SDMAX) |
| S_pcf | 0 | PCF ≤ 7 → 2 pts |
| S_div_yield | 0 | Dividend yield > 9.3% → 1 pt |
| S_pe_lt_dy | 0 | PE ≤ Div Yield → 1 pt |
| S_sp_lt_neps | 0 | Price < Net Equity Per Share |
| S_sp_lt_1.3neps | 0 | Price < 1.3× NEPS |
| S_geps_pe | 0 | Earnings growth / PE → 2/0/-1 pts |
| S_sp_lt_iv1 | 0 | Price < IV1 (EPS / 19.5%) |
| S_sp_lt_iv2 | 0 | Price < IV2 (FEPS / 10.1%) |
| S_sp_lt_0.5iv2 | 0 | Price < 0.5× IV2 |
| S_star | 0 | Star Stock status |
| S_sp_lt_iv4 | 0 | Price < Consensus analyst target |
| S_fh_rating | 0 | Financial Health: Strong/Satisfactory |
| S_fh_trend | 0 | FH Trend: Recovering/Steady/Deteriorating |
| S_ownership | 0 | Directors hold ≥ 10% of market cap |
| S_sp_lt_iv3 | 3 | MorningStar 4–5★ = below fair value |

Phase 1 (3PTL) and Phase 2 (historical PE/equity) are not yet on the web —
continue using the Python pipeline (`python3 qav_pipeline.py --3ptl --history --ms ...`)
for those until a Phase 4 backend is added.
