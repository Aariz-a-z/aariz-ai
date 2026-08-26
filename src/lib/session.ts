/**
 * Level 12 — anonymous session identity.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * ROADMAP.md Level 12 asks for persisted conversations that a user can list,
 * rename, delete and continue. Listing is the operative word: "which chats are
 * mine?" has no answer without an owner, so persistence forces some notion of
 * ownership even though authentication is Level 13.
 *
 * This is that minimum. It is NOT authentication, not Supabase Auth, not a user
 * account, and not an RLS policy — all of which arrive at Level 13. It is an
 * opaque identifier the SERVER generates and stores in an httpOnly cookie, used
 * only to scope rows.
 *
 * The property that matters is that nothing identifying ever comes from the
 * client. The cookie is httpOnly so page scripts cannot read it, and the value
 * is server-generated so a client cannot choose one. Level 13's rule — "never
 * trust a user_id supplied by the client" — therefore already holds, and Level
 * 13 can add authenticated ownership beside this column instead of replacing a
 * design that trusted the browser.
 *
 * KNOWN LIMITATION, ACCEPTED FOR THIS LEVEL
 * -----------------------------------------
 * Possession of the cookie is possession of the conversations. There is no
 * password, no account recovery, and no way to distinguish two people sharing a
 * browser profile. That is inherent to a pre-authentication level and is stated
 * rather than disguised.
 *
 * Deliberately free of `next/headers` so the standalone verification scripts
 * can import it: everything here works from a plain `Request` and returns plain
 * header values.
 */

/**
 * Cookie name. Prefixed to avoid colliding with anything Supabase Auth adds at
 * Level 13, which uses its own `sb-` cookies.
 */
export const SESSION_COOKIE_NAME = 'aariz_session';

/** One year. Long enough that "refresh and retain history" survives a laptop lid. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * A session id is a v4 UUID: 122 random bits, so it cannot be guessed or
 * enumerated. It carries no meaning and is not derived from anything about the
 * user — there is nothing in it to leak.
 */
export function createSessionId(): string {
  return crypto.randomUUID();
}

/** Shape of a UUID, used to reject a malformed or hand-crafted cookie value. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Read the session id from a request's Cookie header.
 *
 * Returns null when absent or malformed. A malformed value is treated as no
 * session at all rather than being passed through: it can only have come from
 * something other than this server, and using it would let a caller pick its
 * own scope.
 */
export function readSessionId(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;

    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;

    const value = decodeURIComponent(part.slice(separator + 1).trim());
    return isValidSessionId(value) ? value : null;
  }

  return null;
}

/**
 * Build the `Set-Cookie` value for a session.
 *
 * HttpOnly    — page scripts cannot read it, so an XSS bug cannot exfiltrate it.
 * SameSite=Lax — not sent on cross-site POSTs, which is what stops another
 *                origin from acting on this session.
 * Secure      — production only; localhost development is plain http and the
 *                browser would silently discard a Secure cookie there.
 */
export function buildSessionCookie(sessionId: string): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

export interface ResolvedSession {
  sessionId: string;
  /** True when this request arrived without a usable session and one was minted. */
  isNew: boolean;
}

/**
 * The session for a request, creating one if needed.
 *
 * A new session is only persisted to the browser if the caller attaches
 * `buildSessionCookie(sessionId)` to its response — deliberately explicit, so a
 * read-only endpoint does not hand out sessions as a side effect of being
 * called.
 */
export function resolveSession(request: Request): ResolvedSession {
  const existing = readSessionId(request);
  if (existing !== null) return { sessionId: existing, isNew: false };
  return { sessionId: createSessionId(), isNew: true };
}
