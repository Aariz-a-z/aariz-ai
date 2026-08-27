'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AuthPanel } from '@/components/auth-panel';
import { BrandMark, Wordmark } from '@/components/brand';
import { ChatComposer } from '@/components/chat-composer';
import { ConversationSidebar } from '@/components/conversation-sidebar';
import { DocumentPanel } from '@/components/document-panel';
import { ErrorBanner } from '@/components/error-banner';
import { MessageList } from '@/components/message-list';
import { fetchAuthState, type AuthState } from '@/lib/auth-client';
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  describeSupportedFormats,
  listDocuments as listDocumentsRequest,
  uploadDocument,
  type UserDocument,
} from '@/lib/documents-client';
import { LEGACY_BINARY_FORMATS, fileExtension } from '@/lib/ingest/formats';
import { streamReply } from '@/lib/chat-transport';
import {
  deleteConversation as deleteConversationRequest,
  fetchConversation,
  listConversations,
  renameConversation as renameConversationRequest,
} from '@/lib/conversations-client';
import type { ChatMessage, ChatStatus, Conversation } from '@/types/chat';

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A deliberate Stop, as opposed to a genuine failure. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Owns all chat state. This is the only component that knows a transport
 * exists; everything below it receives plain props.
 *
 * The seam held twice: Level 3 replaced the placeholder `streamReply` with a
 * real `/api/chat` call, and Level 12 added persistence, without either change
 * reaching the presentational components below. It still has no idea which
 * provider or model answers — that is server-side configuration.
 */
interface ChatProps {
  /**
   * True when this deployment performs no inference (docs/DEPLOYMENT.md Mode
   * A3). Supplied by the server component, never read from the environment
   * here — a client component cannot see server-only configuration, and it
   * should not need to.
   */
  inferenceDisabled?: boolean;
}

export function Chat({ inferenceDisabled = false }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [scrollAnchorKey, setScrollAnchorKey] = useState(0);

  // --- Level 12 conversation state -----------------------------------------
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  // --- Level 13 authentication state ---------------------------------------
  const [authState, setAuthState] = useState<AuthState>({
    configured: false,
    authenticated: false,
    email: null,
  });
  /** Bumped after any sign-in, sign-out, upload or delete, to re-run restore. */
  const [reloadKey, setReloadKey] = useState(0);

  /** The signed-in user's uploads. Null while anonymous — there is no library. */
  const [documents, setDocuments] = useState<UserDocument[] | null>(null);
  const [isUploading, setUploading] = useState(false);
  /** Transient confirmation that a document finished indexing. */
  /**
   * The upload's own status, kept apart from the chat's.
   *
   * These used to share `error` and `status`, so a rejected spreadsheet put the
   * CHAT into an error state and the user was told "Could not generate a reply"
   * about a file they had just attached. An upload failing says nothing about
   * whether the model can answer, and the two should never have been the same
   * state.
   */
  const [upload, setUpload] = useState<{
    kind: 'working' | 'done' | 'error';
    message: string;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastPromptRef = useRef<string>('');
  /**
   * Mirrors `activeId` for use inside `runStream`.
   *
   * `runStream` is memoised with no dependencies so that the composer does not
   * re-render on every keystroke of state it does not use; reading the id from
   * a ref keeps it current without putting it in the dependency list and
   * rebuilding the callback on every chat switch.
   */
  const activeIdRef = useRef<string | null>(null);

  const selectConversation = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  /**
   * Restore state on load — this is the Level 12 "Done when".
   *
   * Nothing is read from browser storage. The chat list comes from the server,
   * scoped to the httpOnly session cookie, and the most recently updated chat
   * is reopened. A refresh therefore recovers the conversation from the
   * database rather than from anything the page kept.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        // Who am I? Determines which chats the list below will contain: an
        // account's, or this browser session's.
        setAuthState(await fetchAuthState(controller.signal));

        // Returns null for an anonymous caller, which is how the panel knows
        // to stay hidden rather than showing an empty library.
        setDocuments(await listDocumentsRequest(controller.signal));

        const list = await listConversations(controller.signal);
        if (controller.signal.aborted) return;
        setConversations(list);

        const mostRecent = list[0];
        if (mostRecent === undefined) return;

        const loaded = await fetchConversation(mostRecent.id, controller.signal);
        if (controller.signal.aborted || loaded === null) return;

        selectConversation(loaded.conversation.id);
        setMessages(
          loaded.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: Date.parse(message.createdAt),
            // Citations are stored with the answer, so a refreshed page shows
            // the same sources beneath the same text.
            ...(message.sources ? { sources: message.sources } : {}),
          })),
        );
        setScrollAnchorKey((key) => key + 1);
      } catch {
        // A failure to restore is not a failure of the chat: the composer still
        // works and a new message starts a new conversation. Showing an error
        // banner for it would be alarming out of proportion.
      }
    })();

    return () => controller.abort();
  }, [selectConversation, reloadKey]);

  /**
   * Re-read everything after the session changes.
   *
   * The on-screen chat is cleared first because it belonged to the previous
   * identity — leaving it visible after a sign-out would show one person's
   * conversation to whoever signs in next on this browser.
   */
  const handleAuthChanged = useCallback(() => {
    abortRef.current?.abort();
    selectConversation(null);
    setMessages([]);
    setConversations([]);
    setStatus('idle');
    setError(null);
    setReloadKey((key) => key + 1);
  }, [selectConversation]);

  const runStream = useCallback(async (prompt: string) => {
    const assistantId = createId();

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() },
    ]);
    setStreamingMessageId(assistantId);
    setStatus('streaming');
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    const existingId = activeIdRef.current;

    try {
      for await (const event of streamReply({
        prompt,
        signal: controller.signal,
        ...(existingId !== null
          ? { conversationId: existingId }
          : { startConversation: true }),
      })) {
        if (event.type === 'conversation') {
          // Adopt the id immediately, before any text arrives, so a refresh
          // mid-answer still finds the conversation.
          selectConversation(event.id);
          setConversations((prev) =>
            prev.some((c) => c.id === event.id)
              ? prev
              : [
                  {
                    id: event.id,
                    title: event.title,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                  ...prev,
                ],
          );
          continue;
        }

        setMessages((prev) =>
          prev.map((message) => {
            if (message.id !== assistantId) return message;
            // Sources arrive once, before the text; deltas append.
            return event.type === 'delta'
              ? { ...message, content: message.content + event.text }
              : { ...message, sources: event.sources };
          }),
        );
      }
      setStatus('idle');
    } catch (caught) {
      if (isAbortError(caught)) {
        // The user pressed Stop. Keep whatever text already arrived.
        setStatus('idle');
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : 'An unknown error occurred while generating a reply.',
        );
        setStatus('error');
        // Remove the placeholder bubble if it never received any content,
        // so a failure does not leave an empty message behind.
        setMessages((prev) =>
          prev.filter((message) => !(message.id === assistantId && message.content.length === 0)),
        );
      }
    } finally {
      abortRef.current = null;
      setStreamingMessageId(null);
    }
  }, [selectConversation]);

  const handleSubmit = useCallback(
    (text: string) => {
      lastPromptRef.current = text;
      setMessages((prev) => [
        ...prev,
        { id: createId(), role: 'user', content: text, createdAt: Date.now() },
      ]);
      setScrollAnchorKey((key) => key + 1);
      void runStream(text);
    },
    [runStream],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleRetry = useCallback(() => {
    if (lastPromptRef.current.length === 0) return;
    void runStream(lastPromptRef.current);
  }, [runStream]);

  const handleDismissError = useCallback(() => {
    setError(null);
    setStatus('idle');
  }, []);

  // --- Conversation actions -------------------------------------------------

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    selectConversation(null);
    setMessages([]);
    setStatus('idle');
    setError(null);
    setSidebarOpen(false);
  }, [selectConversation]);

  const handleSelect = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) {
        setSidebarOpen(false);
        return;
      }
      abortRef.current?.abort();
      setSidebarOpen(false);

      void (async () => {
        try {
          const loaded = await fetchConversation(id);
          if (loaded === null) {
            // Gone, or never ours. Drop it from the list rather than leaving a
            // row that fails every time it is clicked.
            setConversations((prev) => prev.filter((c) => c.id !== id));
            return;
          }
          selectConversation(loaded.conversation.id);
          setMessages(
            loaded.messages.map((message) => ({
              id: message.id,
              role: message.role,
              content: message.content,
              createdAt: Date.parse(message.createdAt),
              ...(message.sources ? { sources: message.sources } : {}),
            })),
          );
          setStatus('idle');
          setError(null);
          setScrollAnchorKey((key) => key + 1);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Could not open that chat.');
          setStatus('error');
        }
      })();
    },
    [selectConversation],
  );

  const handleRename = useCallback((id: string, title: string) => {
    // Optimistic: the sidebar already shows the new name, so a round trip
    // before updating would make renaming feel broken on a slow connection.
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));

    void (async () => {
      try {
        const updated = await renameConversationRequest(id, title);
        setConversations((prev) => prev.map((c) => (c.id === id ? updated : c)));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not rename that chat.');
        setStatus('error');
      }
    })();
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeIdRef.current) {
        abortRef.current?.abort();
        selectConversation(null);
        setMessages([]);
      }

      void (async () => {
        try {
          await deleteConversationRequest(id);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Could not delete that chat.');
          setStatus('error');
        }
      })();
    },
    [selectConversation],
  );

  /**
   * Attach a document from the composer.
   *
   * Deliberately the SAME `uploadDocument` the sidebar panel calls, not a
   * parallel implementation — one upload path means one place where auth,
   * size limits and error handling can be got right, and the panel's list
   * refreshes from the same `reloadKey` afterwards.
   *
   * Size is checked here as well as on the server. The server check is the
   * real one; this exists so a 12 MB file fails instantly instead of after a
   * long upload that was always going to be refused.
   */
  const handleAttach = useCallback((file: File) => {
    /**
     * Both pre-flight checks exist so an obviously doomed upload fails
     * instantly rather than after the file has been sent. The SERVER performs
     * both again and its answer is the authoritative one — this is a courtesy,
     * never the control.
     */
    const extension = fileExtension(file.name);
    if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
      setUpload({
        kind: 'error',
        message:
          LEGACY_BINARY_FORMATS[extension] ??
          `${extension || 'That file'} is not a supported format. ${describeSupportedFormats()}`,
      });
      return;
    }

    if (file.size === 0) {
      setUpload({ kind: 'error', message: `"${file.name}" is empty.` });
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setUpload({
        kind: 'error',
        message: `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      });
      return;
    }

    setUploading(true);
    // Names the slow part rather than saying "uploading": sending the bytes is
    // near-instant on a 10 MB cap, and the wait the user is actually sitting
    // through is extraction and one embedding call per chunk.
    setUpload({ kind: 'working', message: `Reading "${file.name}" and indexing its contents…` });

    void uploadDocument(file)
      .then((document) => {
        // "Indexed" rather than "uploaded": the request only returns once
        // extraction, chunking and embedding have finished, so by this point
        // the document really is searchable.
        setUpload({
          kind: 'done',
          message: `"${document.title}" is indexed — ${document.chunkCount} passage${document.chunkCount === 1 ? '' : 's'} ready to ask about.`,
        });
        setReloadKey((key) => key + 1);
      })
      .catch((caught: unknown) => {
        /**
         * The server's message is shown verbatim, and that is the point of the
         * whole change. It already names the stage that failed — "Not a valid
         * .xlsx workbook", "The file is not valid JSON: ...", "has no text
         * layer. It is most likely a scan" — so replacing it with wording of
         * our own could only make it vaguer.
         */
        setUpload({
          kind: 'error',
          message: caught instanceof Error ? caught.message : 'Could not upload that file.',
        });
      })
      .finally(() => setUploading(false));
  }, []);

  /**
   * Why the attach button cannot be used, or null when it can.
   *
   * Upload is owner-scoped: a document belongs to an account, so there is
   * nothing to attach it to when signed out. Saying that is far better than a
   * greyed-out button with no explanation.
   */
  const attachDisabledReason =
    inferenceDisabled
      ? 'Document upload is unavailable on the public demo. Run AARIZ AI locally to index your own files.'
      : !authState.authenticated
        ? 'Sign in to upload documents — they are stored against your account and only you can search them.'
        : null;

  return (
    <div className="flex h-full bg-white dark:bg-zinc-950">
      <ConversationSidebar
        conversations={conversations}
        activeId={activeId}
        isOpen={isSidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelect={handleSelect}
        onRename={handleRename}
        onDelete={handleDelete}
        documents={
          documents === null ? null : (
            <DocumentPanel documents={documents} onChanged={() => setReloadKey((key) => key + 1)} />
          )
        }
        footer={<AuthPanel state={authState} onChanged={handleAuthChanged} />}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/85 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-950/85">
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open chat list"
                className="-ml-1 rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
                </svg>
              </button>
              <BrandMark className="h-8 w-8" />
              <h1 className="truncate text-base text-zinc-900 dark:text-zinc-50">
                <Wordmark />
              </h1>
            </div>

            {/* Honest status. Deliberately names no model or URL — that is
                server-only configuration and must not reach the browser. */}
            <span
              className={
                inferenceDisabled
                  ? 'shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300'
                  : 'shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300'
              }
            >
              <span className="hidden sm:inline">
                {inferenceDisabled ? 'Chat unavailable on this demo' : 'Running on a local model'}
              </span>
              <span className="sm:hidden">{inferenceDisabled ? 'Demo' : 'Local'}</span>
            </span>
          </div>
        </header>

        <MessageList
          messages={messages}
          status={status}
          streamingMessageId={streamingMessageId}
          scrollAnchorKey={scrollAnchorKey}
          onSuggestion={handleSubmit}
        />

        {status === 'error' && error !== null && (
          <ErrorBanner message={error} onRetry={handleRetry} onDismiss={handleDismissError} />
        )}

        {/*
          Stated once, plainly, and never dressed up. The composer below is
          disabled rather than left to fail on submit: an input that accepts
          text and then refuses it wastes the visitor's effort and reads as a
          bug. No fabricated answer is ever produced — the roadmap's whole
          premise is grounded output, and inventing one to fill a demo would
          discard that.
        */}
        {inferenceDisabled && (
          <div
            role="status"
            className="mx-auto w-full max-w-3xl px-4 pb-2"
          >
            <p className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
              AI chat is currently unavailable on the public demo. Please run AARIZ AI locally to
              use Ollama-powered chat.
            </p>
          </div>
        )}

        {upload !== null && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <p
              // Progress is announced politely; a failure interrupts, because a
              // screen-reader user who just attached a file needs to know it
              // was refused rather than discover it in the silence afterwards.
              role={upload.kind === 'error' ? 'alert' : 'status'}
              className={
                'flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ' +
                (upload.kind === 'error'
                  ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200'
                  : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200')
              }
            >
              <span className="flex items-start gap-2">
                {upload.kind === 'working' && (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent dark:border-emerald-400 dark:border-t-transparent"
                  />
                )}
                <span>{upload.message}</span>
              </span>
              {/* A spinner with a dismiss button implies the work can be
                  cancelled, which it cannot — so it only appears once the
                  upload has finished one way or the other. */}
              {upload.kind !== 'working' && (
                <button
                  type="button"
                  onClick={() => setUpload(null)}
                  aria-label="Dismiss"
                  className="shrink-0 opacity-70 hover:opacity-100"
                >
                  ×
                </button>
              )}
            </p>
          </div>
        )}

        <div className={inferenceDisabled ? 'pointer-events-none opacity-50' : undefined}>
          <ChatComposer
            onSubmit={handleSubmit}
            onStop={handleStop}
            isStreaming={status === 'streaming'}
            onAttach={handleAttach}
            isUploading={isUploading}
            attachDisabledReason={attachDisabledReason}
          />
        </div>
      </div>
    </div>
  );
}
