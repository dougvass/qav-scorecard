/**
 * The passcode gate in front of everything this site stores on the server.
 * SERVER-ONLY — imports node:crypto; never import it from a component.
 *
 * Doug, 2026-11-14: "I definitely want storage so I can access from anywhere
 * so passcode is fine."
 *
 * Until now nothing personal lived on the server, so the site needed no login.
 * Storing the Stock Doctor CSV, the Phase 2 history, his holdings and his
 * overrides there changes that: the URL is public, and the CSV is Stock
 * Doctor's subscriber data.
 *
 * HOW IT WORKS
 *   - The passcode is the `QAV_PASSCODE` environment variable, set by Doug in
 *     Vercel. Nobody else chooses or sees it, and it is never written to the
 *     database or to the repository.
 *   - With no `QAV_PASSCODE` set, server storage is simply OFF: the store
 *     routes answer `configured: false` and the app runs exactly as it did,
 *     on this browser's own storage. So deploying this changes nothing until
 *     he sets it.
 *   - Signing in exchanges the passcode for a cookie holding
 *     `<expiry>.<HMAC-SHA256(expiry)>`, keyed BY the passcode. That needs no
 *     session table — and it means changing the passcode signs every device
 *     out at once, which is the behaviour you want from "change the passcode".
 *   - The cookie is HttpOnly (page scripts cannot read it), Secure, and
 *     SameSite=Lax — Lax rather than Strict so that arriving from the Stock
 *     Doctor bookmarklet's window.open() still counts as signed in.
 *   - It lasts 180 days, so a phone stays signed in.
 *
 * WHAT IT IS NOT. It is one shared passcode for a one-person tool, not user
 * accounts. A wrong guess costs a fixed delay and repeated ones are refused
 * for a minute, which is friction rather than a guarantee: the passcode should
 * be long enough not to be guessable.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "qav_session";
const SESSION_DAYS = 180;
const TOKEN_LABEL = "qav-session-v1";

function passcode(): string | null {
  const p = process.env.QAV_PASSCODE?.trim();
  return p ? p : null;
}

/**
 * A PREVIEW deployment with no passcode and no database is an open sandbox:
 * treated as signed in, on a throwaway in-memory store (see api/store).
 *
 * This is what lets the whole sign-in-and-sync path be exercised before it
 * reaches production without anyone typing a credential into a test site.
 * Previews already sit behind Vercel's own deployment protection, and one
 * with no database connection has no real data to protect. All three
 * conditions are required: give a preview a database or a passcode and it is
 * gated exactly like production. It can never be true in production.
 */
export function previewSandbox(): boolean {
  return process.env.VERCEL_ENV === "preview"
    && passcode() === null
    && !(process.env.POSTGRES_URL || process.env.DATABASE_URL);
}

/** False until Doug sets QAV_PASSCODE — and until then server storage is off. */
export function authConfigured(): boolean {
  return passcode() !== null || previewSandbox();
}

function mac(expiry: number, key: string): string {
  return createHmac("sha256", key).update(`${TOKEN_LABEL}.${expiry}`).digest("hex");
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Compared as SHA-256 digests so the comparison is constant-time and the
 *  two sides are always the same length whatever was typed. */
export function passcodeMatches(given: unknown): boolean {
  const key = passcode();
  if (!key || typeof given !== "string" || given.length === 0 || given.length > 256) return false;
  const a = createHash("sha256").update(given.trim()).digest();
  const b = createHash("sha256").update(key).digest();
  return sameBytes(a, b);
}

function issueWith(key: string, lifetimeSeconds = SESSION_DAYS * 86_400): string {
  const expiry = Math.floor(Date.now() / 1000) + lifetimeSeconds;
  return `${expiry}.${mac(expiry, key)}`;
}

export function issueToken(): string {
  const key = passcode();
  if (!key) throw new Error("QAV_PASSCODE is not set");
  return issueWith(key);
}

export function tokenValid(token: string | null | undefined): boolean {
  return validWith(token, passcode());
}

function validWith(token: string | null | undefined, key: string | null): boolean {
  if (!key || !token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiry = Number(token.slice(0, dot));
  const given = token.slice(dot + 1);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  return sameBytes(Buffer.from(given, "hex"), Buffer.from(mac(expiry, key), "hex"));
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** True when the request carries a valid, unexpired session cookie. */
export function signedIn(request: Request): boolean {
  return previewSandbox() || tokenValid(cookieValue(request, SESSION_COOKIE));
}

/**
 * Prove the session machinery works in THIS runtime, without a passcode.
 *
 * Runs the same issue / verify / cookie code the real sign-in uses, keyed by a
 * random value made up for the occasion and thrown away — so it says nothing
 * about the real passcode and returns only pass/fail. It exists because the
 * one step that cannot be tested by anyone but Doug is typing his passcode;
 * everything around that step can be.
 */
export function authSelfTest(): { ok: boolean; steps: Record<string, boolean> } {
  const key = randomBytes(24).toString("hex");
  const other = randomBytes(24).toString("hex");
  const token = issueWith(key);
  const flipped = token.slice(0, -1) + (token.slice(-1) === "0" ? "1" : "0");
  const asCookie = sessionCookie(token).split(";")[0];          // "qav_session=<value>"
  const request = new Request("https://self.test/", { headers: { cookie: `a=b; ${asCookie}; c=d` } });
  const steps: Record<string, boolean> = {
    freshTokenAccepted: validWith(token, key),
    tamperedTokenRefused: !validWith(flipped, key),
    otherKeyRefused: !validWith(token, other),
    expiredTokenRefused: !validWith(issueWith(key, -60), key),
    garbageRefused: !validWith("not-a-token", key) && !validWith("", key) && !validWith(null, key),
    cookieRoundTrips: cookieValue(request, SESSION_COOKIE) === token,
    cookieIsHttpOnlySecureLax: /HttpOnly/.test(sessionCookie(token)) && /Secure/.test(sessionCookie(token)) && /SameSite=Lax/.test(sessionCookie(token)),
  };
  return { ok: Object.values(steps).every(Boolean), steps };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * A guard for a route that serves stored data.
 *
 * Returns null when the caller may proceed, otherwise the Response to send.
 * `openWhenUnconfigured` is for the QAV history route, which existed before
 * the passcode did: with no passcode set it stays open as it always was, so
 * nothing breaks on deploy; once a passcode exists it is protected like the
 * rest.
 */
export function requireSession(request: Request, opts?: { openWhenUnconfigured?: boolean }): Response | null {
  if (!authConfigured()) {
    return opts?.openWhenUnconfigured
      ? null
      : Response.json({ configured: false, reason: "QAV_PASSCODE not set" });
  }
  if (signedIn(request)) return null;
  return Response.json({ configured: true, signedIn: false, error: "sign in required" }, { status: 401 });
}

// ── Guess limiting ───────────────────────────────────────────────────────────
// In memory, so it is per server instance and resets on a cold start. That is
// enough to turn a guessing loop from thousands a minute into a handful; it is
// not a substitute for a passcode worth having.
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 8;
let failures: number[] = [];

export function tooManyFailures(): boolean {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  failures = failures.filter((t) => t > cutoff);
  return failures.length >= FAIL_LIMIT;
}

export function recordFailure(): void {
  failures.push(Date.now());
}
