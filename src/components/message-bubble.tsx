import type { ChatMessage } from '@/types/chat';

interface MessageBubbleProps {
  message: ChatMessage;
  /** True while this specific message is still receiving tokens. */
  isStreaming?: boolean;
}

/**
 * A single chat turn. User messages sit on the right, assistant messages on
 * the left. `whitespace-pre-wrap` preserves the newlines a user creates with
 * Shift+Enter.
 */
export function MessageBubble({ message, isStreaming = false }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[85%] break-words rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[75%]',
          isUser
            ? 'rounded-br-sm bg-blue-600 text-white'
            : 'rounded-bl-sm bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
        ].join(' ')}
      >
        {message.content}
        {isStreaming && message.content.length > 0 && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-current"
          />
        )}
      </div>
    </div>
  );
}
