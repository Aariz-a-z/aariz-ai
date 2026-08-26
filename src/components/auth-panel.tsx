'use client';

/**
 * Sign in, sign up, sign out (Level 13).
 *
 * Deliberately the minimum ROADMAP.md Level 13 asks for: create an account,
 * start a session, end it, and see which state you are in. No profile editing,
 * no password reset, no OAuth — none of which the roadmap requires at this
 * level, and each of which would be a surface to secure for no stated benefit.
 *
 * Signing in is never required to use the chatbot. An anonymous visitor keeps
 * the full Level 12 experience, which is why this sits quietly in the sidebar
 * footer rather than blocking the application behind a login wall.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { signIn, signOut, signUp, type AuthState } from '@/lib/auth-client';

export interface AuthPanelProps {
  state: AuthState;
  /** Called after any change of session, so the chat list can be reloaded. */
  onChanged: () => void;
}

type Mode = 'signin' | 'signup';

export function AuthPanel({ state, onChanged }: AuthPanelProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The address a just-created account must confirm, or null.
   *
   * Held separately from `notice` because it drives a modal rather than a line
   * of text. The inline notice was correct and still missed: it sat beside a
   * red error in the same small type, and a new user read past it, then spent
   * several attempts retyping a password that had always been right.
   */
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  // Escape closes the dialog, as it does for every other overlay on the web.
  // Registered unconditionally so the hook order cannot change between the
  // early returns below.
  useEffect(() => {
    if (confirmEmail === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirmEmail(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmEmail]);

  // The server said it has no anon key. Offering a button that could only fail
  // is worse than showing nothing.
  if (!state.configured) {
    return (
      <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        Chats are saved to this browser.
      </p>
    );
  }

  if (state.authenticated) {
    return (
      <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <p className="truncate text-xs text-zinc-600 dark:text-zinc-300" title={state.email ?? ''}>
          Signed in as <span className="font-medium">{state.email}</span>
        </p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Your chats are saved to your account.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOut()
              .then(onChanged)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Could not sign out.'),
              )
              .finally(() => setBusy(false));
          }}
          className="mt-2 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Sign out
        </button>
        {error !== null && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  const submit = (): void => {
    setBusy(true);
    setError(null);
    setNotice(null);

    const attempted = email;

    const action =
      mode === 'signin'
        ? signIn(email, password)
        : signUp(email, password).then((message) => {
            // A message means the account was created but cannot sign in yet.
            // That is the case worth interrupting for.
            if (message !== null) {
              setConfirmEmail(attempted);
              // Kept as well as the dialog, not instead of it: once the dialog
              // is dismissed there would otherwise be nothing left on screen
              // saying why sign-in is about to fail.
              setNotice(message);
            }
          });

    void action
      .then(() => {
        setPassword('');
        onChanged();
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : 'Something went wrong.';

        /**
         * The provider's mail quota, surfaced honestly.
         *
         * Supabase's free tier sends a limited number of confirmation emails
         * per hour. Past that, sign-up fails with a message about an "email
         * rate limit" that means nothing to a visitor and reads like their
         * fault. Naming what actually happened is the whole fix.
         *
         * It deliberately does NOT auto-confirm the account to get around the
         * limit. Doing so would let anyone register an address they do not own
         * simply by exhausting the quota first — turning a rate limit into an
         * authentication bypass.
         */
        if (/rate limit|too many requests/i.test(message)) {
          setError(
            'Too many sign-up emails have been sent from this project in the last hour. ' +
              'This is a limit on the email service, not on your details. Please try again later.',
          );
          return;
        }
        setError(message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      {confirmEmail !== null && <ConfirmEmailDialog email={confirmEmail} onClose={() => setConfirmEmail(null)} />}
    <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
      {!open ? (
        <>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Chats are saved to this browser.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-2 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Sign in to save them to an account
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="space-y-2"
        >
          <label className="block text-xs text-zinc-600 dark:text-zinc-300">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
          </label>
          <label className="block text-xs text-zinc-600 dark:text-zinc-300">
            Password
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
                setNotice(null);
              }}
              className="text-xs text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {mode === 'signin' ? 'Create one' : 'Have an account?'}
            </button>
          </div>

          {error !== null && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {/*
            Deliberately louder than the error beside it. This is the one
            message a new user MUST act on — an unconfirmed account fails
            sign-in with a generic "incorrect password", so a confirmation
            notice that reads as a quiet aside sends people into a loop of
            retyping a password that was always correct.
          */}
          {notice !== null && (
            <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
              {notice}
            </p>
          )}
        </form>
      )}
    </div>
    </>
  );
}

/**
 * The interruption after a successful sign-up.
 *
 * A confirmation step is invisible at exactly the wrong moment: the account is
 * created, the form clears, everything looks like success — and the next
 * sign-in is rejected with the same generic wording as a wrong password. The
 * inline notice under the form was true and got read past. A dialog cannot be.
 *
 * It is PORTALLED to `document.body`, and that is not a stylistic choice. The
 * panel lives in the conversation sidebar, which at narrow widths is an
 * off-canvas drawer held at `-translate-x-full`. Rendered in place, the
 * dialog inherited that position and was measured 287px wide at `left: -288`
 * — a full-screen overlay sitting entirely outside the screen. `position:
 * fixed` does not rescue it, because a transformed ancestor becomes the
 * containing block. The portal is what makes it viewport-level.
 *
 * It states what it knows and nothing more. The address is echoed back so a
 * typo is visible while it is still cheap to fix, spam is named because that is
 * where these messages usually are, and the delivery is described as sent
 * rather than as arrived — the application handed it to a mail service and has
 * no idea what happened next.
 */
function ConfirmEmailDialog({ email, onClose }: { email: string; onClose: () => void }) {
  // `document` does not exist while the server renders, so the host is resolved
  // lazily. There is no hydration mismatch to worry about: this component is
  // only ever mounted in response to a click, never during the server pass.
  const [host] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.body,
  );
  if (host === null) return null;

  return createPortal(
    <div
      // Closes on a backdrop click. The inner panel stops the event so a click
      // on the text itself does not dismiss what the user is reading.
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-email-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex size-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
          <span aria-hidden="true" className="text-xl">
            ✉️
          </span>
        </div>

        <h2
          id="confirm-email-title"
          className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Confirm your email to finish
        </h2>

        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          Your account was created and a confirmation link was sent to{' '}
          <span className="font-medium break-all text-zinc-900 dark:text-zinc-100">{email}</span>.
        </p>

        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          Open that link first. Until you do,{' '}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            signing in will be refused
          </span>{' '}
          — and the message looks exactly like a wrong password, so it is worth
          checking your spam folder before retrying your details.
        </p>

        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mt-4 w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:focus-visible:ring-offset-zinc-900"
        >
          Got it
        </button>
      </div>
    </div>,
    host,
  );
}
