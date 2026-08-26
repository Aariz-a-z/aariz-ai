/**
 * DELETE /api/documents/:id — remove one of the caller's own documents.
 *
 * Answers 404 for both "no such document" and "not yours", so a caller learns
 * nothing by probing ids. That is not enforced by remembering to write 404 in
 * the right branch: the delete runs through the user's RLS-subject client, so a
 * document owned by somebody else simply matches no row.
 *
 * Chunks and their embeddings go with the document through ON DELETE CASCADE.
 */

import { getServerUser } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { DocumentError, deleteDocument } from '@/lib/documents';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { log, newRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function DELETE(
  request: Request,
  context: RouteContext<'/api/documents/[id]'>,
): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const user = await getServerUser(request);
  if (user === null) {
    return Response.json({ error: 'Sign in to manage documents.' }, { status: 401, headers: NO_STORE });
  }

  const throttled = enforceRateLimit(request, 'read', user.id);
  if (throttled !== null) return throttled;

  const { id } = await context.params;

  try {
    const deleted = await deleteDocument(user.id, user.accessToken, id);
    return Response.json(
      deleted ? { deleted: true } : { error: 'Document not found.' },
      { status: deleted ? 200 : 404, headers: NO_STORE },
    );
  } catch (caught) {
    if (caught instanceof DocumentError) {
      return Response.json({ error: caught.message }, { status: caught.status, headers: NO_STORE });
    }
    log.error('document.delete_failed', { requestId, error: caught });
    return Response.json({ error: 'Could not delete the document.' }, { status: 500, headers: NO_STORE });
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
