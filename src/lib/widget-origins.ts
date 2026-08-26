/**
 * Level 17 — the embedding-origin allowlist.
 *
 * ROADMAP.md Level 17: "origin validation" and "Do not allow arbitrary websites
 * to abuse the API." This module is the single definition of which websites may
 * embed the widget, and it is deliberately the ONLY place an origin string is
 * turned into a decision.
 *
 * WHY NORMALISATION IS THE WHOLE PROBLEM
 * --------------------------------------
 * An allowlist compared with `===` against a raw client string is not an
 * allowlist. `HTTPS://Example.COM`, `https://example.com:443`,
 * `https://example.com/` and `https://exämple.com` all denote the same origin
 * to a browser and all differ as strings, while `https://example.com.evil.test`
 * denotes a completely different one and looks similar. Every value — the
 * configured entries and the claimed one alike — is therefore parsed by the
 * URL parser and reduced to its canonical `origin`, which lowercases the scheme
 * and host, punycodes a unicode hostname, drops the default port, and has no
 * path or trailing slash. Two values are compared only after both have been
 * through that same reduction.
 *
 * FAIL CLOSED
 * -----------
 * An unset or empty `WIDGET_ALLOWED_ORIGINS` means the widget is DISABLED:
 * `frame-ancestors` stays `'none'` and every widget API call is refused. There
 * is no default origin, no wildcard, and no "allow anything in development".
 *
 * BOUNDED BY CONSTRUCTION
 * -----------------------
 * `resolveWidgetOrigin` returns the CONFIGURED entry, never the caller's
 * string. That is what keeps the Level 14 bucket map finite: the number of
 * distinct widget rate-limit keys can never exceed the number of configured
 * origins, however many variations a caller invents. See `MAX_ENTRIES` below
 * and the note in `src/lib/rate-limit.ts`.
 *
 * Deliberately free of imports so it can be loaded from three very different
 * places: `next.config.ts` (to build the CSP at config time), the App Router
 * (to validate requests), and the standalone verification script.
 */

/**
 * Request header a widget request identifies itself with.
 *
 * A CUSTOM header on purpose. A cross-origin `fetch` that sets one triggers a
 * CORS preflight, and this application answers every preflight with 405 and
 * emits no `Access-Control-Allow-Origin` anywhere — so no third-party page can
 * set this header on a request to us from a browser. Inside a browser the only
 * document that can send it is one of our own, which is exactly the `/embed`
 * page. A non-browser caller can of course send anything, which is why the
 * value is validated here and rate-limited rather than trusted.
 */
export const WIDGET_ORIGIN_HEADER = 'x-widget-origin';

/** Environment variable holding the allowlist, comma-separated. */
export const WIDGET_ORIGINS_ENV = 'WIDGET_ALLOWED_ORIGINS';

/**
 * Ceiling on configured entries.
 *
 * Not a security control against an attacker — nobody but the operator writes
 * this variable — but it bounds the widget rate-limit key space at a value a
 * human chose, and it turns a malformed variable (a pasted log line, say) into
 * a loud configuration error instead of thousands of buckets.
 */
const MAX_ENTRIES = 20;

/**
 * Ceiling on a single origin string before it is even parsed.
 *
 * A hostname is at most 253 characters; add a scheme, brackets for IPv6, and a
 * port and 300 is generous. Applied to the CLAIMED value too, so a caller
 * cannot make us parse a megabyte.
 */
const MAX_ORIGIN_LENGTH = 300;

/**
 * Reduce a value to its canonical origin, or null if it is not one.
 *
 * Only `http:` and `https:` are accepted. Anything else — `file:`, `data:`,
 * `javascript:`, a bare hostname with no scheme, the opaque string `"null"` a
 * sandboxed frame sends — is not an origin this application will ever allow,
 * and is rejected rather than coerced into something that looks like one.
 */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ORIGIN_LENGTH) return null;

  // The opaque origin. A sandboxed iframe or a `file://` page sends this, and
  // it identifies nobody — every such page would share one allowlist entry.
  if (trimmed === 'null') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // `origin` is the canonical form: lowercased scheme and host, punycoded
  // hostname, default port omitted, no path, no query, no fragment, no
  // trailing slash. Re-checked for the opaque result the parser can produce.
  const origin = url.origin;
  if (origin === 'null' || origin.length === 0) return null;

  return origin;
}

/**
 * Every origin permitted to embed the widget, canonical and deduplicated.
 *
 * Read from the environment on each call rather than cached, so the
 * verification suite can vary it in-process the way it already varies the rate
 * limit configuration. An entry that is not a valid origin is a configuration
 * error and throws — silently dropping it would mean an operator believes a
 * site is allowed when it is not, which is the failure mode most likely to end
 * with someone widening the policy until it works.
 */
export function getAllowedWidgetOrigins(): string[] {
  const raw = process.env[WIDGET_ORIGINS_ENV]?.trim();
  if (!raw) return [];

  const entries = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `${WIDGET_ORIGINS_ENV} lists ${entries.length} origins; the maximum is ${MAX_ENTRIES}.`,
    );
  }

  const canonical = new Set<string>();
  for (const entry of entries) {
    const origin = normalizeOrigin(entry);
    if (origin === null) {
      // The offending entry is named because this is an operator-facing
      // startup error, not a response to a caller. It is never sent to a client.
      throw new Error(
        `${WIDGET_ORIGINS_ENV} contains "${entry}", which is not a valid http(s) origin. ` +
          'Expected a scheme and host with no path, for example "https://example.com".',
      );
    }
    canonical.add(origin);
  }

  return [...canonical].sort();
}

/** Whether any site is permitted to embed. False disables the widget entirely. */
export function isWidgetEnabled(): boolean {
  return getAllowedWidgetOrigins().length > 0;
}

/**
 * Resolve a claimed origin to the configured entry it matches, or null.
 *
 * Returning the CONFIGURED string rather than the caller's is the point: every
 * equivalent spelling collapses onto one value, so downstream code — the rate
 * limiter above all — sees a member of a fixed, finite set.
 */
export function resolveWidgetOrigin(claimed: unknown): string | null {
  const normalized = normalizeOrigin(claimed);
  if (normalized === null) return null;

  const allowed = getAllowedWidgetOrigins();
  return allowed.includes(normalized) ? normalized : null;
}

/**
 * The `frame-ancestors` value for `/embed`.
 *
 * `'none'` when nothing is configured. This is the fail-closed default and the
 * reason an unset variable cannot accidentally publish the widget: the browser
 * refuses to render the frame at all.
 */
export function frameAncestorsValue(): string {
  const allowed = getAllowedWidgetOrigins();
  return allowed.length === 0 ? "'none'" : allowed.join(' ');
}

/**
 * The origin of a request's `Referer`, or null.
 *
 * For the `/embed` document request this is the page doing the framing, set by
 * the browser and not writable by that page's JavaScript. It is a real signal
 * inside a browser and worth nothing outside one — `curl` will send whatever it
 * likes — so it is used only as defence in depth beside `frame-ancestors`,
 * never as the control that bounds API abuse.
 *
 * Absence is not failure: a host page with `Referrer-Policy: no-referrer` sends
 * none, and refusing those would break a legitimately allowlisted site while
 * stopping nobody.
 */
export function refererOrigin(request: Request): string | null {
  return normalizeOrigin(request.headers.get('referer'));
}
