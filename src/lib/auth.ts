/**
 * Level 13 — server-side authentication.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * ROADMAP.md Level 13: "Never trust a user_id supplied by the client. Always
 * obtain identity from the server-side authenticated session."
 *
 * There is deliberately no function here that accepts a user id. Identity is
 * only ever produced by `getServerUser()`, which takes a `Request`, reads an
 * httpOnly cookie the browser cannot write, and hands the token to Supabase to
 * be VERIFIED — not decoded and believed. A forged or expired token yields
 * null, and null means anonymous.
 *
 * Tokens live in httpOnly cookies rather than in localStorage or a body field
 * so that page scripts cannot read them, which is also why this application
 * does not use the browser-side Supabase auth client: every auth call is made
 * by the server, and the browser only ever sees a cookie it cannot inspect.
 */

import type { Owner } from './conversations.ts';
import { log } from './log.ts';
import { resolveSession } from './session.ts';
import { createAnonClient, isAuthConfigured } from './supabase/authed.ts';
import { getSupabaseAdminClient } from './supabase/server.ts';

/**
 * Access and refresh tokens.
 *
 * Two cookies rather than one JSON blob: the access token is sent on every
 * request and is short-lived, while the refresh token exists only to mint a new
 * one, and keeping them separate makes it obvious which is which at every call
 * site.
 */
export const ACCESS_TOKEN_COOKIE = 'aariz_access';
export const REFRESH_TOKEN_COOKIE = 'aariz_refresh';

/** Matches Supabase's default access-token lifetime. */
const ACCESS_MAX_AGE_SECONDS = 60 * 60;
const REFRESH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

export type AuthErrorCode = 'not_configured' | 'invalid_input' | 'rejected';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  /** Suggested HTTP status for the API layer. */
  readonly status: number;

  constructor(code: AuthErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  /** The verified access token, for building an RLS-subject client. */
  accessToken: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string | null;
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error('src/lib/auth.ts is server-only and must not be imported from a client component.');
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const value = decodeURIComponent(part.slice(separator + 1).trim());
    return value.length > 0 ? value : null;
  }
  return null;
}

function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

/** `Set-Cookie` values establishing a signed-in session. */
export function buildAuthCookies(session: AuthSession): string[] {
  return [
    cookie(ACCESS_TOKEN_COOKIE, session.accessToken, ACCESS_MAX_AGE_SECONDS),
    cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, REFRESH_MAX_AGE_SECONDS),
  ];
}

/** `Set-Cookie` values clearing a session. Max-Age=0 expires immediately. */
export function clearAuthCookies(): string[] {
  return [cookie(ACCESS_TOKEN_COOKIE, '', 0), cookie(REFRESH_TOKEN_COOKIE, '', 0)];
}

/**
 * The authenticated user for a request, or null.
 *
 * `auth.getUser(token)` asks Supabase to validate the signature and expiry. The
 * token is never decoded locally and trusted: a locally-parsed JWT is just a
 * client-supplied claim wearing a hat.
 */
export async function getServerUser(request: Request): Promise<AuthenticatedUser | null> {
  assertServerOnly();

  if (!isAuthConfigured()) return null;

  const accessToken = readCookie(request, ACCESS_TOKEN_COOKIE);
  if (accessToken === null) return null;

  try {
    const { data, error } = await createAnonClient().auth.getUser(accessToken);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null, accessToken };
  } catch {
    // An unreachable auth service means we cannot prove identity, and an
    // unproven identity is not an identity. Falling back to "anonymous" is the
    // safe direction; falling back to "trust the token" would not be.
    return null;
  }
}

function validateCredentials(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    throw new AuthError('invalid_input', 'A valid email address is required.', 400);
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(
      'invalid_input',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      400,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError('invalid_input', 'Password is too long.', 400);
  }
  return { email: email.trim().toLowerCase(), password };
}

function requireConfigured(): void {
  if (!isAuthConfigured()) {
    throw new AuthError(
      'not_configured',
      'Authentication is not configured on this server.',
      503,
    );
  }
}

/**
 * Create an account.
 *
 * Returns null for `session` when the project requires email confirmation — in
 * that case the account exists but cannot sign in yet. Reported honestly to the
 * caller rather than pretending the user is signed in.
 */
export async function signUp(
  email: unknown,
  password: unknown,
  /**
   * Absolute URL the confirmation link should return the user to.
   *
   * Passing nothing here was the bug behind "This site can't be reached —
   * localhost refused to connect" after clicking Confirm. With no
   * `emailRedirectTo`, Supabase falls back to the project's Site URL, whose
   * default is `http://localhost:3000` — an address that resolves to the
   * READER's own machine, where nothing is listening.
   *
   * The route supplies this from the server's own view of the request origin,
   * so a local developer gets a localhost link and a deployed instance gets its
   * real one, with no environment variable to forget.
   *
   * Supabase independently refuses any value not on its Redirect URLs
   * allow-list and silently falls back to the Site URL, so this cannot be used
   * to point a confirmation email anywhere arbitrary.
   */
  redirectTo?: string,
): Promise<{ session: AuthSession | null; needsConfirmation: boolean }> {
  assertServerOnly();
  requireConfigured();

  const credentials = validateCredentials(email, password);
  const { data, error } = await createAnonClient().auth.signUp({
    ...credentials,
    ...(redirectTo ? { options: { emailRedirectTo: redirectTo } } : {}),
  });

  if (error) throw new AuthError('rejected', error.message, 400);

  if (!data.session) {
    return { session: null, needsConfirmation: true };
  }
  return {
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      userId: data.session.user.id,
      email: data.session.user.email ?? null,
    },
    needsConfirmation: false,
  };
}

export async function signIn(email: unknown, password: unknown): Promise<AuthSession> {
  assertServerOnly();
  requireConfigured();

  const credentials = validateCredentials(email, password);
  const { data, error } = await createAnonClient().auth.signInWithPassword(credentials);

  /**
   * Still ONE message for every cause. Distinguishing "no such account" from
   * "wrong password" turns the sign-in form into an account enumerator, and
   * that property is unchanged here.
   *
   * What is added is the third cause, which was previously invisible and is
   * the one people actually hit: when a Supabase project has "Confirm email"
   * enabled, an unconfirmed account is refused with the same generic error as
   * a wrong password. A user who typed their password correctly was told it
   * was wrong, with nothing to act on. Naming the possibility costs no
   * enumeration — it applies equally whether or not the account exists.
   */
  if (error || !data.session) {
    throw new AuthError(
      'rejected',
      'Incorrect email or password — or the address has not been confirmed yet. ' +
        'If you have just signed up, check your inbox for a confirmation link.',
      401,
    );
  }

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    userId: data.session.user.id,
    email: data.session.user.email ?? null,
  };
}

/**
 * Adopt the current anonymous session's conversations on sign-in.
 *
 * Both values come from the server: `userId` from a token Supabase verified,
 * `sessionId` from the httpOnly cookie this server issued. Nothing the client
 * sent takes part in the decision, which is what makes the transfer safe.
 *
 * `user_id is null` in the predicate is essential — without it a second sign-in
 * on the same browser could rewrite the first user's conversations to the
 * second user.
 *
 * Runs through the service-role client on purpose: an authenticated client
 * could not see these rows to claim them, since RLS hides conversations whose
 * `user_id` is NULL from every authenticated user.
 */
export async function claimAnonymousConversations(
  userId: string,
  sessionId: string,
): Promise<number> {
  assertServerOnly();

  const { data, error } = await getSupabaseAdminClient()
    .from('conversations')
    .update({ user_id: userId })
    .eq('session_id', sessionId)
    .is('user_id', null)
    .select('id');

  if (error) {
    // Claiming is a convenience, not a correctness requirement. A failure here
    // must not block a successful sign-in.
    log.error('auth.claim_failed', { error: error.message });
    return 0;
  }
  return (data ?? []).length;
}

/**
 * Decide who is making this request.
 *
 * The single place every route learns identity from, so there is one code path
 * to audit rather than five. A verified Supabase session wins; otherwise the
 * caller is anonymous and scoped to the server-issued session cookie.
 *
 * Note the ordering: the anonymous session is resolved either way, because an
 * authenticated conversation still records the browser session it began in, and
 * because signing out must leave a working anonymous session behind.
 */
export async function resolveOwner(
  request: Request,
): Promise<{ owner: Owner; sessionId: string; isNewSession: boolean; user: AuthenticatedUser | null }> {
  assertServerOnly();

  const session = resolveSession(request);
  const user = await getServerUser(request);

  if (user !== null) {
    return {
      owner: {
        kind: 'authenticated',
        userId: user.id,
        accessToken: user.accessToken,
        sessionId: session.sessionId,
      },
      sessionId: session.sessionId,
      isNewSession: session.isNew,
      user,
    };
  }

  return {
    owner: { kind: 'anonymous', sessionId: session.sessionId },
    sessionId: session.sessionId,
    isNewSession: session.isNew,
    user: null,
  };
}
