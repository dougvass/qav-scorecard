/**
 * Keeping this browser's stores and the server's copy in step.
 * CLIENT-ONLY — it reads and writes localStorage.
 *
 * Doug, 2026-11-14: "I definitely want storage so I can access from anywhere."
 *
 * The app has always kept its working state in localStorage: the CSV, Phase 2,
 * the 3PTL run, holdings, overrides, buybacks, commodities, red flags. That is
 * why a phone had nothing to show — none of it existed there. This module
 * mirrors those same stores to /api/store (see that route for the server half
 * and lib/server-auth.ts for the passcode).
 *
 * THE SHAPE OF IT
 *   - localStorage stays the working copy. Every screen still reads it, so the
 *     app is exactly as fast as before, and still works signed out or offline.
 *   - `setSynced()` replaces `localStorage.setItem()` for the synced stores:
 *     it writes locally, stamps the time, and pushes to the server shortly
 *     after (debounced — a run writes several stores in quick succession).
 *   - `syncNow()` compares timestamps store by store: a newer server copy is
 *     pulled into localStorage, a newer local copy is pushed. It returns the
 *     keys it pulled so the page can reload exactly those into React state.
 *
 * WHICH COPY WINS. The newer one, per store. A local copy written before this
 * feature existed has no stamp, so its age is read from the timestamp the
 * store already carried inside it (`timestamp`, or `loadedAt` for the CSV).
 * That is what makes the first sign-in do the right thing on each device with
 * no special case: the desktop's stores are newer than an empty server and go
 * up; the phone has nothing and everything comes down.
 *
 * Nothing here throws. A failed request leaves the local copy untouched and
 * is retried by the next sync — losing the network must never lose a run.
 */

/** The stores that are mirrored. Literal strings, not imports: the storage
 *  modules import THIS file, and importing them back would be a cycle. They
 *  must match the keys allowed in app/api/store/route.ts. */
export const SYNCED_KEYS = [
  "qav_csv_v1",
  "qav_phase2_v1",
  "qav_trendline_v1",
  "qav_holdings_v1",
  "qav_sentiment_v1",
  "qav_buybacks_v1",
  "qav_commodity_v1",
  "qav_redflags_v1",
  "qav_asx_financials_v1",
  "qav_exposure_v1",
] as const;

const SYNCED = new Set<string>(SYNCED_KEYS);

/** key -> ISO time this browser's copy was last written. */
const META_KEY = "qav_sync_meta_v1";

/** The oldest a stamp can be: "exists, but of unknown age" — loses to any
 *  server copy, wins over an absent one. */
const UNKNOWN_AGE = "1970-01-01T00:00:01.000Z";

export interface AccountStatus {
  /** A passcode is set on the server, so there is somewhere to sign in to. */
  configured: boolean;
  signedIn: boolean;
}

export interface SyncStatus {
  /** Signed in and mirroring. */
  enabled: boolean;
  busy: boolean;
  /** ISO time of the last sync that completed. */
  lastSyncAt: string | null;
  error: string | null;
}

let status: SyncStatus = { enabled: false, busy: false, lastSyncAt: null, error: null };
const listeners = new Set<(s: SyncStatus) => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export function getSyncStatus(): SyncStatus {
  return status;
}

/** Subscribe to status changes; returns the unsubscribe. */
export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Local stamps ─────────────────────────────────────────────────────────────

function readMeta(): Record<string, string> {
  try {
    const raw = localStorage.getItem(META_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch { return {}; }
}

function writeMeta(meta: Record<string, string>) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* stamps are best-effort */ }
}

function normalise(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** The age of a copy that has no stamp, from the timestamp inside it. */
function inferStamp(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { timestamp?: unknown; loadedAt?: unknown } | null;
    return normalise(parsed?.timestamp) ?? normalise(parsed?.loadedAt) ?? UNKNOWN_AGE;
  } catch { return UNKNOWN_AGE; }
}

function localStamp(key: string, meta: Record<string, string>): string | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* unreadable = absent */ }
  if (!raw) return null;
  return normalise(meta[key]) ?? inferStamp(raw);
}

// ── Writing ──────────────────────────────────────────────────────────────────

const pushTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function schedulePush(key: string) {
  if (!status.enabled) return;
  if (pushTimers[key]) clearTimeout(pushTimers[key]);
  pushTimers[key] = setTimeout(() => {
    delete pushTimers[key];
    void pushKey(key);
  }, 1200);
}

/**
 * Write a store. Use this instead of `localStorage.setItem` for every key in
 * SYNCED_KEYS. Returns false only if the browser itself refused the write
 * (quota), in which case nothing is pushed either.
 */
export function setSynced(key: string, json: string): boolean {
  try {
    localStorage.setItem(key, json);
  } catch {
    return false;
  }
  if (SYNCED.has(key)) {
    const meta = readMeta();
    // Always later than the copy this write replaces, even if that copy was
    // stamped by a device whose clock runs ahead of this one. Without this, an
    // edit made just after pulling such a copy carries an EARLIER time, the
    // server refuses it as stale, and the next sync pulls the old copy back
    // over the edit. Found in testing with a server copy stamped a minute
    // ahead: the override set here was refused. An edit made after seeing a
    // copy is newer than that copy by definition, whatever the clocks say.
    const previous = Date.parse(meta[key] ?? "");
    const now = Date.now();
    meta[key] = new Date(isNaN(previous) ? now : Math.max(now, previous + 1)).toISOString();
    writeMeta(meta);
    schedulePush(key);
  }
  return true;
}

/** Remove a store here AND on the server — otherwise the next sync would see
 *  "absent locally, present on the server" and bring it straight back. */
export function removeSynced(key: string): void {
  try { localStorage.removeItem(key); } catch { /* nothing to remove */ }
  if (!SYNCED.has(key)) return;
  const meta = readMeta();
  delete meta[key];
  writeMeta(meta);
  if (pushTimers[key]) { clearTimeout(pushTimers[key]); delete pushTimers[key]; }
  if (status.enabled) {
    fetch(`/api/store?key=${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
  }
}

/** Push one store now. Resolves true if the server holds this copy (or a
 *  newer one) afterwards. */
export async function pushKey(key: string): Promise<boolean> {
  if (!status.enabled || !SYNCED.has(key)) return false;
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* unreadable = absent */ }
  if (!raw) return false;
  const meta = readMeta();
  const updatedAt = normalise(meta[key]) ?? inferStamp(raw);
  try {
    const res = await fetch("/api/store", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: raw, updatedAt }),
    });
    if (res.status === 401) { setStatus({ enabled: false, error: "Signed out — sign in again to sync." }); return false; }
    if (!res.ok) { setStatus({ error: `Could not save to the server (${res.status}).` }); return false; }
    const json = await res.json() as { configured?: boolean };
    if (json.configured === false) { setStatus({ enabled: false }); return false; }
    // Record the stamp that was actually sent, so an unstamped legacy copy is
    // not "newer than the server" again on the next comparison.
    if (!meta[key]) { const m = readMeta(); m[key] = updatedAt; writeMeta(m); }
    setStatus({ error: null, lastSyncAt: new Date().toISOString() });
    return true;
  } catch {
    setStatus({ error: "Offline — changes are kept on this device and will sync later." });
    return false;
  }
}

// ── Account ──────────────────────────────────────────────────────────────────

/** Never throws: an unreachable server reads as "nothing to sign in to". */
export async function authStatus(): Promise<AccountStatus> {
  try {
    const res = await fetch("/api/auth", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json() as Partial<AccountStatus>;
    const st = { configured: !!j.configured, signedIn: !!j.signedIn };
    setStatus({ enabled: st.configured && st.signedIn });
    return st;
  } catch {
    setStatus({ enabled: false });
    return { configured: false, signedIn: false };
  }
}

/** Resolves null on success, otherwise the message to show. */
export async function signIn(passcode: string): Promise<string | null> {
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    const j = await res.json().catch(() => ({})) as { signedIn?: boolean; error?: string };
    if (res.ok && j.signedIn) { setStatus({ enabled: true, error: null }); return null; }
    return j.error ?? "Could not sign in.";
  } catch {
    return "Could not reach the server.";
  }
}

export async function signOut(): Promise<void> {
  try { await fetch("/api/auth", { method: "DELETE" }); } catch { /* the cookie expires on its own */ }
  setStatus({ enabled: false, lastSyncAt: null, error: null });
}

// ── Sync ─────────────────────────────────────────────────────────────────────

let inFlight: Promise<{ ok: boolean; pulled: string[]; pushed: string[] }> | null = null;

/**
 * Bring this browser and the server into step. Safe to call often: a call made
 * while one is running joins it.
 *
 * `pulled` lists the keys whose localStorage copy was replaced — the caller
 * must reload those into its own state, because writing localStorage from the
 * same tab raises no `storage` event.
 */
export function syncNow(): Promise<{ ok: boolean; pulled: string[]; pushed: string[] }> {
  if (inFlight) return inFlight;
  inFlight = doSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function doSync(): Promise<{ ok: boolean; pulled: string[]; pushed: string[] }> {
  const nothing = { ok: false, pulled: [] as string[], pushed: [] as string[] };
  if (!status.enabled) return nothing;
  setStatus({ busy: true });
  try {
    const res = await fetch("/api/store?meta=1", { cache: "no-store" });
    if (res.status === 401) { setStatus({ enabled: false, busy: false, error: "Signed out — sign in again to sync." }); return nothing; }
    if (!res.ok) throw new Error(`server ${res.status}`);
    const head = await res.json() as { configured?: boolean; meta?: Record<string, string> };
    if (head.configured === false) { setStatus({ enabled: false, busy: false }); return nothing; }
    const server = head.meta ?? {};

    const meta = readMeta();
    const pull: string[] = [];
    const push: string[] = [];
    for (const key of SYNCED_KEYS) {
      const mine = localStamp(key, meta);
      const theirs = normalise(server[key]);
      if (theirs && (!mine || theirs > mine)) pull.push(key);
      else if (mine && (!theirs || mine > theirs)) push.push(key);
    }

    const pulled: string[] = [];
    if (pull.length) {
      const got = await fetch(`/api/store?keys=${pull.join(",")}`, { cache: "no-store" });
      if (!got.ok) throw new Error(`server ${got.status}`);
      const body = await got.json() as { items?: Record<string, { value: string; updatedAt: string }> };
      const fresh = readMeta();
      for (const key of pull) {
        const item = body.items?.[key];
        if (!item) continue;
        try {
          localStorage.setItem(key, item.value);
          fresh[key] = normalise(item.updatedAt) ?? new Date().toISOString();
          pulled.push(key);
        } catch { /* quota: keep what is here and leave the server copy alone */ }
      }
      writeMeta(fresh);
    }

    // One at a time. Eight small requests at most, and it keeps the order of
    // writes on the server the order they were made here.
    const pushed: string[] = [];
    for (const key of push) {
      if (await pushKey(key)) pushed.push(key);
    }

    setStatus({ busy: false, error: null, lastSyncAt: new Date().toISOString() });
    return { ok: true, pulled, pushed };
  } catch {
    setStatus({ busy: false, error: "Could not reach the server — working from this device's copy." });
    return nothing;
  }
}
