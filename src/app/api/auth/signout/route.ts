/**
 * POST /api/auth/signout — end a session (Level 13).
 *
 * Clears the auth cookies AND rotates the anonymous session to a fresh one.
 *
 * The rotation matters. Conversations claimed at sign-in keep the session id
 * they began under, so leaving that cookie in place would hand the next
 * anonymous visitor on this browser a session id that once belonged to a
 * signed-in user. The anonymous queries also filter `user_id IS NULL`, so those
 * rows are already invisible — but relying on a single check for that would be
 * one edit away from a leak.
 */

import { clearAuthCookies } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { buildSessionCookie, createSessionId } from '@/lib/session';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  // Cheap, but still bounded: an unbounded endpoint is an unbounded endpoint.
  const throttled = enforceRateLimit(request, 'read', null);
  if (throttled !== null) return throttled;

  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const value of clearAuthCookies()) headers.append('set-cookie', value);
  headers.append('set-cookie', buildSessionCookie(createSessionId()));

  return Response.json({ authenticated: false }, { status: 200, headers });
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
