/**
 * Sign in / out with the passcode. See lib/server-auth.ts for the design.
 *
 *   GET    /api/auth   -> { configured, signedIn }
 *   GET    /api/auth?selftest=1 -> { ok, steps }   (checks the session code
 *                                  with a throwaway key; reveals nothing)
 *   POST   /api/auth   { passcode } -> sets the session cookie
 *   DELETE /api/auth   -> clears it
 *
 * `configured: false` means QAV_PASSCODE is not set, so there is nothing to
 * sign in to and the app keeps everything in the browser as before.
 */
import {
  authConfigured, signedIn, passcodeMatches, issueToken, previewSandbox, authSelfTest,
  sessionCookie, clearedCookie, tooManyFailures, recordFailure,
} from "@/lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("selftest")) {
    return Response.json(authSelfTest(), { headers: NO_STORE });
  }
  return Response.json(
    { configured: authConfigured(), signedIn: signedIn(request), sandbox: previewSandbox() },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  // A preview sandbox has no passcode to check and is already signed in.
  if (!authConfigured() || previewSandbox()) {
    return Response.json({ configured: false, signedIn: false }, { headers: NO_STORE });
  }
  if (tooManyFailures()) {
    return Response.json(
      { configured: true, signedIn: false, error: "Too many wrong attempts — wait a minute and try again." },
      { status: 429, headers: NO_STORE },
    );
  }
  let given: unknown = null;
  try {
    given = ((await request.json()) as { passcode?: unknown })?.passcode;
  } catch { /* an unreadable body is just a wrong passcode */ }

  if (!passcodeMatches(given)) {
    recordFailure();
    // A fixed pause on every miss, so guessing cannot be done at wire speed.
    await new Promise((r) => setTimeout(r, 600));
    return Response.json(
      { configured: true, signedIn: false, error: "That passcode is not right." },
      { status: 401, headers: NO_STORE },
    );
  }
  return Response.json(
    { configured: true, signedIn: true },
    { headers: { ...NO_STORE, "Set-Cookie": sessionCookie(issueToken()) } },
  );
}

export async function DELETE() {
  return Response.json(
    { configured: authConfigured(), signedIn: false },
    { headers: { ...NO_STORE, "Set-Cookie": clearedCookie() } },
  );
}
