'use client';

import { useSyncExternalStore } from 'react';

/**
 * Did the confirmation actually succeed?
 *
 * A tiny client island for one reason: Supabase's implicit flow reports the
 * result in the URL FRAGMENT (`#error=access_denied&error_code=otp_expired`, or
 * `#access_token=…` on success), and a fragment is never transmitted to a
 * server. The page component reads the query string, which covers the PKCE
 * flow; this covers the other one.
 *
 * Without it, an expired or already-used link would render "Email verified
 * successfully" — telling someone their account is ready when it is not, which
 * is worse than the dead page this whole feature replaces.
 *
 * It defaults to SUCCESS rather than to failure, deliberately. By the time this
 * page loads, Supabase has already verified the token on its own servers and
 * chosen to redirect here; arriving with no error of any kind IS the success
 * case. Defaulting to failure would show an error to every user who succeeded
 * under any flow that reports nothing at all.
 */

/**
 * The fragment, read through `useSyncExternalStore`.
 *
 * Not `useState` + `useEffect`: setting state from an effect to read the
 * location is exactly the pattern React now flags, and the naive alternative —
 * a lazy initialiser touching `window` — breaks server rendering. This hook
 * exists for reading an external value that the server cannot see, and it
 * handles the hydration step itself.
 *
 * `subscribe` listens for `hashchange` rather than doing nothing. The first
 * version assumed the fragment could never change here, on the reasoning that
 * the user arrives from a redirect and does not navigate within the page. That
 * assumption is wrong in a way that fails silently: changing only the fragment
 * does NOT reload the document, so with a no-op subscription React keeps the
 * first snapshot forever. Proven by navigating from an `#error=...` URL to an
 * `#access_token=...` one, where the page went on reporting the expired link.
 *
 * The redirect from Supabase is a full page load, so the real flow would have
 * worked either way — which is exactly why this was worth fixing rather than
 * leaving as a latent trap for the next person who links to this page.
 */
const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const getHash = (): string => window.location.hash;
const getServerHash = (): string => '';

interface Failure {
  /** Every signal Supabase sent, joined — see `isExpired`. */
  signals: string;
}

/**
 * Supabase sends all three of `error`, `error_code` and `error_description`,
 * and the useful one is not always the first.
 *
 * A real expired link arrives as
 * `#error=access_denied&error_code=otp_expired&error_description=…`. Reading
 * `error ?? error_code` takes `access_denied` and never sees `otp_expired`, so
 * the page fell back to the vaguer "could not be used" wording for the single
 * most common failure there is. Caught by changing the fragment in a browser
 * and watching the heading pick the wrong branch.
 *
 * All three are kept and matched together instead of guessing which field
 * carries the meaning.
 */
function parseFragment(hash: string): Failure | null {
  const body = hash.replace(/^#/, '');
  if (body.length === 0) return null;
  return toFailure(new URLSearchParams(body));
}

export function toFailure(params: URLSearchParams): Failure | null {
  const error = params.get('error');
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (error === null && code === null) return null;

  return { signals: [error, code, description].filter(Boolean).join(' ') };
}

/** Whether any of the signals names an expired or already-used link. */
function isExpired(failure: Failure): boolean {
  return /expired|otp_expired|already/i.test(failure.signals);
}

export function ConfirmationOutcome({
  serverError,
  serverDescription,
}: {
  serverError: string | null;
  serverDescription: string | null;
}) {
  const hash = useSyncExternalStore(subscribe, getHash, getServerHash);

  const failure: Failure | null = serverError
    ? { signals: [serverError, serverDescription].filter(Boolean).join(' ') }
    : parseFragment(hash);

  if (failure === null) {
    return (
      <>
        <div
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40"
        >
          <svg
            className="size-7 text-emerald-600 dark:text-emerald-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 13 4 4L19 7" />
          </svg>
        </div>

        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Email verified successfully
        </h1>

        <p className="max-w-sm text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Your account is ready. Sign in with the email and password you chose, and your
          conversations and documents will be saved to it.
        </p>
      </>
    );
  }

  /**
   * The failure copy names the cause in plain words and, crucially, says what
   * to do next. Supabase's own `error_description` is deliberately NOT shown:
   * it reads like "Email link is invalid or has expired", which is accurate and
   * leaves the reader with no idea that signing up again is the fix.
   */
  const expired = isExpired(failure);

  return (
    <>
      <div
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40"
      >
        <svg
          className="size-7 text-amber-600 dark:text-amber-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>

      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {expired ? 'This link has expired' : 'This link could not be used'}
      </h1>

      <p className="max-w-sm text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {expired
          ? 'Confirmation links are single-use and time-limited, and this one has already been used or has run out. Sign up again with the same address to get a fresh link.'
          : 'The confirmation link was not accepted. Sign up again with the same address to get a new one.'}
      </p>
    </>
  );
}
