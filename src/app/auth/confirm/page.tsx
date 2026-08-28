/**
 * Where a confirmation link lands.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * Clicking "confirm your email" used to end at "This site can't be reached —
 * localhost refused to connect", for everyone. The account was created and the
 * address really was confirmed, because Supabase verifies the token on its own
 * server before redirecting; only the final hop failed. Two separate causes:
 *
 *   1. `signUp` passed no `emailRedirectTo`, so Supabase fell back to the
 *      project's Site URL — `http://localhost:3000` by default, which resolves
 *      to the VISITOR's own machine and refuses the connection.
 *   2. There was nowhere to land even with a correct URL. The redirect would
 *      have dropped the user on the chat page with no indication that anything
 *      had happened.
 *
 * This fixes the second. The first is fixed in the signup route, which now
 * sends an absolute URL to this page — and it must also be allow-listed in the
 * Supabase dashboard, which is a manual step documented in `.env.example`.
 *
 * A server component: nothing here needs the client except reading the URL
 * fragment, which is delegated to one small island below.
 */

import Link from 'next/link';

import { BrandMark } from '@/components/brand';
import { ConfirmationOutcome } from '@/components/confirmation-outcome';

export const dynamic = 'force-dynamic';

/**
 * Supabase reports a failure in the QUERY STRING on the PKCE flow and in the
 * URL FRAGMENT on the implicit flow, and which one a project uses depends on
 * its configuration. The query half is read here; the fragment half cannot be —
 * a fragment is never sent to a server — so it is read by the client island.
 *
 * Reading only one of the two would mean an expired link showing a cheerful
 * "verified successfully", which is the one outcome worse than the dead page
 * this replaces.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | null =>
    Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

  // Both codes are forwarded, joined, for the same reason the fragment parser
  // keeps all three: `error=access_denied` alone does not say the link expired,
  // while `error_code=otp_expired` beside it does.
  const error = [first(params.error), first(params.error_code)].filter(Boolean).join(' ') || null;
  const description = first(params.error_description);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 bg-white px-6 text-center dark:bg-zinc-950">
      <BrandMark className="size-10" />

      {/*
        The server's verdict is passed in and the island refines it from the
        fragment. Rendering the success state here first means a user with
        JavaScript disabled still sees a sensible page rather than a blank one.
      */}
      <ConfirmationOutcome serverError={error} serverDescription={description} />

      <Link
        href="/"
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:focus-visible:ring-offset-zinc-950"
      >
        Continue to AARIZ AI
      </Link>
    </main>
  );
}
