/**
 * Level 17 — the embeddable widget frame.
 *
 * ROADMAP.md Level 17 asks for an iframe-isolated widget with origin
 * validation. This is the framed document. It is a SERVER component so the
 * allowlist is consulted before any markup is produced, and so the decision
 * cannot be reached by editing client state.
 *
 * THREE LAYERS GUARD THIS ROUTE, AND THEY ARE NOT INTERCHANGEABLE
 * ---------------------------------------------------------------
 *   1. `frame-ancestors` (next.config.ts) — a BROWSER refuses to render this
 *      document inside a page that is not on the allowlist. This is the
 *      control that stops an arbitrary website displaying the widget, and it
 *      is worth nothing outside a browser.
 *
 *   2. The `Referer` check below — defence in depth for the document request.
 *      The browser sets `Referer`, and the framing page's JavaScript cannot
 *      forge it; `curl` can set anything, so this narrows careless embedding
 *      rather than defeating a determined caller.
 *
 *   3. Server-side validation on `/api/chat` — the layer that actually bounds
 *      API abuse. Rendering this page grants nothing: the shell below is inert
 *      until a `postMessage` from an allowlisted parent unlocks it, and every
 *      request it then makes is re-validated against the allowlist by the
 *      route, which never trusts what this page claims.
 *
 * WHY 404 AND NOT 403
 * -------------------
 * `notFound()` is the refusal available to a server component without turning
 * on Next's experimental `authInterrupts` flag, which is what `forbidden()`
 * requires — a global experimental switch is too much to enable for a status
 * code. The API path, where the status code is worth having, returns a real
 * 403 because a route handler builds its own Response. 404 also discloses
 * less: it does not confirm that an embed route exists at all.
 */

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { EmbeddedChat } from '@/components/embedded-chat';
import { isInferenceDisabled } from '@/lib/inference-mode';
import { getAllowedWidgetOrigins, normalizeOrigin } from '@/lib/widget-origins';

// The allowlist is read per request, and the decision depends on a header.
export const dynamic = 'force-dynamic';

export default async function EmbedPage() {
  const allowedOrigins = getAllowedWidgetOrigins();

  // Fail closed. No allowlist means the widget is switched off, and the route
  // that serves it should not exist either — `frame-ancestors` is already
  // `'none'` in this state, so a browser would refuse the frame regardless.
  if (allowedOrigins.length === 0) notFound();

  const referer = normalizeOrigin((await headers()).get('referer'));

  // Absent is not refused: a host page sending `Referrer-Policy: no-referrer`
  // legitimately sends none, and rejecting those would break an allowlisted
  // site while stopping nobody who can set a header. Present-but-unapproved is
  // an unambiguous answer, and is refused.
  if (referer !== null && !allowedOrigins.includes(referer)) notFound();

  /**
   * The allowlist reaches the browser, and that is not a leak.
   *
   * The same origins are already in this response's `frame-ancestors`
   * directive, which every client can read, so there is nothing here a visitor
   * could not obtain from the headers. The page needs them to validate
   * `event.origin` on incoming messages, which is the client half of the
   * two-way origin check. No other server configuration is passed: no Supabase
   * URL, no Ollama address, no keys, no model name.
   */
  return (
    <EmbeddedChat allowedOrigins={allowedOrigins} inferenceDisabled={isInferenceDisabled()} />
  );
}
