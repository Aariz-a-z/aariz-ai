'use client';

/**
 * Level 16 — route error boundary.
 *
 * Catches a render or data error in this segment so a failure shows a usable
 * page instead of falling through to the framework's default.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * ----------------------------------
 * `error.message` and `error.stack` are never rendered. In a production build
 * Next already replaces a server error's message with a generic string and a
 * digest, but a CLIENT-side error keeps its real message, and that message can
 * carry a URL, a query, or a fragment of internal state. Showing only the
 * digest gives the user something to quote to an operator while giving a
 * visitor nothing to learn from.
 *
 * The Level 8 system prompt, environment values and provider details are all
 * server-only and could not appear here in any case — this boundary is the
 * layer that keeps it that way if a future error object ever carries them.
 */

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Console only, and only the digest. The server-side logger records the
    // real detail; the browser gets nothing worth harvesting.
    console.error('[error-boundary] render failed', error.digest ?? '(no digest)');
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center dark:bg-zinc-950">
      <h1 className="text-lg font-medium text-zinc-900 dark:text-zinc-50">Something went wrong</h1>

      <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        The page could not be displayed. Your conversations and documents are unaffected.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Try again
        </button>
        {/*
          A plain anchor, not next/link, and deliberately so: this boundary
          renders precisely when something in the React tree has failed, and a
          client-side navigation depends on the very router that may be the
          thing that broke. A full page load is the one navigation guaranteed
          to work from here.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Back to chat
        </a>
      </div>

      {error.digest !== undefined && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          Reference: <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}
