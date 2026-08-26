/**
 * Per-user documents.
 *
 *   GET  /api/documents   list the signed-in user's documents
 *   POST /api/documents   upload one (multipart/form-data, field "file")
 *
 * Both require authentication: uploads belong to an account, and there is no
 * anonymous corpus a visitor may add to. Anonymous chat keeps working against
 * the shared CLI-ingested corpus exactly as before.
 *
 * The owner is taken from the verified session and passed to the ingestion
 * layer as an argument. There is no field in the request — body, form, query or
 * header — that can influence it.
 */

import { getServerUser } from '@/lib/auth';
import { INFERENCE_DISABLED_MESSAGE, isInferenceDisabled } from '@/lib/inference-mode';
import {
  acquireSlot,
  checkBodySize,
  enforceGeminiBudget,
  enforceRateLimit,
  tooManyRequests,
} from '@/lib/rate-limit';
import { DocumentError, MAX_UPLOAD_BYTES, listDocuments, uploadDocument } from '@/lib/documents';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { log, newRequestId } from '@/lib/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function publicError(caught: unknown, context: string, requestId: string): Response {
  if (caught instanceof DocumentError) {
    return json({ error: caught.message }, caught.status);
  }
  // Storage messages can carry table and column names; logged, not returned.
  log.error('documents.failed', { requestId, operation: context, error: caught });
  return json({ error: 'Could not access your documents.' }, 500);
}

export async function GET(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  const user = await getServerUser(request);
  if (user === null) return json({ error: 'Sign in to manage documents.' }, 401);

  const throttled = enforceRateLimit(request, 'read', user.id);
  if (throttled !== null) return throttled;

  try {
    return json({ documents: await listDocuments(user.id, user.accessToken) });
  } catch (caught) {
    return publicError(caught, 'list', requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  const requestId = newRequestId();

  /**
   * Upload embeds every chunk before storing it, so it needs the same model
   * server chat does. With inference disabled the whole pipeline is
   * unavailable, and saying so immediately beats a progress spinner that ends
   * in a timeout. Checked before authentication: it is a property of the
   * deployment, not of the caller.
   */
  if (isInferenceDisabled()) {
    return json({ error: INFERENCE_DISABLED_MESSAGE }, 503);
  }

  const user = await getServerUser(request);
  if (user === null) return json({ error: 'Sign in to upload documents.' }, 401);

  // Refuse before reading the body. `formData()` buffers the upload, so the
  // per-file check inside uploadDocument cannot prevent the memory cost.
  const oversized = checkBodySize(request, MAX_UPLOAD_BYTES);
  if (oversized !== null) return oversized;

  const throttled = enforceRateLimit(request, 'upload', user.id);
  if (throttled !== null) return throttled;

  /**
   * Ingestion spends provider quota too — one embedding call per chunk, so a
   * single upload can cost far more than a chat turn. A budget that watched
   * only generation would miss the larger consumer entirely.
   */
  const overBudget = enforceGeminiBudget();
  if (overBudget !== null) return overBudget;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Upload must be multipart/form-data.' }, 400);
  }

  // Any identity field in the form is a spoofing attempt, not a mistake worth
  // silently tolerating — rejecting makes it visible.
  for (const field of ['user_id', 'userId', 'owner_id', 'ownerId']) {
    if (form.has(field)) {
      return json({ error: 'Ownership fields are not accepted.' }, 400);
    }
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return json({ error: 'Attach a file in the "file" field.' }, 400);
  }

  // Embedding occupies the same two cores as generation, so an upload takes a
  // concurrency slot exactly as a chat turn does. Without it, a few concurrent
  // uploads would starve every conversation on the server.
  const slot = acquireSlot(false);
  if (slot === null) return tooManyRequests('upload', 5);

  try {
    // Processing is synchronous: extraction, chunking and embedding all finish
    // before the response. On this hardware a large PDF can take a while, which
    // is why the UI shows an explicit uploading/processing state.
    const document = await uploadDocument(user.id, file, { signal: request.signal });
    return json({ document }, 201);
  } catch (caught) {
    return publicError(caught, 'upload', requestId);
  } finally {
    slot.release();
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
