/**
 * Conversation persistence (Level 12), owner-aware (Level 13).
 *
 * TWO OWNERSHIP MODELS, TWO ENFORCEMENT MECHANISMS
 * ------------------------------------------------
 * Every function takes an `Owner`, and the owner decides both which client runs
 * the query and what ultimately stops one user reading another's data:
 *
 *   anonymous      service-role client, which BYPASSES RLS. The boundary is the
 *                  `session_id = … AND user_id IS NULL` predicate below, pushed
 *                  into the query itself.
 *
 *   authenticated  a client carrying the user's verified JWT, so PostgREST runs
 *                  as `authenticated` and every Level 13 policy applies. The
 *                  boundary is RLS, in the database.
 *
 * The authenticated path ALSO filters on `user_id` in the query. That is not
 * the security boundary and must never be mistaken for one — RLS is. It is
 * defence in depth, so that a policy accidentally dropped in a future migration
 * does not silently turn into a data leak on the same day.
 *
 * Note `user_id IS NULL` on the anonymous path. Without it, a conversation
 * claimed by a user at sign-in would remain visible to anyone later holding
 * that browser's anonymous session cookie — including after sign-out.
 *
 * Ownership is filtered IN THE QUERY throughout, never fetched and then checked
 * in JavaScript: a fetch-then-check leaves a window for a later edit to use the
 * row on the failure path, and the mistake is invisible in review.
 *
 * Server-only.
 */

import { createAuthedClient } from './supabase/authed.ts';
import { getSupabaseAdminClient, type AppSupabaseClient } from './supabase/server.ts';
import type { AnswerSource } from '../types/chat.ts';
import type { ConversationRow, MessageRole, MessageRow } from '../types/database.ts';

/** Longest stored title. Matches the CHECK constraint in the migration. */
const MAX_TITLE_LENGTH = 200;

/** Characters of the first user message used to name a chat automatically. */
const DERIVED_TITLE_LENGTH = 60;

/**
 * Who a conversation belongs to.
 *
 * There is deliberately no way to construct an authenticated owner from a
 * request body: `userId` and `accessToken` come from `getServerUser()`, which
 * verifies the token with Supabase. See src/lib/auth.ts.
 */
export type Owner =
  | { kind: 'anonymous'; sessionId: string }
  | {
      kind: 'authenticated';
      userId: string;
      /** Verified access token, used to build the RLS-subject client. */
      accessToken: string;
      /** Retained for continuity; never used to scope an authenticated query. */
      sessionId: string;
    };

export type ConversationErrorCode = 'invalid_input' | 'storage_failed';

export class ConversationError extends Error {
  readonly code: ConversationErrorCode;

  constructor(code: ConversationErrorCode, message: string) {
    super(message);
    this.name = 'ConversationError';
    this.code = code;
  }
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/conversations.ts is server-only and must not be imported from a client component.',
    );
  }
}

/** Service role for anonymous work; an RLS-subject client for a signed-in user. */
function clientFor(owner: Owner): AppSupabaseClient {
  return owner.kind === 'authenticated'
    ? createAuthedClient(owner.accessToken)
    : getSupabaseAdminClient();
}

/** Row shape returned to the browser for the chat list. Never includes ownership. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  sources: AnswerSource[] | null;
  createdAt: string;
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStoredMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sources: row.sources,
    createdAt: row.created_at,
  };
}

/**
 * Turn the opening message into a usable chat name.
 *
 * Trimmed at a word boundary where one is close to the limit, so the sidebar
 * shows "How long are idempotency keys kept…" rather than a title cut through
 * the middle of a word.
 */
export function deriveTitle(firstUserMessage: string): string {
  const cleaned = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New chat';
  if (cleaned.length <= DERIVED_TITLE_LENGTH) return cleaned;

  const clipped = cleaned.slice(0, DERIVED_TITLE_LENGTH);
  const lastSpace = clipped.lastIndexOf(' ');
  const base = lastSpace > DERIVED_TITLE_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${base.trimEnd()}…`;
}

export function validateTitle(title: unknown): string {
  if (typeof title !== 'string') {
    throw new ConversationError('invalid_input', 'Title must be a string.');
  }
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new ConversationError('invalid_input', 'Title must not be empty.');
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ConversationError(
      'invalid_input',
      `Title must not exceed ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  return trimmed;
}

export async function createConversation(
  owner: Owner,
  title = 'New chat',
): Promise<ConversationSummary> {
  assertServerOnly();

  // `session_id` is NOT NULL in the schema and is kept for both owner kinds, so
  // an authenticated conversation still records the browser session it began
  // in. `user_id` is written from the server-verified identity only.
  const row = {
    session_id: owner.sessionId,
    title,
    ...(owner.kind === 'authenticated' ? { user_id: owner.userId } : {}),
  };

  const { data, error } = await clientFor(owner)
    .from('conversations')
    .insert(row)
    .select('*')
    .single();

  if (error || !data) {
    throw new ConversationError(
      'storage_failed',
      `Could not create conversation: ${error?.message ?? 'no row returned'}`,
    );
  }
  return toSummary(data);
}

export async function listConversations(owner: Owner): Promise<ConversationSummary[]> {
  assertServerOnly();

  const base = clientFor(owner).from('conversations').select('*');
  const scoped =
    owner.kind === 'authenticated'
      ? base.eq('user_id', owner.userId)
      : base.eq('session_id', owner.sessionId).is('user_id', null);

  const { data, error } = await scoped.order('updated_at', { ascending: false });

  if (error) {
    throw new ConversationError('storage_failed', `Could not list conversations: ${error.message}`);
  }
  return (data ?? []).map(toSummary);
}

/**
 * Fetch one conversation this owner may have.
 *
 * Null covers "no such conversation" and "belongs to someone else" alike. The
 * caller cannot tell them apart, and neither can the client — which is why the
 * API answers 404 rather than 403 in both cases.
 */
export async function getConversation(
  owner: Owner,
  conversationId: string,
): Promise<ConversationRow | null> {
  assertServerOnly();

  const base = clientFor(owner).from('conversations').select('*').eq('id', conversationId);
  const scoped =
    owner.kind === 'authenticated'
      ? base.eq('user_id', owner.userId)
      : base.eq('session_id', owner.sessionId).is('user_id', null);

  const { data, error } = await scoped.maybeSingle();

  if (error) {
    throw new ConversationError('storage_failed', `Could not read conversation: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Full history, oldest first. The caller has already established ownership of
 * the conversation, and for an authenticated owner the messages policies
 * independently confirm it.
 */
export async function getMessages(
  owner: Owner,
  conversationId: string,
): Promise<StoredMessage[]> {
  assertServerOnly();

  const { data, error } = await clientFor(owner)
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new ConversationError('storage_failed', `Could not read messages: ${error.message}`);
  }
  return (data ?? []).map(toStoredMessage);
}

export async function renameConversation(
  owner: Owner,
  conversationId: string,
  title: string,
): Promise<ConversationSummary | null> {
  assertServerOnly();

  const validated = validateTitle(title);
  const base = clientFor(owner)
    .from('conversations')
    .update({ title: validated })
    .eq('id', conversationId);
  const scoped =
    owner.kind === 'authenticated'
      ? base.eq('user_id', owner.userId)
      : base.eq('session_id', owner.sessionId).is('user_id', null);

  const { data, error } = await scoped.select('*').maybeSingle();

  if (error) {
    throw new ConversationError('storage_failed', `Could not rename conversation: ${error.message}`);
  }
  return data ? toSummary(data) : null;
}

/**
 * Delete a conversation and, by cascade, its messages.
 *
 * False means nothing was deleted — absent, or not this owner's.
 */
export async function deleteConversation(
  owner: Owner,
  conversationId: string,
): Promise<boolean> {
  assertServerOnly();

  const base = clientFor(owner).from('conversations').delete().eq('id', conversationId);
  const scoped =
    owner.kind === 'authenticated'
      ? base.eq('user_id', owner.userId)
      : base.eq('session_id', owner.sessionId).is('user_id', null);

  const { data, error } = await scoped.select('id');

  if (error) {
    throw new ConversationError('storage_failed', `Could not delete conversation: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function appendMessage(
  owner: Owner,
  conversationId: string,
  role: MessageRole,
  content: string,
  sources: AnswerSource[] | null = null,
): Promise<StoredMessage> {
  assertServerOnly();

  const { data, error } = await clientFor(owner)
    .from('messages')
    .insert({ conversation_id: conversationId, role, content, sources })
    .select('*')
    .single();

  if (error || !data) {
    throw new ConversationError(
      'storage_failed',
      `Could not store ${role} message: ${error?.message ?? 'no row returned'}`,
    );
  }
  return toStoredMessage(data);
}

/**
 * Move a conversation to the top of the list.
 *
 * The trigger sets `updated_at`; this only has to touch the row. Writing the
 * title back to itself would be a no-op update that PostgREST may skip, so an
 * explicit column is set instead.
 */
export async function touchConversation(owner: Owner, conversationId: string): Promise<void> {
  assertServerOnly();

  const { error } = await clientFor(owner)
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (error) {
    throw new ConversationError('storage_failed', `Could not touch conversation: ${error.message}`);
  }
}

/** Persist a summary of older turns together with the watermark it covers. */
export async function storeSummary(
  owner: Owner,
  conversationId: string,
  summary: string,
  summarisedThrough: string,
): Promise<void> {
  assertServerOnly();

  const { error } = await clientFor(owner)
    .from('conversations')
    .update({ summary, summarised_through: summarisedThrough })
    .eq('id', conversationId);

  if (error) {
    throw new ConversationError('storage_failed', `Could not store summary: ${error.message}`);
  }
}
