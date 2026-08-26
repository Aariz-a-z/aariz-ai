/**
 * Level 16 — 404 page.
 *
 * A server component: nothing here is interactive, and rendering it on the
 * server means an unknown path never runs client JavaScript.
 *
 * It says only that the page does not exist. No path echo, no suggestions
 * derived from the request — reflecting a user-supplied path back into the page
 * is how a 404 becomes a reflected-content vector, and enumerating what does
 * exist helps nobody but someone mapping the application.
 */

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center dark:bg-zinc-950">
      <h1 className="text-lg font-medium text-zinc-900 dark:text-zinc-50">Page not found</h1>

      <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        That page does not exist.
      </p>

      <Link
        href="/"
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
      >
        Back to chat
      </Link>
    </main>
  );
}
