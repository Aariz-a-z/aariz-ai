/**
 * GET /api/auth/session — who am I? (Level 13)
 *
 * Returns whether this request is authenticated and, if so, the email address.
 * Deliberately NOT the user id: the browser has no legitimate use for it, and
 * anything the browser holds is something an attacker can try to replay. Every
 * ownership decision is made server-side from the verified session.
 *
 * Also reports whether authentication is configured at all, so the UI can hide
 * sign-in rather than offering a button that always fails.
 */

import { getServerUser } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { isAuthConfigured } from '@/lib/supabase/authed';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const configured = isAuthConfigured();
  const user = configured ? await getServerUser(request) : null;

  // Called on every page load, so it draws on the generous read budget rather
  // than a tight one — but it is still counted.
  const throttled = enforceRateLimit(request, 'read', user?.id ?? null);
  if (throttled !== null) return throttled;

  return Response.json(
    { configured, authenticated: user !== null, email: user?.email ?? null },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
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
