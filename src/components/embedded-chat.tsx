'use client';

/**
 * Level 17 — the chat surface inside the widget iframe.
 *
 * Deliberately NOT `Chat` from `@/components/chat`. That component owns the
 * conversation sidebar, the authentication panel and the document library, all
 * of which depend on cookies that a third-party iframe never receives; it would
 * render three broken panels and a sign-in form that cannot work. This is the
 * subset that does work without a session: greeting, messages, composer.
 *
 * It duplicates no logic. Retrieval, grounding, generation and rate limiting
 * are the server's, reached through the same `streamReply` transport the main
 * application uses, and the presentational pieces — `MessageBubble`,
 * `MessageSources`, `ChatComposer` — are the same components.
 *
 * INERT UNTIL AN ALLOWLISTED PARENT SAYS HELLO
 * --------------------------------------------
 * The composer does not accept input until a `postMessage` arrives whose
 * `event.origin` is on the allowlist. `event.origin` is set by the browser from
 * the sending document's real origin and cannot be forged by that document's
 * JavaScript, which makes it the one trustworthy signal available in here.
 *
 * That is a UI gate, not the security boundary — a determined caller can talk
 * to `/api/chat` directly and skip this file entirely. It is the server's own
 * allowlist check on every request that bounds abuse. What this gate buys is
 * that the widget cannot be usefully framed by a page the browser somehow let
 * through, and that no request is ever sent without an origin to attribute it
 * to.
 *
 * THE MESSAGE PROTOCOL
 * --------------------
 * Mirrored in `public/widget.js`; change both together.
 *
 *   parent -> frame   aariz:host-hello   { greeting?: string }
 *   parent -> frame   aariz:open         panel became visible
 *   parent -> frame   aariz:close        panel was hidden
 *   frame  -> parent  aariz:ready        handshake accepted
 *   frame  -> parent  aariz:answer       an answer finished arriving
 *   frame  -> parent  aariz:close        user closed the panel from inside
 *
 * Every outbound `postMessage` names the resolved parent origin explicitly.
 * `targetOrigin: '*'` appears nowhere: it would broadcast the message to
 * whatever document happens to occupy the parent frame, which on a page that
 * navigates between the handshake and the send is not necessarily the one that
 * was allowlisted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatComposer } from '@/components/chat-composer';
import { MessageBubble } from '@/components/message-bubble';
import { MessageSources } from '@/components/message-sources';
import { streamReply } from '@/lib/chat-transport';
import type { AnswerSource, ChatMessage, ChatStatus } from '@/types/chat';

/** Cap on the greeting a host page may set. Long enough for a sentence or two. */
const MAX_GREETING_LENGTH = 200;

const DEFAULT_GREETING = 'Hi! Ask me anything about the documents I have been given.';

interface EmbeddedChatProps {
  /**
   * Origins permitted to embed this frame, canonical and server-supplied.
   *
   * Already public in this response's `frame-ancestors` header, so passing it
   * to the browser discloses nothing new. It is the client half of the two-way
   * origin check.
   */
  allowedOrigins: string[];
  /**
   * True when this deployment performs no inference. Passed from the server
   * component for the same reason the first-party page does it: the browser
   * needs one boolean, not a published environment variable.
   */
  inferenceDisabled?: boolean;
}

interface HostMessage {
  type?: unknown;
  greeting?: unknown;
}

let messageCounter = 0;
const nextMessageId = (): string => `embed-${++messageCounter}`;

export function EmbeddedChat({ allowedOrigins, inferenceDisabled = false }: EmbeddedChatProps) {
  const [parentOrigin, setParentOrigin] = useState<string | null>(null);
  const [greeting, setGreeting] = useState(DEFAULT_GREETING);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Post to the parent, always to its exact origin. Never `'*'`. */
  const postToParent = useCallback(
    (payload: Record<string, unknown>) => {
      if (parentOrigin === null) return;
      window.parent.postMessage(payload, parentOrigin);
    },
    [parentOrigin],
  );

  // --- Handshake ----------------------------------------------------------
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // The origin check comes first and gates everything below it. An
      // unapproved sender is ignored in silence: replying — even to refuse —
      // would confirm to an arbitrary page that a widget frame is listening.
      if (!allowedOrigins.includes(event.origin)) return;

      // Only the window that actually contains this frame. Without this, any
      // popup or sibling frame served from an allowlisted origin could drive
      // the widget.
      if (event.source !== window.parent) return;

      const data = event.data as HostMessage;
      if (typeof data !== 'object' || data === null) return;

      if (data.type === 'aariz:host-hello') {
        if (typeof data.greeting === 'string' && data.greeting.trim().length > 0) {
          // Rendered as JSX text, which React escapes, and truncated so a host
          // page cannot push the composer off the panel with a wall of text.
          setGreeting(data.greeting.trim().slice(0, MAX_GREETING_LENGTH));
        }
        setParentOrigin(event.origin);
        // Answered directly rather than through `postToParent`, whose
        // `parentOrigin` is still null in this render.
        window.parent.postMessage({ type: 'aariz:ready' }, event.origin);
      }
    }

    window.addEventListener('message', onMessage);

    /**
     * Announce that this frame is listening.
     *
     * Without this the handshake is a race the parent cannot see: it posts
     * `host-hello` when the iframe fires `load`, which happens BEFORE React
     * hydrates and runs the effect above, so the message lands in a document
     * with no listener and is lost. Measured on the reference machine, a cold
     * production start took longer to hydrate than the parent's whole retry
     * window, and the widget silently never connected.
     *
     * The parent cannot know when hydration finishes; this side can, because
     * it IS hydration. So the frame speaks first and the parent answers.
     *
     * The target origin comes from `document.referrer` — the page that framed
     * us, set by the browser and not writable by that page's scripts — and is
     * checked against the allowlist before anything is sent, so this can never
     * announce the widget to an unapproved site. When the host suppresses the
     * referrer there is nothing to address, and the parent's retry covers it.
     */
    let refererOrigin: string | null = null;
    try {
      refererOrigin = document.referrer ? new URL(document.referrer).origin : null;
    } catch {
      refererOrigin = null;
    }
    if (refererOrigin !== null && allowedOrigins.includes(refererOrigin)) {
      window.parent.postMessage({ type: 'aariz:frame-ready' }, refererOrigin);
    }

    return () => window.removeEventListener('message', onMessage);
  }, [allowedOrigins]);

  // Keep the newest turn in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Stop any in-flight generation if the frame goes away mid-answer.
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    if (parentOrigin === null || status === 'streaming' || inferenceDisabled) return;

    setError(null);

    const userMessage: ChatMessage = {
      id: nextMessageId(),
      role: 'user',
      content: text,
      createdAt: Date.now(),
    };
    const assistantId = nextMessageId();

    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
    ]);
    setStatus('streaming');

    const controller = new AbortController();
    abortRef.current = controller;

    let sources: AnswerSource[] = [];

    try {
      for await (const chunk of streamReply({
        prompt: text,
        signal: controller.signal,
        // The server re-validates this against its own allowlist. Sending it
        // is what attributes the request to this site's budget rather than to
        // the shared anonymous one.
        widgetOrigin: parentOrigin,
      })) {
        if (chunk.type === 'delta') {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + chunk.text }
                : message,
            ),
          );
        } else if (chunk.type === 'sources') {
          sources = chunk.sources;
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, sources } : message,
            ),
          );
        }
        // `conversation` cannot arrive: the widget never asks to persist, and
        // the server refuses the request if it does.
      }

      setStatus('idle');
      // The parent owns the unread count, because only it knows whether the
      // panel is on screen. This just reports that something arrived.
      postToParent({ type: 'aariz:answer' });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') {
        // Deliberate stop. Whatever streamed stays on screen.
        setStatus('idle');
        return;
      }
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      abortRef.current = null;
    }
  }

  // Two different reasons the composer is unusable, kept distinct so the
  // visitor is told which one applies rather than a vague "unavailable".
  const blocked = parentOrigin === null || inferenceDisabled;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">AARIZ AI</span>
        <button
          type="button"
          onClick={() => postToParent({ type: 'aariz:close' })}
          aria-label="Close chat"
          className="rounded-lg px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          ×
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-4">
          {inferenceDisabled ? (
            <p className="text-sm text-amber-700 dark:text-amber-300">
              AI chat is currently unavailable on the public demo. Please run AARIZ AI locally to
              use Ollama-powered chat.
            </p>
          ) : blocked ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This chat is only available on approved websites.
            </p>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{greeting}</p>
          )}

          {messages.map((message, index) => (
            <div key={message.id} className="flex flex-col gap-2">
              <MessageBubble
                message={message}
                // Only the turn currently receiving tokens — the last one.
                // Keyed on position rather than on role, or every assistant
                // bubble in the transcript would blink at once.
                isStreaming={status === 'streaming' && index === messages.length - 1}
              />
              {message.role === 'assistant' && message.sources !== undefined && (
                <MessageSources sources={message.sources} />
              )}
            </div>
          ))}

          {error !== null && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
            >
              {error}
            </p>
          )}
        </div>
      </div>

      <div className={blocked ? 'pointer-events-none opacity-50' : undefined}>
        <ChatComposer
          onSubmit={(text) => void send(text)}
          onStop={() => abortRef.current?.abort()}
          isStreaming={status === 'streaming'}
        />
      </div>

      {/*
        The widget is anonymous and stateless, and says so rather than letting a
        visitor assume otherwise. It has no account, keeps no history, and can
        only see documents shared with everyone — see docs/DEPLOYMENT.md.
      */}
      <p className="shrink-0 border-t border-zinc-200 px-4 py-2 text-center text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Anonymous chat · this conversation is not saved
      </p>
    </div>
  );
}
