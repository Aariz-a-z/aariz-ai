/**
 * Browser-side conversation management (Level 12).
 *
 * Sits alongside `chat-transport.ts` rather than inside it: that module is
 * documented as talking to `/api/chat` and nothing else, and the chat list is a
 * different endpoint with a different shape. Keeping them apart means neither
 * file has to describe two protocols.
 *
 * No identity is sent from here. Ownership travels in the httpOnly session
 * cookie, which the browser attaches automatically and no page script can read.
 * There is deliberately no `sessionId` parameter anywhere in this file.
 */

import type { AnswerSource, Conversation } from '@/types/chat';

/** A turn as the server stores it. `sources` is null on user turns. */
export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources: AnswerSource[] | null;
  createdAt: string;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error.length > 0) return data.error;
  } catch {
    /* fall through */
  }
  return fallback;
}

export async function listConversations(signal?: AbortSignal): Promise<Conversation[]> {
  const response = await fetch('/api/conversations', {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await readError(response, 'Could not load your chats.'));

  const data = (await response.json()) as { conversations?: Conversation[] };
  return data.conversations ?? [];
}

/**
 * Load one conversation and its full history.
 *
 * Returns null on 404, which the server also uses for "not yours" — the client
 * cannot tell the difference and does not need to.
 */
export async function fetchConversation(
  id: string,
  signal?: AbortSignal,
): Promise<{ conversation: Conversation; messages: StoredMessage[] } | null> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    signal,
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await readError(response, 'Could not load that chat.'));

  return (await response.json()) as { conversation: Conversation; messages: StoredMessage[] };
}

export async function renameConversation(id: string, title: string): Promise<Conversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(await readError(response, 'Could not rename that chat.'));

  const data = (await response.json()) as { conversation: Conversation };
  return data.conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  // A 404 means it is already gone, which is the state the caller wanted.
  if (!response.ok && response.status !== 404) {
    throw new Error(await readError(response, 'Could not delete that chat.'));
  }
}
