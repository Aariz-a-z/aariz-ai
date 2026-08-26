/**
 * POST /api/chat — the browser's only route to a model.
 *
 * Responsibilities, in order: validate the request, hand it to the provider
 * abstraction, stream deltas back, and turn failures into useful responses.
 * It knows nothing about Ollama; that lives behind `getLlmProvider()`.
 *
 * Wire format (response): NDJSON, one JSON object per line.
 *   {"type":"delta","text":"…"}
 *   {"type":"error","message":"…"}
 *   {"type":"done"}
 *
 * Plain text would have been simpler, but a mid-stream failure would then be
 * indistinguishable from a finished answer — the user would see a truncated
 * reply presented as complete. Framing makes that failure visible.
 */

import { buildConversationContext, withConversationHistory } from '@/lib/conversation-context';
import {
  ConversationError,
  appendMessage,
  createConversation,
  deriveTitle,
  getConversation,
  getMessages,
  storeSummary,
  touchConversation,
} from '@/lib/conversations';
import { getLlmProvider } from '@/lib/llm';
import { LlmError, isAbortError, type LlmMessage } from '@/lib/llm/types';
import { RagError, prepareGroundedTurn } from '@/lib/rag';
import { RetrievalError } from '@/lib/retrieval';
import { resolveOwner } from '@/lib/auth';
import {
  acquireSlot,
  checkBodySize,
  enforceRateLimit,
  generationTokenLimit,
  concurrencySnapshot,
  enforceGeminiBudget,
  getRateLimitConfig,
  tooManyRequests,
  widgetIdentity,
} from '@/lib/rate-limit';
import { buildSessionCookie } from '@/lib/session';
import { enforceSameOrigin, rejectPreflight } from '@/lib/security-headers';
import { WIDGET_ORIGIN_HEADER, resolveWidgetOrigin } from '@/lib/widget-origins';
import { INFERENCE_DISABLED_MESSAGE, isInferenceDisabled } from '@/lib/inference-mode';
import { estimateTokens } from '@/lib/ingest/tokens';
import { looksLikeRefusal, recordRequest, type RequestOutcome } from '@/lib/metrics';
import { log, newRequestId } from '@/lib/log';

// Reaching a localhost Ollama server requires the Node runtime; the Edge
// runtime cannot open that connection.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Request-shape limits. These are input validation, not the Level 14 abuse
 * system — they bound a single malformed or oversized payload so it cannot
 * reach the model. Level 14 adds per-IP and per-user quotas.
 */
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 24_000;

/** Conversation ids are v4 UUIDs; anything else cannot name a real row. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ValidRequest {
  messages: LlmMessage[];
  /**
   * Continue an existing conversation (Level 12). Optional.
   *
   * Ownership is NOT taken from this field — it names a row, and the row is
   * then looked up scoped to the session cookie. A caller supplying someone
   * else's id gets a 404.
   */
  conversationId?: string;
  /** Create and persist a new conversation for this turn (Level 12). Optional. */
  startConversation?: boolean;
}

type ValidationResult = { ok: true; value: ValidRequest } | { ok: false; error: string };

function validate(payload: unknown): ValidationResult {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }

  const { messages, conversationId, startConversation } = payload as {
    messages?: unknown;
    conversationId?: unknown;
    startConversation?: unknown;
  };

  if (conversationId !== undefined) {
    if (typeof conversationId !== 'string' || !UUID_PATTERN.test(conversationId)) {
      return { ok: false, error: 'Field "conversationId" must be a UUID.' };
    }
  }
  if (startConversation !== undefined && typeof startConversation !== 'boolean') {
    return { ok: false, error: 'Field "startConversation" must be a boolean.' };
  }
  // Identity never comes from the body. Rejecting rather than ignoring makes an
  // attempt visible instead of letting a caller believe it took effect.
  if ('user_id' in (payload as object) || 'userId' in (payload as object) || 'session_id' in (payload as object)) {
    return { ok: false, error: 'Ownership fields are not accepted.' };
  }
  if (conversationId !== undefined && startConversation === true) {
    return {
      ok: false,
      error: 'Send either "conversationId" or "startConversation", not both.',
    };
  }

  if (!Array.isArray(messages)) {
    return { ok: false, error: 'Field "messages" must be an array.' };
  }
  if (messages.length === 0) {
    return { ok: false, error: 'Field "messages" must contain at least one message.' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `Too many messages (max ${MAX_MESSAGES}).` };
  }

  const validated: LlmMessage[] = [];
  let totalChars = 0;

  for (const [index, raw] of messages.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `Message ${index} must be an object.` };
    }

    const { role, content } = raw as { role?: unknown; content?: unknown };

    // The client may not set a system prompt. Accepting one would let a
    // browser rewrite the model's instructions — which is exactly the
    // grounding and injection boundary Level 8 depends on.
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, error: `Message ${index} has an invalid role. Expected "user" or "assistant".` };
    }
    if (typeof content !== 'string') {
      return { ok: false, error: `Message ${index} must have string content.` };
    }
    if (content.trim().length === 0) {
      return { ok: false, error: `Message ${index} must not be empty.` };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `Message ${index} exceeds ${MAX_MESSAGE_CHARS} characters.` };
    }

    totalChars += content.length;
    if (totalChars > MAX_TOTAL_CHARS) {
      return { ok: false, error: `Conversation exceeds ${MAX_TOTAL_CHARS} characters.` };
    }

    validated.push({ role, content });
  }

  if (validated[validated.length - 1]?.role !== 'user') {
    return { ok: false, error: 'The final message must have role "user".' };
  }

  return {
    ok: true,
    value: {
      messages: validated,
      ...(typeof conversationId === 'string' ? { conversationId } : {}),
      ...(startConversation === true ? { startConversation: true } : {}),
    },
  };
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Public-facing text for a provider failure.
 *
 * Deliberately does not echo `OLLAMA_BASE_URL` or `OLLAMA_MODEL` — that is
 * server-only configuration. The full detail is logged server-side instead of
 * being swallowed (Roadmap Rule 5).
 */
function publicMessage(error: unknown): { message: string; status: number } {
  if (error instanceof RetrievalError) {
    // Configuration and search failures are infrastructure problems, not
    // answers. Surfacing them beats quietly replying without any documents.
    return {
      message:
        error.code === 'search_failed'
          ? 'Could not search the document store. Check that the database is reachable.'
          : 'The retrieval request was rejected.',
      status: error.code === 'search_failed' ? 503 : 400,
    };
  }
  if (error instanceof ConversationError) {
    return {
      message:
        error.code === 'invalid_input'
          ? 'The conversation request was rejected.'
          : 'Could not access conversation history.',
      status: error.code === 'invalid_input' ? 400 : 503,
    };
  }
  if (error instanceof RagError) {
    return {
      message:
        error.code === 'invalid_configuration'
          ? 'The server is misconfigured. Check the server logs.'
          : 'The question could not be processed.',
      status: error.code === 'invalid_configuration' ? 500 : 400,
    };
  }
  if (error instanceof LlmError) {
    switch (error.code) {
      case 'provider_unreachable':
        return {
          message: 'The local model server is not running. Start it with "ollama serve" and try again.',
          status: 503,
        };
      case 'model_not_found':
        return {
          message: 'The configured model is not installed on the local model server.',
          status: 503,
        };
      case 'invalid_configuration':
        return { message: 'The server is misconfigured. Check the server logs.', status: 500 };
      case 'not_implemented':
        return { message: 'The configured provider is not implemented.', status: 501 };
      default:
        return { message: 'The local model failed to generate a reply.', status: 502 };
    }
  }
  return { message: 'An unexpected server error occurred.', status: 500 };
}

const encoder = new TextEncoder();
const line = (event: Record<string, unknown>): Uint8Array =>
  encoder.encode(`${JSON.stringify(event)}\n`);

export async function POST(request: Request): Promise<Response> {
  // Level 16: a request announcing a foreign origin is refused here rather than
  // merely ignored by the browser. Checked first — it is the cheapest rejection
  // available and needs no session or database work.
  const crossOrigin = enforceSameOrigin(request);
  if (crossOrigin !== null) return crossOrigin;

  /**
   * Level 17 — is this the embedded widget, and if so, from where?
   *
   * The header is only ever a CLAIM. It is resolved against
   * `WIDGET_ALLOWED_ORIGINS` and either becomes a configured entry or the
   * request is refused; the caller's own string is never carried forward.
   *
   * FAIL CLOSED: a header that is present but does not resolve is a 403. It
   * does NOT quietly degrade to ordinary anonymous chat, because that would
   * hand an unapproved site the shared anonymous budget by the simple trick of
   * sending a bad value — the opposite of what the allowlist is for. Absent
   * header means "not a widget request" and is left alone, which is what keeps
   * the first-party application and every prior level's suite unchanged.
   *
   * Checked before the body is read: refusing costs a Set lookup.
   */
  /**
   * No inference in this deployment. Refused before the body is read, before
   * any session lookup and before anything is recorded: there is no work to
   * do and nothing to meter. 503 because the capability is absent rather than
   * the request wrong, and the message is the shared honest one — it names no
   * address, provider or variable.
   */
  if (isInferenceDisabled()) {
    return jsonError(INFERENCE_DISABLED_MESSAGE, 503);
  }

  const claimedWidgetOrigin = request.headers.get(WIDGET_ORIGIN_HEADER);
  const isWidget = claimedWidgetOrigin !== null;
  const widgetOrigin = isWidget ? resolveWidgetOrigin(claimedWidgetOrigin) : null;
  if (isWidget && widgetOrigin === null) {
    // Names neither the claimed origin nor the allowlist. An error that echoed
    // either would turn this endpoint into a way to enumerate the policy.
    return jsonError('This origin is not permitted to use the embedded widget.', 403);
  }

  // One id for every line this request produces, so the six failure points
  // below can be correlated in the log.
  const requestId = newRequestId();

  /**
   * Level 18 — everything the roadmap requires this request to report.
   *
   * Collected in mutable locals and emitted exactly once by `settle()` below,
   * rather than logged piecemeal as each stage finishes. One line per request
   * with every field on it is what makes the log answerable; six partial lines
   * that have to be stitched back together by request id is what Level 16
   * replaced.
   *
   * Nothing here is user content: durations, counts, ids and a model tag.
   */
  const requestStartedAt = performance.now();
  let settled = false;
  let conversationIdForLog: string | null = null;
  let userIdForLog: string | null = null;
  let modelForLog: string | null = null;
  let chunkCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let generationMs: number | null = null;
  let embeddingMs: number | null = null;
  let searchMs: number | null = null;
  let retrievalMs: number | null = null;
  let concurrentAtStart = 0;

  /**
   * Emit the Level 18 log line and record the sample. Idempotent.
   *
   * Called from every terminal path, including the stream's `finally`, which
   * is reached on completion, failure and client disconnect alike. The guard
   * matters because a mid-stream error runs both the catch and the finally.
   */
  const settle = (outcome: RequestOutcome, retrievalFailed = false): void => {
    if (settled) return;
    settled = true;

    const totalMs = Math.round(performance.now() - requestStartedAt);

    recordRequest({
      outcome,
      totalMs,
      embeddingMs,
      searchMs,
      generationMs,
      chunks: chunkCount,
      promptTokens,
      completionTokens,
      retrievalFailed,
      widget: isWidget,
      concurrent: concurrentAtStart,
    });

    // `model` is logged but never rendered anywhere a browser can see it —
    // LlmProvider.model is documented as server-side only.
    log.info('chat.completed', {
      requestId,
      outcome,
      userId: userIdForLog,
      conversationId: conversationIdForLog,
      model: modelForLog,
      widget: isWidget,
      totalMs,
      retrievalMs,
      embeddingMs,
      searchMs,
      generationMs,
      chunks: chunkCount,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      retrievalFailed,
    });
  };

  // Level 14: refuse an oversized body BEFORE reading it. `request.json()`
  // buffers the whole payload first, so Level 3's character limits — which run
  // after parsing — cannot prevent the memory cost of a huge request.
  const rateConfig = getRateLimitConfig();
  const oversized = checkBodySize(request, rateConfig.maxRequestBytes);
  if (oversized !== null) return oversized;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  const validation = validate(payload);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }

  let provider;
  try {
    provider = getLlmProvider();
  } catch (caught) {
    log.error('chat.provider_config_failed', { requestId, error: caught });
    settle('error');
    const { message, status } = publicMessage(caught);
    return jsonError(message, status);
  }
  modelForLog = provider.model;

  // Level 8: retrieve first, then ground. The question is the final user
  // message, which validation has already guaranteed exists.
  const question = validation.value.messages[validation.value.messages.length - 1]!.content;

  // --- Level 12: conversation persistence, opt-in ---------------------------
  // A request carrying neither field behaves exactly as it did at Level 11:
  // nothing is read, nothing is written, and no session is issued. That is what
  // keeps the Level 8 and Level 11 suites measuring what they measured before.
  const { conversationId, startConversation } = validation.value;

  /**
   * Level 17: the embedded widget is stateless, and refuses rather than
   * pretends.
   *
   * It has no conversation history by design — a third-party iframe receives
   * none of this application's `SameSite=Lax` cookies, so there is no session
   * to hang a conversation from and nothing to scope one to. A widget request
   * carrying `conversationId` or `startConversation` is therefore rejected
   * outright instead of being silently ignored, so a caller cannot believe
   * persistence took effect when it did not.
   */
  if (isWidget && (conversationId !== undefined || startConversation === true)) {
    return jsonError('The embedded widget does not support saved conversations.', 400);
  }

  const persisting = conversationId !== undefined || startConversation === true;

  /**
   * Identity from the server-verified session: an authenticated user if the
   * auth cookie holds a token Supabase accepts, otherwise the anonymous
   * session.
   *
   * SKIPPED ENTIRELY FOR THE WIDGET. Not because the cookies would be absent
   * anyway — they would — but because the widget must not become a way to act
   * on somebody's signed-in account from a page they do not control. Forcing
   * the anonymous owner here means that holds even if this application is one
   * day embedded in a first-party page where its own cookies DO arrive.
   */
  const resolved = isWidget ? null : await resolveOwner(request);
  // A throwaway id for the widget's anonymous owner. Never stored, never sent
  // to the browser, and unique per request — a fixed sentinel such as '' would
  // silently become a shared scope if anything downstream ever keyed on it.
  const owner = resolved?.owner ?? ({ kind: 'anonymous', sessionId: crypto.randomUUID() } as const);
  const isNewSession = resolved?.isNewSession ?? false;
  const sessionId = resolved?.sessionId ?? owner.sessionId;

  // Level 14. Identity comes from the verified session above; nothing here is
  // read from the request body.
  const rateLimitUserId = owner.kind === 'authenticated' ? owner.userId : null;
  const isAnonymous = rateLimitUserId === null;
  // ROADMAP.md Level 18: "user ID where available". Null for anonymous and for
  // every widget request, and taken from the verified session — never from the
  // body, which validation rejects outright.
  userIdForLog = rateLimitUserId;

  /**
   * Level 17: a widget request spends the embedding SITE's budget, keyed by
   * the allowlist entry resolved above — never by anything the caller chose,
   * and never by the shared anonymous bucket it would otherwise land in. The
   * ordinary path is untouched.
   */
  const throttled =
    widgetOrigin !== null
      ? enforceRateLimit(request, 'widget', null, rateConfig, widgetIdentity(widgetOrigin))
      : enforceRateLimit(request, 'chat', rateLimitUserId, rateConfig);
  if (throttled !== null) return throttled;

  /**
   * The GLOBAL provider budget, checked after the per-caller one.
   *
   * Order matters. The per-caller limit answers "is this person asking too
   * much"; this answers "has the application as a whole spent enough today".
   * Checking the caller first means one heavy user is refused on their own
   * account rather than being allowed to eat into the shared budget and have
   * everyone else refused instead. A no-op unless the provider is metered.
   */
  const overBudget = enforceGeminiBudget(rateConfig);
  if (overBudget !== null) return overBudget;

  // A slot is held for the whole span that occupies the CPU — retrieval,
  // summarisation and generation alike, since all three call the local model.
  // Taken AFTER the token check so a caller who is already over budget does not
  // briefly occupy a slot on the way to being refused.
  const slot = acquireSlot(isAnonymous, rateConfig);
  if (slot === null) {
    return tooManyRequests('chat', 5);
  }

  // Level 18: read immediately AFTER acquiring, so this request is included.
  // The Level 14 counters live in this bundle and the dashboard's does not,
  // so the value is carried into the shared metrics store rather than read
  // there. See the note on RequestSample.concurrent.
  concurrentAtStart = concurrencySnapshot().inFlight;

  /**
   * Release the slot on any path that returns instead of streaming.
   *
   * Every early return below is wrapped in this. The streaming path keeps the
   * slot and releases it from the stream's own `finally`, which is reached on
   * completion, failure and client disconnect alike.
   */
  const fail = (response: Response): Response => {
    slot.release();
    return response;
  };

  let conversation: { id: string; title: string } | null = null;
  let history: LlmMessage[] = [];
  let summaryToStore: { summary: string; summarisedThrough: string } | null = null;

  if (persisting) {
    try {
      if (conversationId !== undefined) {
        const existing = await getConversation(owner, conversationId);
        // Absent and "belonging to another session" are the same answer on
        // purpose - see src/app/api/conversations/[id]/route.ts.
        if (existing === null) return fail(jsonError('Conversation not found.', 404));

        conversation = { id: existing.id, title: existing.title };

        // History comes from the database, never from the request. A client
        // supplied assistant turn would be an unvalidated way to put words in
        // the model's mouth - the same reason a client `system` role is refused.
        const stored = await getMessages(owner, existing.id);
        const context = await buildConversationContext(existing, stored, {
          signal: request.signal,
        });
        history = context.messages;
        summaryToStore = context.summaryToStore;
      } else {
        const created = await createConversation(owner, deriveTitle(question));
        conversation = { id: created.id, title: created.title };
      }

      conversationIdForLog = conversation.id;

      // Written before generation begins: if the model then fails, the user
      // still has what they typed rather than an empty conversation.
      await appendMessage(owner, conversation.id, 'user', question);
    } catch (caught) {
      if (isAbortError(caught)) {
        settle('aborted');
        return fail(new Response(null, { status: 499 }));
      }
      log.error('chat.persist_failed', { requestId, error: caught });
      settle('error');
      const { message, status } = publicMessage(caught);
      return fail(jsonError(message, status));
    }
  }

  let grounded;
  try {
    grounded = await prepareGroundedTurn(question, {
      signal: request.signal,
      // Search only this identity's documents. An authenticated user sees their
      // own uploads; anonymous callers see the shared corpus. The value comes
      // from the verified session, never from the request.
      ownerId: owner.kind === 'authenticated' ? owner.userId : null,
    });
  } catch (caught) {
    if (isAbortError(caught)) {
      settle('aborted');
      return fail(new Response(null, { status: 499 }));
    }
    log.error('chat.grounding_failed', { requestId, error: caught });
    // Level 18 distinguishes "the search itself broke" from any other reason
    // grounding could not be produced. Only the former is a retrieval failure.
    settle('error', caught instanceof RetrievalError && caught.code === 'search_failed');
    const { message, status } = publicMessage(caught);
    return fail(jsonError(message, status));
  }

  // Level 18 measurements from the grounding stage.
  embeddingMs = grounded.timings.embeddingMs;
  searchMs = grounded.timings.searchMs;
  retrievalMs = grounded.timings.retrievalMs;
  chunkCount = grounded.sources.length;

  // The system prompt is assembled server-side, after validation has already
  // rejected any client-supplied `system` role. The browser has no way to see
  // it, replace it, or append to it — the only system message that reaches the
  // model is the one built here. Retrieved document text is placed in the USER
  // turn as data, never in the instruction channel.
  // With no conversation, `history` is empty and this returns `grounded.messages`
  // unchanged - the Level 11 message array, byte for byte.
  const messages: LlmMessage[] = withConversationHistory(grounded.messages, history);

  const iterator = provider
    .stream({
      messages,
      signal: request.signal,
      // Level 14: bound the OUTPUT as well as the input. Without this a single
      // question can occupy the model until it decides to stop, which on this
      // hardware is minutes. Anonymous callers get the smaller ceiling.
      maxTokens: generationTokenLimit(isAnonymous, rateConfig),
    })
    [Symbol.asyncIterator]();

  // Pull the first delta before responding. This is what lets a connection
  // failure return a real 503 instead of a 200 whose body happens to contain
  // an error — the browser can then distinguish "server down" from "bad answer".
  //
  // Level 18: "approximate token counts", using the Level 6 estimator rather
  // than the provider's own counter. The roadmap's word is "approximate", and
  // reading Ollama's `prompt_eval_count` would mean widening the Level 3
  // provider abstraction with a field a future provider might not supply.
  promptTokens = estimateTokens(messages.map((message) => message.content).join('\n'));

  const generationStartedAt = performance.now();

  let first: IteratorResult<string>;
  try {
    first = await iterator.next();
  } catch (caught) {
    if (isAbortError(caught)) {
      settle('aborted');
      return fail(new Response(null, { status: 499 }));
    }
    log.error('chat.provider_failed_pre_stream', { requestId, error: caught });
    settle('error');
    const { message, status } = publicMessage(caught);
    return fail(jsonError(message, status));
  }

  // Level 18: decided in the catch, consumed in the finally. A mid-stream
  // failure runs both, and the finally must not overwrite the real outcome
  // with "ok" just because some text arrived before the break.
  let streamOutcome: RequestOutcome | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = '';
      try {
        // The conversation id goes first so the browser can adopt it before any
        // text arrives - that is what lets a brand new chat survive a refresh
        // that happens mid-answer.
        if (conversation !== null) {
          controller.enqueue(
            line({ type: 'conversation', id: conversation.id, title: conversation.title }),
          );
        }

        // Sources go next so the UI can render them alongside the answer as it
        // streams, rather than waiting for generation to finish.
        controller.enqueue(line({ type: 'sources', sources: grounded.sources }));

        if (!first.done && first.value) {
          answer += first.value;
          controller.enqueue(line({ type: 'delta', text: first.value }));
        }

        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value) {
            answer += next.value;
            controller.enqueue(line({ type: 'delta', text: next.value }));
          }
        }

        controller.enqueue(line({ type: 'done' }));
      } catch (caught) {
        if (isAbortError(caught)) {
          // The user pressed Stop. Nothing to report; just end the stream.
          streamOutcome = 'aborted';
          await iterator.return?.(undefined);
        } else {
          streamOutcome = 'error';
          log.error('chat.provider_failed_mid_stream', { requestId, error: caught });
          controller.enqueue(line({ type: 'error', message: publicMessage(caught).message }));
        }
      } finally {
        // Level 12: store the assistant turn together with its citations, so a
        // refreshed page renders the same sources under the same answer.
        //
        // Partial text is kept deliberately. The UI keeps what streamed before
        // Stop, and discarding it here would make a refresh silently lose text
        // the user can still see on screen.
        if (conversation !== null && answer.length > 0) {
          try {
            await appendMessage(owner, conversation.id, 'assistant', answer, grounded.sources);
            await touchConversation(owner, conversation.id);
            if (summaryToStore !== null) {
              await storeSummary(
                owner,
                conversation.id,
                summaryToStore.summary,
                summaryToStore.summarisedThrough,
              );
            }
          } catch (caught) {
            // A storage failure must not turn an answer the user already read
            // into a failed request. Logged, not surfaced.
            log.error('chat.persist_answer_failed', { requestId, error: caught });
          }
        }
        // Level 18: generation spanned from just before the first token to
        // here, so it covers the whole stream rather than time-to-first-token.
        generationMs = Math.round(performance.now() - generationStartedAt);
        completionTokens = estimateTokens(answer);

        // A refusal is an ANSWER the model declined to give, so it is only
        // meaningful when generation actually succeeded. `looksLikeRefusal`
        // reads the text and keeps nothing but the boolean.
        settle(streamOutcome ?? (looksLikeRefusal(answer) ? 'refused' : 'ok'));

        // Level 14: the slot is held for the life of the stream, so it is
        // returned here — reached on completion, on error, and on disconnect.
        slot.release();
        controller.close();
      }
    },

    async cancel() {
      // Browser disconnected — stop generation instead of letting it run on.
      // Not a failure: `settle` is idempotent, so if the finally already ran
      // this changes nothing.
      settle('aborted');
      slot.release();
      await iterator.return?.(undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Prevents proxies from buffering the stream into one chunk.
      'x-accel-buffering': 'no',
      // Only when this request actually started persisting something. A
      // stateless call must not acquire a session as a side effect.
      ...(persisting && isNewSession ? { 'set-cookie': buildSessionCookie(sessionId) } : {}),
    },
  });
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
