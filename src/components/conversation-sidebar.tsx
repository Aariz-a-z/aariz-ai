'use client';

/**
 * The chat list (Level 12).
 *
 * Covers four of the five things ROADMAP.md Level 12 asks a user to be able to
 * do: create, rename, delete and continue a chat. The fifth — surviving a
 * refresh — is a property of the server, not of this component.
 *
 * Presentational: it owns only the transient state of its own rename box. Every
 * conversation mutation is handed upward, so there is exactly one place that
 * knows how chat state changes.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { Conversation } from '@/types/chat';

export interface ConversationSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /**
   * Rendered in the footer. Authentication lives here as a slot rather than as
   * props, so this component stays presentational and knows nothing about
   * sessions or accounts.
   */
  footer?: ReactNode;
  /** Rendered between the chat list and the footer. Holds the document library. */
  documents?: ReactNode;
}

export function ConversationSidebar({
  conversations,
  activeId,
  isOpen,
  onClose,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  footer,
  documents,
}: ConversationSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId !== null) inputRef.current?.select();
  }, [renamingId]);

  const beginRename = (conversation: Conversation): void => {
    setRenamingId(conversation.id);
    setDraftTitle(conversation.title);
  };

  const commitRename = (): void => {
    if (renamingId === null) return;
    const trimmed = draftTitle.trim();
    const original = conversations.find((c) => c.id === renamingId)?.title;
    // Only call up when the title actually changed, so a stray blur is not a write.
    if (trimmed.length > 0 && trimmed !== original) onRename(renamingId, trimmed);
    setRenamingId(null);
  };

  return (
    <>
      {/* Scrim: on small screens the sidebar overlays the conversation. */}
      {isOpen && (
        <button
          type="button"
          aria-label="Close chat list"
          onClick={onClose}
          className="fixed inset-0 z-20 bg-zinc-900/40 md:hidden"
        />
      )}

      <aside
        aria-label="Your chats"
        className={`${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        } fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-zinc-200 bg-zinc-50 transition-transform duration-200 ease-out md:relative md:z-0 md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900`}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={onNewChat}
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
          >
            New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat list"
            className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-200 md:hidden dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No saved chats yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {conversations.map((conversation) => {
                const isActive = conversation.id === activeId;
                return (
                  <li key={conversation.id}>
                    {renamingId === conversation.id ? (
                      <input
                        ref={inputRef}
                        value={draftTitle}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename();
                          if (event.key === 'Escape') setRenamingId(null);
                        }}
                        maxLength={200}
                        aria-label="Chat name"
                        className="w-full rounded-lg border border-emerald-400 bg-white px-3 py-2 text-sm text-zinc-900 focus-visible:outline-none dark:bg-zinc-950 dark:text-zinc-50"
                      />
                    ) : (
                      <div
                        className={`group flex items-center gap-1 rounded-lg px-1 ${
                          isActive
                            ? 'bg-emerald-100 dark:bg-emerald-950/50'
                            : 'hover:bg-zinc-200/70 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(conversation.id)}
                          aria-current={isActive ? 'true' : undefined}
                          className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm text-zinc-800 focus-visible:outline-none dark:text-zinc-100"
                          title={conversation.title}
                        >
                          {conversation.title}
                        </button>

                        <button
                          type="button"
                          onClick={() => beginRename(conversation)}
                          aria-label={`Rename ${conversation.title}`}
                          className="rounded p-1.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                        >
                          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M13 3l4 4-9 9H4v-4z" strokeLinejoin="round" />
                          </svg>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDelete(conversation.id)}
                          aria-label={`Delete ${conversation.title}`}
                          className="rounded p-1.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                        >
                          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {documents}

        {footer ?? (
          <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            Chats are saved to this browser.
          </p>
        )}
      </aside>
    </>
  );
}
