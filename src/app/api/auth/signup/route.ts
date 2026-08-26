/**
 * POST /api/auth/signup — create an account (Level 13).
 *
 * Credentials go to Supabase Auth and are never stored, logged or echoed by
 * this application. The response carries no token in its body: the session
 * lives in httpOnly cookies the browser cannot read.
 */

import { AuthError, buildAuthCookies, claimAnonymousConversations, signUp } from '@/lib/auth';
import { checkBodySize, enforceRateLimit, getRateLimitConfig } from '@/lib/rate-limit';
import { buildSessionCookie, resolveSession } from '@/lib/session';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { log, newRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  // Credential endpoints are rate limited hardest: this is where a caller
  // would sit and guess. Identity is necessarily anonymous here — there is no
  // verified session yet — so the budget is the anonymous one.
  const rateConfig = getRateLimitConfig();
  const oversized = checkBodySize(request, rateConfig.maxRequestBytes);
  if (oversized !== null) return oversized;

  const throttled = enforceRateLimit(request, 'auth', null, rateConfig);
  if (throttled !== null) return throttled;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const { email, password } = (payload ?? {}) as { email?: unknown; password?: unknown };

  try {
    const { session, needsConfirmation } = await signUp(email, password);

    if (session === null) {
      // The project requires email confirmation. Saying so plainly beats
      // returning 200 and letting the UI imply the user is signed in.
      return Response.json(
        {
          authenticated: false,
          needsConfirmation: true,
          message: 'Account created. Confirm your email address, then sign in.',
        },
        { status: 201 },
      );
    }

    const anonymous = resolveSession(request);
    const claimed = await claimAnonymousConversations(session.userId, anonymous.sessionId);

    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const value of buildAuthCookies(session)) headers.append('set-cookie', value);
    if (anonymous.isNew) headers.append('set-cookie', buildSessionCookie(anonymous.sessionId));

    return Response.json(
      { authenticated: true, needsConfirmation, email: session.email, claimedConversations: claimed },
      { status: 201, headers },
    );
  } catch (caught) {
    if (caught instanceof AuthError) {
      return Response.json({ error: caught.message }, { status: caught.status });
    }
    log.error('auth.signup_failed', { requestId, error: caught });
    return Response.json({ error: 'Could not create the account.' }, { status: 500 });
  }
}

/**
 * Level 16: refuse CORS preflight explicitly.
 *
 * No `Access-Control-Allow-Origin` is emitted anywhere in this application, so
 * a preflight could never succeed. Answering deliberately beats the silence of
 * an unimplemented method.
 */
export async function OPTIONS(): Promise<Response> {
  return rejectPreflight();
}
