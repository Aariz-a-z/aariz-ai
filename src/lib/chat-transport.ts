/**
 * Browser-side transport: talks to `/api/chat` and nothing else.
 *
 * The UI never learns that a model exists, let alone which one. It has no
 * knowledge of Ollama, no base URL, no model name, and no database access — all
 * of that is server-only.
 *
 * Response wire format is NDJSON, one JSON object per line:
 *   {"type":"conversation","id":"…","title":"…"}  persisted chat (Level 12)
 *   {"type":"sources","sources":[…]}  documents behind the answer (Level 8)
 *   {"type":"delta","text":"…"}       incremental answer text
 *   {"type":"error","message":"…"}    failure after streaming began
 *   {"type":"done"}                   clean end of stream
 */

import type { AnswerSource } from '@/types/chat';

export interface StreamReplyOptions {
  /** The user's message. */
  prompt: string;
  /** Aborted when the user presses Stop. */
  signal: AbortSignal;
  /**
   * Continue a persisted conversation (Level 12).
   *
   * This names a row; it does not assert ownership. The server resolves the
   * conversation against the session in its own httpOnly cookie and answers
   * 404 if the pairing does not hold, so supplying another chat's id achieves
   * nothing.
   */
  conversationId?: string;
  /** Ask the server to create and persist a new conversation for this turn. */
  startConversation?: boolean;
  /**
   * Level 17 — the origin of the page embedding the widget, when this call
   * comes from `/embed`.
   *
   * Set only by the embedded chat, and only to a value the browser itself
   * reported as `event.origin` on a `postMessage` from the parent frame. It
   * makes the request draw on that site's widget budget instead of the shared
   * anonymous one, and the server re-validates it against its own allowlist —
   * this header is a claim, not a credential.
   *
   * Its presence also switches the request to `credentials: 'omit'`, so the
   * widget can never act on a signed-in session even if it is one day embedded
   * in a first-party page where cookies would reach it.
   */
  widgetOrigin?: string;
}

/**
 * What a caller receives while consuming a reply.
 *
 * A discriminated union rather than a bare string, because a grounded answer
 * carries its sources as well as its text. The caller decides what to do with
 * each; the transport does not interpret either.
 */
export type StreamChunk =
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: AnswerSource[] }
  | { type: 'conversation'; id: string; title: string };

interface DeltaEvent {
  type: 'delta';
  text: string;
}
interface SourcesEvent {
  type: 'sources';
  sources: AnswerSource[];
}
interface ErrorEvent {
  type: 'error';
  message: string;
}
interface DoneEvent {
  type: 'done';
}
interface ConversationEvent {
  type: 'conversation';
  id: string;
  title: string;
}
type StreamEvent = DeltaEvent | SourcesEvent | ErrorEvent | DoneEvent | ConversationEvent;

/** Pull the server's message out of a non-2xx response, if it sent one. */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error.length > 0) {
      return data.error;
    }
  } catch {
    /* fall through to the generic message */
  }
  return `The server returned an unexpected response (HTTP ${response.status}).`;
}

/**
 * Streams a reply from the server.
 *
 * Throws `AbortError` when the caller aborts — callers should treat that as a
 * deliberate stop and keep the partial text, not as a failure.
 */
export async function* streamReply({
  prompt,
  signal,
  conversationId,
  startConversation,
  widgetOrigin,
}: StreamReplyOptions): AsyncGenerator<StreamChunk, void, unknown> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(widgetOrigin !== undefined ? { 'x-widget-origin': widgetOrigin } : {}),
    },
    // Only the new turn is sent. Level 12 keeps prior turns server-side and
    // reads them from the database, so the browser cannot fabricate history -
    // and the request stays small however long the conversation grows.
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(startConversation === true ? { startConversation: true } : {}),
    }),
    // Send and accept the session cookie the server issues — except from the
    // widget, which must carry no identity at all. See `widgetOrigin` above.
    credentials: widgetOrigin !== undefined ? 'omit' : 'same-origin',
    signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
  if (response.body === null) {
    throw new Error('The server returned an empty response.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Only whole lines are parseable; a partial tail waits for more bytes.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;

        let event: StreamEvent;
        try {
          event = JSON.parse(trimmed) as StreamEvent;
        } catch {
          throw new Error('The server sent a malformed response.');
        }

        switch (event.type) {
          case 'conversation':
            yield { type: 'conversation', id: event.id, title: event.title };
            break;
          case 'sources':
            yield { type: 'sources', sources: event.sources };
            break;
          case 'delta':
            yield { type: 'delta', text: event.text };
            break;
          case 'error':
            // A failure that began after streaming started. Surfacing it is
            // the whole reason the stream is framed rather than plain text.
            throw new Error(event.message);
          case 'done':
            return;
        }
      }
    }
  } finally {
    // Releases the connection on abort, error, or early return by the caller.
    await reader.cancel().catch(() => undefined);
  }
}
