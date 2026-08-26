import type { NextConfig } from "next";

import { frameAncestorsValue } from "./src/lib/widget-origins";

/**
 * Level 16 — Content Security Policy.
 *
 * PRAGMATIC BY DECISION, AND HERE IS THE HONEST TRADE-OFF
 * -------------------------------------------------------
 * `script-src` includes `'unsafe-inline'`. That is not laziness: Next.js
 * injects inline bootstrap and hydration scripts into every page, and the App
 * Router streams further inline chunks as it renders. A nonce-based policy is
 * strictly better in principle, but it requires threading a per-request nonce
 * through middleware into the document, and a policy that looks strict while
 * silently breaking hydration is worse than an honest permissive one.
 *
 * What that costs, stated plainly: `'unsafe-inline'` means CSP would NOT stop
 * an injected inline <script> if one ever reached the page.
 *
 * What limits that exposure today — verified, not assumed:
 *
 *   - The application renders model output as `{message.content}`, ordinary JSX
 *     text interpolation, which React escapes.
 *   - There is no `dangerouslySetInnerHTML` anywhere in the codebase.
 *
 * So there is no known injection path; CSP here is defence in depth against a
 * future one. The directives that DO bite are the restrictive ones below:
 * `object-src 'none'`, `base-uri 'self'` and `form-action 'self'` are all
 * enforced with no escape hatch, as is `frame-ancestors` — see the Level 17
 * note on that directive.
 *
 * Tightening to nonces is a worthwhile later change; it is deliberately not
 * bundled into a level whose job is to make the app safe to expose at all.
 *
 * @param frameAncestors  Who may frame the response. Every route keeps Level
 *   16's `'none'`; only `/embed` passes anything else. See `securityHeaders`.
 */
function contentSecurityPolicy(isDev: boolean, frameAncestors: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],

    // 'unsafe-inline' — see the note above.
    // 'unsafe-eval' — development only: React Fast Refresh and the Turbopack
    // dev runtime both evaluate generated code. It is absent in production.
    'script-src': ["'self'", "'unsafe-inline'", ...(isDev ? ["'unsafe-eval'"] : [])],

    // Tailwind v4 ships a static stylesheet, but Next injects inline <style>
    // during streaming and for critical CSS, so this cannot be dropped.
    'style-src': ["'self'", "'unsafe-inline'"],

    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],

    // The browser talks only to this application's own API. Ollama and Supabase
    // are reached by the SERVER, never by the page, so neither belongs here —
    // and listing them would disclose infrastructure addresses to every visitor.
    // ws:/wss: are the dev-server hot-reload socket only.
    'connect-src': ["'self'", ...(isDev ? ['ws:', 'wss:'] : [])],

    // Enforced with no exception. These are the directives doing real work.
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],

    /**
     * Level 16 set this to `'none'` everywhere. Level 17 relaxes it on ONE
     * route and only to a configured list — never to `*`, and never globally.
     *
     * `/embed` receives `WIDGET_ALLOWED_ORIGINS`; every other path, this one
     * included when that variable is unset, still receives `'none'`. That is
     * the entire framing exception the embeddable widget introduces, and it is
     * the minimum that can satisfy "a separate demo website can embed the
     * chatbot": a browser will not render a cross-origin frame without it.
     *
     * What this does NOT do, stated plainly: `frame-ancestors` is enforced by
     * the BROWSER. It stops an unapproved page from displaying our UI. It does
     * nothing about a server calling `/api/chat` directly, which is why origin
     * validation is also enforced server-side in the route.
     */
    'frame-ancestors': [frameAncestors],

    // What THIS application may frame. Unchanged from Level 16 and unrelated
    // to the directive above: the widget frames us, we frame nothing.
    'frame-src': ["'none'"],

    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

interface SecurityHeaderOptions {
  /**
   * Level 17. When true the response omits `X-Frame-Options` and sets
   * `Cross-Origin-Resource-Policy: cross-origin`, because a cross-origin frame
   * cannot load otherwise. Only `/embed` and `/widget.js` pass this.
   */
  framable?: boolean;
  /** Level 17. `frame-ancestors` value. Defaults to Level 16's `'none'`. */
  frameAncestors?: string;
}

/**
 * Headers applied to every response, page and API alike.
 *
 * Measured before Level 16, the application sent no security headers at all
 * and advertised `X-Powered-By: Next.js`.
 */
function securityHeaders(isDev: boolean, options: SecurityHeaderOptions = {}) {
  const { framable = false, frameAncestors = "'none'" } = options;

  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(isDev, frameAncestors) },

    /**
     * Belt and braces with frame-ancestors: the CSP directive is authoritative
     * in modern browsers, this covers anything older.
     *
     * OMITTED for framable routes, and this is a browser limitation rather than
     * a choice. `X-Frame-Options` has exactly two values a browser honours,
     * `DENY` and `SAMEORIGIN`; the third, `ALLOW-FROM`, was removed from every
     * major engine and is ignored where it is parsed at all. There is no value
     * that means "these specific origins", so a header that must permit a
     * cross-origin frame can only be absent. `frame-ancestors` carries the
     * allowlist instead, and it is enforced by every browser that can render
     * the widget in the first place. The cost is precise: a browser too old to
     * implement `frame-ancestors` would frame `/embed` from anywhere.
     */
    ...(framable ? [] : [{ key: 'X-Frame-Options', value: 'DENY' }]),

    // Stops a browser second-guessing Content-Type — the reason an uploaded
    // file served back could otherwise execute as script.
    { key: 'X-Content-Type-Options', value: 'nosniff' },

    // Referrers leak conversation URLs to third parties otherwise.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

    // Nothing here needs a camera, microphone or location.
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    },

    // Ignored by browsers over plain http, so it is safe to send in development
    // and correct the moment the application is served over TLS.
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    },

    // Same-origin isolation. Cheap, and closes cross-origin window handles.
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },

    /**
     * Level 17: `same-origin` is enforced on cross-origin `no-cors` loads, and
     * that includes both a `<script src>` from another site and a nested
     * document. Left at `same-origin`, it would block `/widget.js` and `/embed`
     * outright no matter what `frame-ancestors` said.
     *
     * `cross-origin` is therefore required on exactly those two paths, and it
     * is a genuine relaxation: it means any site may LOAD those two responses.
     * The scope of what that grants is small and worth naming — `/widget.js` is
     * a static loader containing no configuration, and `/embed` is an empty
     * chat shell that stays inert until a `postMessage` from an allowlisted
     * parent unlocks it. Neither carries data, and every other path on this
     * origin keeps `same-origin`.
     */
    {
      key: 'Cross-Origin-Resource-Policy',
      value: framable ? 'cross-origin' : 'same-origin',
    },
  ];
}

const nextConfig: NextConfig = {
  /**
   * Keep `pdf-parse` out of the server bundle.
   *
   * It wraps `pdfjs-dist`, which loads `pdf.worker.mjs` from a path relative to
   * its own package at runtime. Bundling rewrites that layout, so the worker is
   * looked for under `.next/dev/server/chunks/` and every PDF upload fails with
   * "Setting up fake worker failed". Leaving the package external lets Node
   * resolve it from `node_modules` the way the library expects.
   *
   * This never showed up before because Level 6 only ever parsed PDFs from the
   * CLI, which runs in plain Node with no bundler involved. It appeared the
   * moment PDFs started arriving through an HTTP route.
   */
  serverExternalPackages: ["pdf-parse"],

  /**
   * Level 16: stop advertising the framework and its version.
   *
   * Minor on its own — it does not stop anyone determined — but it is free, and
   * naming your stack to every visitor only ever helps somebody else.
   */
  poweredByHeader: false,

  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';

    /**
     * READ AT BUILD TIME, AND THAT IS NOT THE SAME AS AT STARTUP.
     *
     * Next serialises whatever this function returns into
     * `.next/routes-manifest.json` during `next build`; `next start` serves
     * from that manifest and never calls this function again. Verified
     * directly by reading the manifest after a restart with a changed
     * variable — the header did not move.
     *
     * So `WIDGET_ALLOWED_ORIGINS` must be correct when `next build` runs, and
     * changing it requires a REBUILD, not a restart. The server-side half of
     * the allowlist (`/embed` and `/api/chat`) reads the environment per
     * request, so the two can disagree after a restart-without-rebuild:
     *
     *   origin ADDED, not rebuilt    API accepts it, the browser still refuses
     *                                to frame — the widget cannot load. Safe.
     *   origin REMOVED, not rebuilt  the browser still permits the frame, but
     *                                the API refuses every request — the panel
     *                                opens and cannot chat. Also safe, and
     *                                confusing, which is why
     *                                `scripts/verify-widget.ts` compares the
     *                                built manifest against the live
     *                                environment and fails on a mismatch.
     *
     * An invalid entry throws here, which fails the build. Deliberate: a typo
     * that silently disabled the allowlist would be indistinguishable from a
     * widget that simply does not work, and someone would "fix" it by widening
     * the policy.
     */
    const frameAncestors = frameAncestorsValue();

    return [
      /**
       * Level 16, unchanged, for every path EXCEPT `/embed`.
       *
       * The exclusion is a negative lookahead rather than a later override
       * because `/embed` needs `X-Frame-Options` to be ABSENT, and Next's
       * header merging can only replace a key's value — never remove it.
       * Verified against Next's own path-to-regexp: this matches `/`,
       * `/api/chat`, `/widget.js` and `/embedded`, and does not match `/embed`
       * or `/embed/`.
       */
      {
        source: '/((?!embed$|embed/).*)',
        headers: securityHeaders(isDev),
      },

      /**
       * The one framable route. Identical to the set above in every respect
       * except the three things framing requires: no `X-Frame-Options`, a
       * `frame-ancestors` allowlist, and a cross-origin resource policy.
       */
      {
        source: '/embed',
        headers: securityHeaders(isDev, { framable: true, frameAncestors }),
      },

      /**
       * The loader script. Not framable, but it is fetched BY the third-party
       * page, so it needs the same `Cross-Origin-Resource-Policy` relaxation.
       * A later rule for the same key overrides the earlier one, which is all
       * that is needed here — `X-Frame-Options: DENY` is correct on a script
       * and stays.
       */
      {
        source: '/widget.js',
        headers: [{ key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' }],
      },
    ];
  },
};

export default nextConfig;
