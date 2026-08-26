/**
 * Level 16 — explicit same-origin enforcement for the API.
 *
 * WHAT THIS CHANGES, HONESTLY
 * ---------------------------
 * The application was already effectively same-origin before this file existed,
 * and it is worth being precise about that rather than implying a hole was
 * closed:
 *
 *   - Next.js sends no `Access-Control-Allow-Origin`, so a browser blocks any
 *     cross-origin script from READING an API response.
 *   - Every auth and session cookie is `SameSite=Lax`, so a cross-site POST
 *     carries no credentials — which is the CSRF case that would matter.
 *   - Every browser client in this application uses `credentials: 'same-origin'`.
 *
 * So this is not a fix for an open door. ROADMAP.md Level 16 requires "CORS
 * restrictions", and the value here is making an implicit property EXPLICIT and
 * TESTABLE: a request that announces a foreign origin is refused by this
 * application rather than merely ignored by the browser, and a preflight is
 * answered with a refusal rather than silence.
 *
 * WHY A MISSING `Origin` IS ALLOWED
 * ---------------------------------
 * Browsers omit `Origin` on same-origin GETs, and non-browser callers — curl,
 * the verification suites, a future CLI — never send one at all. Rejecting on
 * absence would break every script in `scripts/` while stopping no attacker,
 * because an attacker's browser is precisely what DOES attach the header.
 * Absence is therefore treated as "not a cross-origin browser request".
 */

/** JSON error with no caching, matching the shape the routes already use. */
function refuse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * The origin this request was addressed to.
 *
 * Taken from the request URL, which Next derives from the Host header. Behind a
 * reverse proxy that rewrites Host this would need `x-forwarded-host`, but
 * `RATE_LIMIT_TRUST_PROXY` is false by default and no proxy is part of this
 * deployment yet — see docs/DEPLOYMENT.md. Deliberately NOT reading
 * `x-forwarded-host` here: trusting an unverified header to decide what counts
 * as "our own origin" would let a caller declare any origin to be same-origin.
 */
function selfOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/**
 * Refuse a request that announces a foreign origin.
 *
 * Returns a Response to send, or null to continue.
 */
export function enforceSameOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin');

  // No Origin header: same-origin GET, or a non-browser caller. See above.
  if (origin === null || origin === 'null') return null;

  const expected = selfOrigin(request);
  if (expected !== null && origin === expected) return null;

  // Deliberately vague, and deliberately 403 rather than 404: the caller
  // already knows the endpoint exists, so there is nothing to conceal, but
  // naming the expected origin would hand back configuration detail.
  return refuse('Cross-origin requests are not permitted.', 403);
}

/**
 * Answer a CORS preflight with a refusal.
 *
 * No `Access-Control-Allow-Origin` is emitted anywhere in this application, so
 * a preflight can never succeed. Answering 405 explicitly is clearer than the
 * silence of an unimplemented method, and it gives the verification suite
 * something concrete to assert.
 */
export function rejectPreflight(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      allow: 'GET, POST, PATCH, DELETE',
      'cache-control': 'no-store',
    },
  });
}
