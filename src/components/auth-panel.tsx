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

import { useState } from 'react';

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

    const action = mode === 'signin' ? signIn(email, password) : signUp(email, password).then((message) => {
      if (message !== null) setNotice(message);
    });

    void action
      .then(() => {
        setPassword('');
        onChanged();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Something went wrong.'),
      )
      .finally(() => setBusy(false));
  };

  return (
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
  );
}
