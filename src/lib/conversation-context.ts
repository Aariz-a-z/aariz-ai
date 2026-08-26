/**
 * Level 12 — the context strategy.
 *
 * ROADMAP.md Level 12: "Do not send unlimited conversation history to the LLM.
 * Implement a context strategy. Use recent messages plus summarized older
 * history when necessary."
 *
 * WHY A BUDGET IS NOT OPTIONAL HERE
 * ---------------------------------
 * This is the level that gives the chatbot multi-turn memory at all — until
 * now `/api/chat` answered every message in isolation. Unbounded history would
 * therefore not merely be untidy, it would be a latency cliff that grows with
 * the conversation: Level 2 measured prompt processing on this machine falling
 * from 115 tok/s to 38 tok/s at around 1000 tokens, and Level 11 measured mean
 * answer latency already at 38.8 s with single-turn prompts. A conversation
 * that appends without limit gets slower every turn until it is unusable.
 *
 *     [ system prompt ]                          Level 3 + Level 8, unchanged
 *     [ summary of older turns ]                 only once the budget overflows
 *     [ recent turns, verbatim ]                 bounded by count AND characters
 *     [ retrieved documents + question ]         Level 8/9/10, unchanged
 *
 * The summary is computed once and stored with a watermark, so a long
 * conversation costs one summarisation when a turn falls out of the recent
 * window — not one on every request.
 *
 * FAIL-OPEN, for the same reason reranking is
 * -------------------------------------------
 * Summarisation is a model call and model calls fail. If one does, the older
 * history is DROPPED rather than sent in full: the roadmap's instruction is not
 * to send unlimited history, so falling back to "send everything" would break
 * the requirement precisely when the conversation is longest. The recent window
 * always survives, so the chat keeps working.
 */

import { log } from './log.ts';
import type { LlmMessage, LlmProvider } from './llm/types.ts';
import type { StoredMessage } from './conversations.ts';
import type { ConversationRow } from '../types/database.ts';

/**
 * Verbatim turns kept at the end of the conversation.
 *
 * Ten is five exchanges, which covers the referential range of ordinary
 * follow-ups ("what about the other one?") without dominating the prompt.
 */
const DEFAULT_MAX_TURNS = 10;

/**
 * Character ceiling on those verbatim turns.
 *
 * Applied together with the turn count, and the tighter of the two wins: ten
 * short turns and ten long ones are very different prompts, so bounding only
 * the count would not actually bound the cost.
 */
const DEFAULT_MAX_HISTORY_CHARS = 4_000;

/**
 * Ceiling on the text handed to the summariser.
 *
 * The summariser is itself a model call, so it needs its own bound — otherwise
 * the work avoided in the answer prompt reappears in the summarisation prompt.
 * The oldest turns are dropped first, since they are the least likely to matter.
 */
const DEFAULT_SUMMARY_INPUT_CHARS = 6_000;

export interface ConversationContextConfig {
  maxTurns: number;
  maxHistoryChars: number;
  summaryInputChars: number;
}

export type ConversationContextErrorCode = 'invalid_configuration';

export class ConversationContextError extends Error {
  readonly code: ConversationContextErrorCode;

  constructor(code: ConversationContextErrorCode, message: string) {
    super(message);
    this.name = 'ConversationContextError';
    this.code = code;
  }
}

function readNumericEnv(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new ConversationContextError(
      'invalid_configuration',
      `${name} must be a number >= ${minimum}, received "${raw}".`,
    );
  }
  return parsed;
}

/** The effective context parameters. Single source of truth. */
export function getConversationContextConfig(): ConversationContextConfig {
  return {
    maxTurns: readNumericEnv('CONVERSATION_MAX_TURNS', DEFAULT_MAX_TURNS, 1),
    maxHistoryChars: readNumericEnv('CONVERSATION_MAX_HISTORY_CHARS', DEFAULT_MAX_HISTORY_CHARS, 200),
    summaryInputChars: readNumericEnv('CONVERSATION_SUMMARY_INPUT_CHARS', DEFAULT_SUMMARY_INPUT_CHARS, 200),
  };
}

/** Produces a compact summary of older turns. Injectable so tests can drive it. */
export type Summariser = (text: string, signal?: AbortSignal) => Promise<string>;

const defaultResolveProvider = async (): Promise<LlmProvider> => {
  const { getLlmProvider } = await import('./llm.ts');
  return getLlmProvider();
};

/**
 * Summarise with the configured provider.
 *
 * Goes through `LlmProvider` rather than touching Ollama, so Rule 8's provider
 * boundary holds here as everywhere else. The prompt forbids inventing detail,
 * because a summary that adds facts would poison every later turn — and unlike
 * a wrong answer, nobody would ever see it.
 */
export function createProviderSummariser(
  resolveProvider: () => Promise<LlmProvider> = defaultResolveProvider,
): Summariser {
  return async (text, signal) => {
    const provider = await resolveProvider();
    return provider.generate({
      messages: [
        {
          role: 'user',
          content: [
            'Summarise the earlier part of this conversation in at most six short sentences.',
            'Record only what was actually said: the topics raised, the questions asked and the answers given.',
            'Do not add facts, do not speculate, and do not answer anything.',
            '',
            'CONVERSATION:',
            text,
            '',
            'SUMMARY:',
          ].join('\n'),
        },
      ],
      signal,
      temperature: 0,
      maxTokens: 220,
    });
  };
}

export interface ConversationContext {
  /** History to place between the system prompt and the grounded question. */
  messages: LlmMessage[];
  /** How many turns were included verbatim. */
  recentTurns: number;
  /** How many older turns the summary stands in for. */
  summarisedTurns: number;
  /** A summary that should be persisted, with the watermark it covers. */
  summaryToStore: { summary: string; summarisedThrough: string } | null;
  /** True when older turns existed but could not be summarised, and were dropped. */
  droppedOlder: boolean;
}

/**
 * Split history into a bounded recent window plus everything older.
 *
 * Walks backwards from the newest turn so the window is always the most recent
 * turns, and stops at whichever limit binds first.
 */
function splitHistory(
  messages: StoredMessage[],
  config: ConversationContextConfig,
): { older: StoredMessage[]; recent: StoredMessage[] } {
  const recent: StoredMessage[] = [];
  let chars = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (recent.length >= config.maxTurns) break;
    if (recent.length > 0 && chars + message.content.length > config.maxHistoryChars) break;

    recent.unshift(message);
    chars += message.content.length;
  }

  return { older: messages.slice(0, messages.length - recent.length), recent };
}

function renderTurns(messages: StoredMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n');
}

/**
 * Build the bounded conversation context for a request.
 *
 * `history` must be the stored turns oldest-first and must NOT include the
 * message currently being answered — that arrives already grounded from the
 * Level 8 layer.
 */
export async function buildConversationContext(
  conversation: Pick<ConversationRow, 'summary' | 'summarised_through'>,
  history: StoredMessage[],
  options: {
    config?: ConversationContextConfig;
    summariser?: Summariser;
    signal?: AbortSignal;
  } = {},
): Promise<ConversationContext> {
  const config = options.config ?? getConversationContextConfig();
  const { older, recent } = splitHistory(history, config);

  const recentMessages: LlmMessage[] = recent.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (older.length === 0) {
    return {
      messages: recentMessages,
      recentTurns: recent.length,
      summarisedTurns: 0,
      summaryToStore: null,
      droppedOlder: false,
    };
  }

  const watermark = older[older.length - 1]!.createdAt;

  // Reuse the stored summary when it already reaches at least as far as the
  // turns now falling outside the window. This is what keeps a long
  // conversation from paying for a summarisation on every single request.
  const storedReaches =
    conversation.summary !== null &&
    conversation.summarised_through !== null &&
    Date.parse(conversation.summarised_through) >= Date.parse(watermark);

  if (storedReaches) {
    return {
      messages: [summaryMessage(conversation.summary!), ...recentMessages],
      recentTurns: recent.length,
      summarisedTurns: older.length,
      summaryToStore: null,
      droppedOlder: false,
    };
  }

  // The summariser's own input is bounded; oldest turns go first.
  let text = renderTurns(older);
  if (text.length > config.summaryInputChars) {
    text = text.slice(text.length - config.summaryInputChars);
  }

  const summariser = options.summariser ?? createProviderSummariser();
  try {
    const summary = (await summariser(text, options.signal)).trim();
    if (summary.length === 0) throw new Error('summariser returned nothing');

    return {
      messages: [summaryMessage(summary), ...recentMessages],
      recentTurns: recent.length,
      summarisedTurns: older.length,
      summaryToStore: { summary, summarisedThrough: watermark },
      droppedOlder: false,
    };
  } catch (caught) {
    // Drop rather than send in full — see the fail-open note in the header.
    log.warn('conversation.summarisation_failed', {
      error: caught instanceof Error ? caught.message : String(caught),
      outcome: 'recent window only',
    });
    return {
      messages: recentMessages,
      recentTurns: recent.length,
      summarisedTurns: 0,
      summaryToStore: null,
      droppedOlder: true,
    };
  }
}

/**
 * The summary as a labelled data turn.
 *
 * Placed in the user channel, never the system one, for the reason Level 8
 * established: the system turn carries instructions, everything else is data.
 * The label tells the model this is background rather than a new question.
 */
function summaryMessage(summary: string): LlmMessage {
  return {
    role: 'user',
    content: [
      'SUMMARY OF EARLIER TURNS IN THIS CONVERSATION (background only — it is not a question and needs no answer):',
      summary,
    ].join('\n'),
  };
}

/**
 * Splice conversation history between the system prompt and the grounded turn.
 *
 * `grounded` comes from Level 8's `prepareGroundedTurn` as [system, question].
 * Inserting here rather than inside `src/lib/rag.ts` keeps the Level 8 grounding
 * module untouched: it still knows only about documents and questions, and has
 * no idea conversations exist.
 */
export function withConversationHistory(
  grounded: LlmMessage[],
  history: LlmMessage[],
): LlmMessage[] {
  if (history.length === 0) return grounded;

  const systemIndex = grounded.findIndex((message) => message.role === 'system');
  if (systemIndex === -1) return [...history, ...grounded];

  return [
    ...grounded.slice(0, systemIndex + 1),
    ...history,
    ...grounded.slice(systemIndex + 1),
  ];
}
