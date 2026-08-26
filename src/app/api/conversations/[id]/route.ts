/**
 * Level 12 — a single conversation.
 *
 *   GET    /api/conversations/:id   the conversation and its full history
 *   PATCH  /api/conversations/:id   rename
 *   DELETE /api/conversations/:id   delete, cascading to its messages
 *
 * WHY EVERY OWNERSHIP FAILURE IS A 404
 * ------------------------------------
 * A 403 would confirm that the conversation exists, which is information the
 * caller has no right to. Since conversation ids are unguessable v4 UUIDs, a
 * uniform 404 means a caller learns nothing at all from probing: absent and
 * "belongs to someone else" are indistinguishable.
 *
 * That is not enforced by remembering to write 404 in three places — the data
 * layer filters on `session_id` inside the query, so a conversation belonging
 * to another session simply does not come back. See `src/lib/conversations.ts`.
 */

import { resolveOwner } from '@/lib/auth';
import {
  ConversationError,
  deleteConversation,
  getConversation,
  getMessages,
  renameConversation,
} from '@/lib/conversations';
import { enforceRateLimit } from '@/lib/rate-limit';
import { readSessionId } from '@/lib/session';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { log, newRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

/** The single response for "you may not have this", whatever the reason. */
function notFound(): Response {
  return json({ error: 'Conversation not found.' }, 404);
}

function publicError(caught: unknown, requestId: string): Response {
  if (caught instanceof ConversationError && caught.code === 'invalid_input') {
    return json({ error: caught.message }, 400);
  }
  log.error('conversation.failed', { requestId, error: caught });
  return json({ error: 'Could not access the conversation.' }, 500);
}

export async function GET(
  request: Request,
  context: RouteContext<'/api/conversations/[id]'>,
): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const { owner } = await resolveOwner(request);
  if (owner.kind === 'anonymous' && readSessionId(request) === null) return notFound();

  const throttled = enforceRateLimit(
    request,
    'read',
    owner.kind === 'authenticated' ? owner.userId : null,
  );
  if (throttled !== null) return throttled;

  const { id } = await context.params;

  try {
    const conversation = await getConversation(owner, id);
    if (conversation === null) return notFound();

    const messages = await getMessages(owner, conversation.id);
    return json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
      },
      // `summary`, `summarised_through` and `session_id` are deliberately not
      // returned. They are server-side context machinery, not chat content.
      messages,
    });
  } catch (caught) {
    return publicError(caught, requestId);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<'/api/conversations/[id]'>,
): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const { owner } = await resolveOwner(request);
  if (owner.kind === 'anonymous' && readSessionId(request) === null) return notFound();

  const throttled = enforceRateLimit(
    request,
    'read',
    owner.kind === 'authenticated' ? owner.userId : null,
  );
  if (throttled !== null) return throttled;

  const { id } = await context.params;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  if (typeof payload !== 'object' || payload === null || !('title' in payload)) {
    return json({ error: 'Field "title" is required.' }, 400);
  }
  if ('user_id' in payload || 'userId' in payload || 'session_id' in payload) {
    return json({ error: 'Ownership fields are not accepted.' }, 400);
  }

  try {
    const conversation = await renameConversation(
      owner,
      id,
      (payload as { title: unknown }).title as string,
    );
    return conversation === null ? notFound() : json({ conversation });
  } catch (caught) {
    return publicError(caught, requestId);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext<'/api/conversations/[id]'>,
): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const { owner } = await resolveOwner(request);
  if (owner.kind === 'anonymous' && readSessionId(request) === null) return notFound();

  const throttled = enforceRateLimit(
    request,
    'read',
    owner.kind === 'authenticated' ? owner.userId : null,
  );
  if (throttled !== null) return throttled;

  const { id } = await context.params;

  try {
    const deleted = await deleteConversation(owner, id);
    // Messages go with it through ON DELETE CASCADE in the migration, rather
    // than a second delete here that could be interrupted halfway.
    return deleted ? json({ deleted: true }) : notFound();
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
