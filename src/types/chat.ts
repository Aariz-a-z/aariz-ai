/**
 * Shared chat types.
 *
 * Deliberately transport-agnostic: nothing here knows whether a reply comes
 * from Ollama, a cloud provider, or anything else. Roadmap Rule 8 requires that
 * boundary, so these types must stay free of provider details.
 *
 * This module is imported by both client components and server code, so it must
 * remain free of any server-only import.
 */

export type ChatRole = 'user' | 'assistant';

/**
 * A document behind an answer (Level 8).
 *
 * `index` is the citation number the model is asked to emit as `[n]`, so a
 * source can be matched to the bracketed marker in the answer text.
 */
export interface AnswerSource {
  index: number;
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  documentTitle: string;
  sourceUrl: string | null;
  /** Cosine similarity to the question, in [-1, 1]. Higher is closer. */
  similarity: number;
}

/**
 * A persisted chat (Level 12).
 *
 * Deliberately carries no owner field. Ownership lives server-side in the
 * session the httpOnly cookie names, and the browser is never told which
 * session it belongs to - there is nothing here for a client to spoof.
 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /**
   * Documents the answer was grounded in. Present on assistant messages once
   * retrieval has run; an empty array means nothing relevant was found.
   */
  sources?: AnswerSource[];
}

/**
 * `idle`      — nothing in flight; the composer accepts input.
 * `streaming` — a reply is arriving; the composer shows Stop.
 * `error`     — the last attempt failed; the error banner offers a retry.
 */
export type ChatStatus = 'idle' | 'streaming' | 'error';
