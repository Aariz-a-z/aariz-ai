/**
 * Level 12 — conversation collection.
 *
 *   GET  /api/conversations   list this session's chats
 *   POST /api/conversations   create a chat
 *
 * Every query is scoped to the session id from the httpOnly cookie. A caller
 * cannot ask for someone else's list, because there is no parameter with which
 * to ask: the scope comes from the cookie the server itself issued and never
 * from the request body or query string.
 */

import { resolveOwner } from '@/lib/auth';
import {
  ConversationError,
  createConversation,
  listConversations,
  validateTitle,
} from '@/lib/conversations';
import { enforceRateLimit } from '@/lib/rate-limit';
import { buildSessionCookie, readSessionId } from '@/lib/session';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { log, newRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extraHeaders } });
}

function publicError(caught: unknown, requestId: string): Response {
  if (caught instanceof ConversationError && caught.code === 'invalid_input') {
    return json({ error: caught.message }, 400);
  }
  // Storage failures are logged in full server-side and reported generically:
  // the message can carry table and column names.
  log.error('conversations.failed', { requestId, error: caught });
  return json({ error: 'Could not access conversations.' }, 500);
}

/**
 * List the session's conversations.
 *
 * A request with no session gets an empty list and NO cookie. Handing out a
 * session from a read-only endpoint would mint identifiers for every crawler
 * and preflight that ever touches this path.
 */
export async function GET(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const { owner } = await resolveOwner(request);

  const throttled = enforceRateLimit(
    request,
    'read',
    owner.kind === 'authenticated' ? owner.userId : null,
  );
  if (throttled !== null) return throttled;

  // An anonymous caller with no session cookie has nothing to list, and issuing
  // one from a read-only endpoint would mint identifiers for every crawler.
  // A signed-in caller is listed regardless: their chats belong to the account,
  // not to the browser session.
  if (owner.kind === 'anonymous' && readSessionId(request) === null) {
    return json({ conversations: [] });
  }

  try {
    return json({ conversations: await listConversations(owner) });
  } catch (caught) {
    return publicError(caught, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const { owner, sessionId, isNewSession } = await resolveOwner(request);

  const throttled = enforceRateLimit(
    request,
    'read',
    owner.kind === 'authenticated' ? owner.userId : null,
  );
  if (throttled !== null) return throttled;

  let title = 'New chat';
  try {
    const raw: unknown = await request.json().catch(() => ({}));
    if (typeof raw === 'object' && raw !== null) {
      // Ownership is decided by the verified session, never by the body.
      // Rejecting rather than ignoring makes an attempt visible instead of
      // letting a caller believe it worked.
      if ('user_id' in raw || 'userId' in raw || 'session_id' in raw) {
        return json({ error: 'Ownership fields are not accepted.' }, 400);
      }
      if ('title' in raw) {
        const supplied = (raw as { title?: unknown }).title;
        if (supplied !== undefined && supplied !== null) title = validateTitle(supplied);
      }
    }
  } catch (caught) {
    return publicError(caught, requestId);
  }

  try {
    const conversation = await createConversation(owner, title);
    return json(
      { conversation },
      201,
      isNewSession ? { 'set-cookie': buildSessionCookie(sessionId) } : {},
    );
  } catch (caught) {
    return publicError(caught, requestId);
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
