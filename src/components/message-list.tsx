'use client';

import { useEffect, useRef, useState } from 'react';

import { BrandMark } from '@/components/brand';
import { MessageBubble } from '@/components/message-bubble';
import { MessageSources } from '@/components/message-sources';
import type { ChatMessage, ChatStatus } from '@/types/chat';

/**
 * How close to the bottom counts as "following along". Anything further up is
 * treated as the user deliberately reading back, and auto-scroll stands down.
 */
const PIN_THRESHOLD_PX = 64;

/** Example prompts offered on the welcome screen. */
const SUGGESTIONS = [
  'What can AARIZ AI do?',
  'Summarise the key points of a document',
  'How does retrieval-augmented generation work?',
] as const;

interface MessageListProps {
  messages: ChatMessage[];
  status: ChatStatus;
  /** Which message is currently receiving tokens, if any. */
  streamingMessageId: string | null;
  /**
   * Incremented by the parent when the user sends a message. Sending is an
   * explicit action, so it always returns the view to the bottom even if the
   * user had scrolled up.
   */
  scrollAnchorKey: number;
  /** Invoked when an example prompt on the welcome screen is chosen. */
  onSuggestion: (text: string) => void;
}

export function MessageList({
  messages,
  status,
  streamingMessageId,
  scrollAnchorKey,
  onSuggestion,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinnedToBottom(distanceFromBottom <= PIN_THRESHOLD_PX);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    setPinnedToBottom(true);
    el.scrollTop = el.scrollHeight;
  }

  // Follow new tokens only while the user is already at the bottom. Scrolling
  // up during a stream must not be undone on the next token.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedToBottom || messages.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pinnedToBottom]);

  // The user just sent something — jump back down regardless of scroll position.
  useEffect(() => {
    if (scrollAnchorKey === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    setPinnedToBottom(true);
    el.scrollTop = el.scrollHeight;
  }, [scrollAnchorKey]);

  const streamingMessage = messages.find((m) => m.id === streamingMessageId);
  const awaitingFirstToken =
    status === 'streaming' && streamingMessage !== undefined && streamingMessage.content.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-6"
        aria-live="polite"
        aria-busy={status === 'streaming'}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {messages.length === 0 ? (
            <WelcomeHero onSuggestion={onSuggestion} />
          ) : (
            messages.map((message) => (
              <div key={message.id} className="flex flex-col gap-1.5">
                <MessageBubble
                  message={message}
                  isStreaming={message.id === streamingMessageId}
                />
                {message.role === 'assistant' && message.sources && message.sources.length > 0 && (
                  <MessageSources sources={message.sources} />
                )}
              </div>
            ))
          )}

          {awaitingFirstToken && <ThinkingIndicator />}
        </div>
      </div>

      {!pinnedToBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-zinc-200 bg-white px-4 py-2 text-xs font-medium text-zinc-700 shadow-lg transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

interface WelcomeHeroProps {
  onSuggestion: (text: string) => void;
}

/** The first thing a visitor sees. Branding plus a way in. */
function WelcomeHero({ onSuggestion }: WelcomeHeroProps) {
  return (
    <section className="relative mx-auto flex w-full max-w-2xl flex-col items-center px-2 py-10 text-center sm:py-16">
      {/* Soft brand glow. Purely decorative and low-contrast, so it never
          interferes with text legibility. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 mx-auto h-56 w-56 rounded-full bg-gradient-to-br from-indigo-400/20 via-violet-400/20 to-fuchsia-400/20 blur-3xl dark:from-indigo-500/20 dark:via-violet-500/20 dark:to-fuchsia-500/20"
      />

      <BrandMark className="animate-rise h-14 w-14 sm:h-16 sm:w-16" />

      <h2 className="animate-rise-delay-1 mt-6 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 bg-clip-text text-2xl font-bold uppercase tracking-[0.14em] text-transparent sm:text-3xl dark:from-indigo-300 dark:via-violet-300 dark:to-fuchsia-300">
        Welcome to AARIZ AI
      </h2>

      <p className="animate-rise-delay-1 mt-4 max-w-md text-balance text-base leading-relaxed text-zinc-600 sm:text-lg dark:text-zinc-300">
        Your intelligent assistant for exploring your documents.
      </p>

      <ul className="animate-rise-delay-2 mt-8 flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion} className="sm:w-auto">
            <button
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 sm:w-auto sm:text-center dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>

      <p className="animate-rise-delay-2 mt-8 text-xs text-zinc-500 dark:text-zinc-400">
        Enter sends · Shift+Enter adds a newline
      </p>

      <p className="animate-rise-delay-2 mt-4 max-w-md text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
        Answers are generated by an open-source model running on this machine — nothing is
        sent to a cloud AI service. Answering from your own documents arrives in a later stage.
      </p>
    </section>
  );
}

/** Shown between "request sent" and "first token arrived". */
function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-zinc-100 px-4 py-4 dark:bg-zinc-800">
        <span className="sr-only">AARIZ AI is generating a reply</span>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            aria-hidden="true"
            className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
