/**
 * Browser-side authentication calls (Level 13).
 *
 * Thin wrappers over this application's own `/api/auth/*` routes. The browser
 * never talks to Supabase Auth directly and never receives a token: the session
 * lives entirely in httpOnly cookies, so there is nothing here for a page
 * script — or an XSS payload — to read.
 *
 * Note what this module does NOT expose: no user id, no access token, no
 * session object. `AuthState` carries an email address and a boolean, because
 * that is all the interface needs in order to render.
 */

export interface AuthState {
  /** False when the server has no anon key configured; the UI then hides sign-in. */
  configured: boolean;
  authenticated: boolean;
  email: string | null;
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

export async function fetchAuthState(signal?: AbortSignal): Promise<AuthState> {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', signal });
  if (!response.ok) return { configured: false, authenticated: false, email: null };
  return (await response.json()) as AuthState;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Returns a message when the account needs email confirmation before sign-in. */
export async function signUp(email: string, password: string): Promise<string | null> {
  const response = await post('/api/auth/signup', { email, password });
  if (!response.ok) throw new Error(await readError(response, 'Could not create the account.'));

  const data = (await response.json()) as { needsConfirmation?: boolean; message?: string };
  return data.needsConfirmation ? (data.message ?? 'Confirm your email address, then sign in.') : null;
}

export async function signIn(email: string, password: string): Promise<void> {
  const response = await post('/api/auth/signin', { email, password });
  if (!response.ok) throw new Error(await readError(response, 'Could not sign in.'));
}

export async function signOut(): Promise<void> {
  const response = await post('/api/auth/signout');
  if (!response.ok) throw new Error(await readError(response, 'Could not sign out.'));
}
