/**
 * Level 16 — minimal structured logging.
 *
 * DELIBERATELY SMALL
 * ------------------
 * ROADMAP.md Level 16 asks for "logging". Level 18 asks for *structured*
 * logging with a specific field list — request id, user id, conversation id,
 * retrieval/embedding/generation latency, chunk counts, model name, token
 * counts — plus an `/admin` dashboard to read it.
 *
 * This file established the SHAPE so Level 18 had something to populate.
 *
 * Level 18 has since populated it: the field list lives at the call sites that
 * can actually measure it — `src/app/api/chat/route.ts` for request-scoped
 * fields, `src/lib/retrieval.ts` for the embedding/search split — rather than
 * in a schema here, because a logger that defines its own vocabulary quickly
 * disagrees with what the code can supply. The one change Level 18 made to
 * this file is `METRIC_FIELDS` below.
 *
 * WHAT IT REPLACES
 * ----------------
 * Sixteen ad-hoc `console.error`/`console.warn` calls with hand-written string
 * prefixes. Those were readable by a person tailing a terminal and useless to
 * anything else: no correlation between the lines belonging to one request, and
 * no machine-readable structure.
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 * Log a secret, a token, a password, a system prompt, or a raw environment
 * value. `redact()` below is a backstop, not a licence to pass sensitive
 * fields: the call sites are expected not to hand them over in the first place.
 */

export type LogLevel = 'info' | 'warn' | 'error';

/** Context attached to a log line. Keep values small and non-sensitive. */
export type LogFields = Record<string, unknown>;

/**
 * Field names whose values are replaced before output.
 *
 * A safety net for a future call site that passes something it should not.
 * Matched case-insensitively on a substring, so `accessToken`,
 * `SUPABASE_SERVICE_ROLE_KEY` and `user_password` are all caught.
 */
const SENSITIVE = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'cookie',
  'credential',
  'prompt',
];

/**
 * Level 18 — field names that are exempt from the substring rule above.
 *
 * ROADMAP.md Level 18 requires "approximate token counts" in the log, and the
 * substring `token` makes every natural name for that field — `promptTokens`,
 * `completionTokens`, `totalTokens` — redact to `[redacted]`. Two field names
 * also collide with `prompt`.
 *
 * This is an EXACT-NAME allowlist, not a relaxation of the rule. Three things
 * keep it narrow:
 *
 *   - Matching is `===` on the whole key, so `accessToken`, `apiToken`,
 *     `refreshToken`, `tokenSecret` and `systemPrompt` are all still redacted.
 *     Nothing is exempted by resembling an entry.
 *   - Every entry is a COUNT. A number of tokens is not a token, and cannot be
 *     replayed, presented as a credential, or used to reach anything.
 *   - The values are additionally required to be numbers below, so a string
 *     assigned to one of these names is redacted anyway.
 *
 * Do not add a name here that could ever hold a credential or user text.
 */
const METRIC_FIELDS = new Set(['promptTokens', 'completionTokens', 'totalTokens']);

/** Longest string value emitted. Stops a stack trace or document becoming a log line. */
const MAX_VALUE_LENGTH = 500;

function redactValue(key: string, value: unknown): unknown {
  // Level 18: an exempt metric field, and only when it really is a count. The
  // type check is the second half of the guarantee — the exemption cannot be
  // used to smuggle a string through under an approved name.
  if (METRIC_FIELDS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const lowered = key.toLowerCase();
  if (SENSITIVE.some((needle) => lowered.includes(needle))) return '[redacted]';

  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  if (value instanceof Error) {
    // The message only. A stack can carry absolute paths and, in a bundled
    // build, fragments of surrounding source.
    const message = value.message;
    return message.length > MAX_VALUE_LENGTH ? `${message.slice(0, MAX_VALUE_LENGTH)}…` : message;
  }
  if (typeof value === 'object' && value !== null) {
    // One level only: deep structures in logs are rarely read and easily huge.
    return '[object]';
  }
  return value;
}

function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = redactValue(key, value);
  }
  return safe;
}

/**
 * A correlation id for one request.
 *
 * Generated per request by the route, so every line belonging to that request
 * can be found together. Not derived from anything the client sends — a
 * client-supplied id could be reused to confuse the log.
 */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields),
  });

  // stderr for warn/error, stdout for info — so a process manager can separate
  // them without parsing.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields: LogFields = {}): void => emit('info', event, fields),
  warn: (event: string, fields: LogFields = {}): void => emit('warn', event, fields),
  error: (event: string, fields: LogFields = {}): void => emit('error', event, fields),
};
