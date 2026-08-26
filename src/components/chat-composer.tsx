'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { ACCEPT_ATTRIBUTE } from '@/lib/documents-client';

/** Cap the auto-grow so a long draft can never swallow the message list. */
const MAX_TEXTAREA_HEIGHT_PX = 200;

interface ChatComposerProps {
  onSubmit: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  /**
   * Attach a document. Omitted entirely by the embedded widget, which has no
   * session to own an upload — so the button simply does not exist there
   * rather than appearing and failing.
   */
  onAttach?: (file: File) => void;
  /** True while an upload is extracting, chunking and embedding. */
  isUploading?: boolean;
  /**
   * Shown instead of opening the picker when the user cannot upload yet —
   * signed out, or a deployment with inference disabled. A disabled button
   * with no explanation is a dead end; this gives the reason.
   */
  attachDisabledReason?: string | null;
}

export function ChatComposer({
  onSubmit,
  onStop,
  isStreaming,
  onAttach,
  isUploading = false,
  attachDisabledReason = null,
}: ChatComposerProps) {
  const [value, setValue] = useState('');
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Grow with the content, up to a ceiling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (text.length === 0 || isStreaming) return;
    onSubmit(text);
    setValue('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a newline. `isComposing` guards IME
    // input, where Enter commits a candidate and must not send the message.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  const canSend = value.trim().length > 0 && !isStreaming;
  const showAttach = onAttach !== undefined;

  function openPicker(): void {
    if (attachDisabledReason !== null) {
      setAttachNotice(attachDisabledReason);
      return;
    }
    setAttachNotice(null);
    fileRef.current?.click();
  }

  return (
    <div className="border-t border-zinc-200 bg-white px-4 py-4 dark:border-zinc-800 dark:bg-zinc-950">
      {attachNotice !== null && (
        <p
          role="status"
          className="mx-auto mb-2 w-full max-w-3xl text-xs text-amber-700 dark:text-amber-400"
        >
          {attachNotice}
        </p>
      )}

      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>

        {showAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept={ACCEPT_ATTRIBUTE}
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Cleared so choosing the same file twice fires onChange again.
                event.target.value = '';
                if (file) onAttach?.(file);
              }}
            />
            <button
              type="button"
              onClick={openPicker}
              disabled={isUploading}
              aria-label={isUploading ? 'Uploading document' : 'Attach a document'}
              title={attachDisabledReason ?? 'Attach a document'}
              className="shrink-0 rounded-xl border border-zinc-300 bg-white p-3 text-zinc-600 transition hover:bg-zinc-100 focus:ring-2 focus:ring-blue-500/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {isUploading ? (
                <svg
                  className="h-5 w-5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : (
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>
          </>
        )}
        <textarea
          id="chat-input"
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask AARIZ AI anything…  (Enter to send, Shift+Enter for a newline)"
          className="flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />

        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            className="shrink-0 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-500/40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend}
            className="shrink-0 rounded-xl bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
