/**
 * Level 13 — request-scoped Supabase clients that are SUBJECT TO RLS.
 *
 * The distinction from `server.ts` is the whole point of this file and is worth
 * stating plainly:
 *
 *   server.ts   service-role key. BYPASSES RLS entirely. Correct for ingestion,
 *               for anonymous session-scoped access, and for administrative
 *               work — and useless as proof that RLS does anything.
 *
 *   this file   anon key plus the caller's Supabase Auth JWT. Executes as the
 *               `authenticated` role with `auth.uid()` set, so every policy in
 *               the Level 13 migration actually applies.
 *
 * ROADMAP.md Level 13 says "Use RLS". If authenticated reads and writes went on
 * running through the service-role key with a `user_id` filter bolted on in
 * JavaScript, the policies would be decorative: they would exist in the schema
 * and gate nothing, and a single missing `.eq()` would silently expose every
 * user's conversations. Routing authenticated traffic through this client makes
 * the database the last line of defence rather than a comment.
 *
 * The anon key is NOT a secret in the way the service-role key is — it is
 * designed to be publishable, and RLS is what protects the data behind it. It
 * is still deliberately un-prefixed here rather than `NEXT_PUBLIC_`, because
 * nothing in the browser needs it: every Supabase call in this application is
 * made by the server.
 */

import { createClient } from '@supabase/supabase-js';

import type { AppSupabaseClient } from './server.ts';
import type { Database } from '../../types/database.ts';

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/supabase/authed.ts is server-only and must not be imported from a client component.',
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Add it to .env.local — Supabase dashboard -> Project Settings -> API Keys -> anon/publishable.`,
    );
  }
  return value;
}

/** Whether the anon key needed for authentication is configured. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim());
}

const NO_SESSION = {
  // Every client here is built per request and thrown away. Persisting or
  // refreshing a session would mean sharing one user's tokens with the next
  // request that happened to reuse the instance.
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * An unauthenticated client, used only to talk to Supabase Auth itself —
 * signing up, signing in, and verifying a token.
 *
 * It carries no user identity, so any table access through it runs as `anon`,
 * which the migration grants nothing and gives no policy. That is intentional:
 * this client is for auth calls, not for data.
 */
export function createAnonClient(): AppSupabaseClient {
  assertServerOnly();
  return createClient<Database>(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: NO_SESSION,
  });
}

/**
 * A client that acts as the signed-in user.
 *
 * The JWT travels in the Authorization header, so PostgREST runs the request as
 * `authenticated` and `auth.uid()` inside every policy resolves to this user.
 * A forged or expired token is rejected by Supabase, not by us.
 */
export function createAuthedClient(accessToken: string): AppSupabaseClient {
  assertServerOnly();
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('createAuthedClient requires a non-empty access token.');
  }

  return createClient<Database>(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: NO_SESSION,
  });
}
