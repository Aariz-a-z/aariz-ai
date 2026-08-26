/**
 * Level 18 — who may see the admin dashboard.
 *
 * ROADMAP.md Level 18 says only "Do not expose admin information to normal
 * users." It names no mechanism, so this is the smallest one that is actually
 * an authorization check rather than an obstacle: an explicit allowlist of
 * email addresses, compared against the identity Level 13 already verifies
 * server-side with Supabase.
 *
 * WHY NOT THE ALTERNATIVES
 * ------------------------
 *   A database role column — a migration and RLS policies to carry one
 *   boolean, for a deployment with a single operator.
 *
 *   A separate admin password or token — a second secret and a second
 *   authentication path, both of which could be got wrong, to protect a page
 *   that a user the application already authenticates could be named on.
 *
 * FAIL CLOSED
 * -----------
 * `ADMIN_EMAILS` unset or empty means NOBODY is an admin. There is no default
 * account, no "first user wins", and no development bypass. A deployment that
 * forgets the variable gets a dashboard nobody can open, which is the correct
 * direction to fail in.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not authentication. `getServerUser` does that, against Supabase, from
 * an httpOnly cookie. This only answers "is that verified person on the list",
 * and it is never given an email from anywhere but that verified session — a
 * caller cannot present an address and be believed.
 */

import { getServerUser, type AuthenticatedUser } from './auth.ts';

export const ADMIN_EMAILS_ENV = 'ADMIN_EMAILS';

/**
 * The configured administrators, lowercased.
 *
 * Read per call rather than cached so the verification suite can vary it
 * in-process, the same way it varies the rate limit and widget allowlist.
 *
 * Addresses are compared lowercased because `validateCredentials` in
 * `auth.ts` already lowercases on sign-up, so a stored address is always
 * lowercase and an allowlist entry with different casing would silently never
 * match — a misconfiguration that looks exactly like a working lockout.
 */
export function getAdminEmails(): string[] {
  const raw = process.env[ADMIN_EMAILS_ENV]?.trim();
  if (!raw) return [];

  return [
    ...new Set(
      raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/** Whether the dashboard is reachable by anyone at all. */
export function isAdminConfigured(): boolean {
  return getAdminEmails().length > 0;
}

/**
 * Whether a VERIFIED email belongs to an administrator.
 *
 * Only ever called with `AuthenticatedUser.email`, which came from Supabase
 * validating an access token. Never with a value from a body, header or query.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false;

  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0) return false;

  return getAdminEmails().includes(normalised);
}

/**
 * The administrator making this request, or null.
 *
 * Null covers every negative case without distinguishing them — not signed in,
 * signed in but not listed, and nobody configured all return the same thing,
 * so the caller cannot accidentally build a response that tells a visitor
 * which of the three applies.
 */
export async function resolveAdmin(request: Request): Promise<AuthenticatedUser | null> {
  // Cheapest check first, and it is also the fail-closed one: with no
  // allowlist there is no point verifying a token against Supabase.
  if (!isAdminConfigured()) return null;

  const user = await getServerUser(request);
  if (user === null) return null;

  return isAdminEmail(user.email) ? user : null;
}
