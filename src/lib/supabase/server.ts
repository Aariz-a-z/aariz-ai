/**
 * Server-only Supabase client.
 *
 * This module holds the **service-role** key, which bypasses Row Level
 * Security entirely. Reaching the browser it would grant every visitor full
 * read/write access to every document. Three things keep that from happening:
 *
 *   1. The variable has no `NEXT_PUBLIC_` prefix, so Next.js never inlines it
 *      into a client bundle.
 *   2. The runtime guard below turns an accidental client import into an
 *      immediate, loud failure rather than a silent `undefined`.
 *   3. Nothing in `src/components/` imports this file.
 *
 * Level 13 adds a separate anon-key client for browser use under RLS. That is
 * a different client and belongs in a different file.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

export type AppSupabaseClient = SupabaseClient<Database>;

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/supabase/server.ts is server-only: it carries the service-role key and must never be imported from a client component.',
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill in your Supabase project settings.`,
    );
  }
  return value;
}

/**
 * Cached across requests in a warm server process. The client is stateless for
 * our purposes — no session is persisted — so sharing one instance avoids
 * rebuilding it per request.
 */
let cachedClient: AppSupabaseClient | null = null;

export function getSupabaseAdminClient(): AppSupabaseClient {
  assertServerOnly();

  if (cachedClient !== null) {
    return cachedClient;
  }

  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  cachedClient = createClient<Database>(url, serviceRoleKey, {
    auth: {
      // There is no end user on this connection and no browser storage to
      // write to. Leaving these on would have the client attempt to persist
      // and refresh a session that does not exist.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return cachedClient;
}

/**
 * Whether Supabase configuration is present.
 *
 * Lets callers degrade honestly instead of throwing — the Level 23 health
 * endpoint reports database availability rather than crashing the request.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
