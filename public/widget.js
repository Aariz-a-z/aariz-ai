/**
 * AARIZ AI — embeddable chat widget loader.
 *
 * ROADMAP.md Level 17. Drop one tag on any allowlisted site:
 *
 *   <script src="https://your-app.example/widget.js"
 *           data-position="bottom-right"
 *           data-greeting="Ask us anything"
 *           data-title="Ask AARIZ AI"
 *           defer></script>
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 * --------------------------------------------
 * Any server configuration. It is a static asset served to arbitrary websites,
 * so a value placed here is a value published: no Supabase URL, no Ollama
 * address, no keys, no model name, no allowlist. The one address it needs — the
 * application's own origin — is read from this script tag's own `src`, which
 * the host page already knows because it wrote it.
 *
 * ISOLATION
 * ---------
 * The chat runs in an iframe, not in the host page. Nothing here injects the
 * application's CSS or React into somebody else's document, so the widget
 * cannot restyle or break the host page and the host page cannot read the
 * conversation. The only channel between them is `postMessage`, and both ends
 * check the origin of everything they receive.
 *
 * THE MESSAGE PROTOCOL
 * --------------------
 * Mirrored in `src/components/embedded-chat.tsx`; change both together.
 *
 *   parent -> frame   aariz:host-hello   { greeting?: string }
 *   parent -> frame   aariz:open         panel became visible
 *   parent -> frame   aariz:close        panel was hidden
 *   frame  -> parent  aariz:ready        handshake accepted
 *   frame  -> parent  aariz:answer       an answer finished arriving
 *   frame  -> parent  aariz:close        user closed the panel from inside
 *
 * Every `postMessage` names an exact target origin. `'*'` appears nowhere in
 * this file: it would hand the message to whatever document occupies the frame
 * at that moment, which after a navigation is not necessarily the one we
 * checked.
 */

(function () {
  'use strict';

  // Guard against the tag being included twice — two launchers stacked on top
  // of each other is a confusing way to find out.
  if (window.__aarizWidgetLoaded) return;
  window.__aarizWidgetLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      // `document.currentScript` is null inside a module or when the tag is
      // injected by another script. Fall back to finding ourselves by name.
      var all = document.getElementsByTagName('script');
      for (var i = all.length - 1; i >= 0; i--) {
        if (/(^|\/)widget\.js(\?|$)/.test(all[i].src || '')) return all[i];
      }
      return null;
    })();

  if (!script || !script.src) return;

  /**
   * The application's origin, taken from this script's own URL.
   *
   * This is both where the frame is loaded from and the only origin whose
   * messages are accepted below. Deriving it rather than configuring it means
   * there is no way to point the widget at a different backend by editing an
   * attribute on the host page.
   */
  var APP_ORIGIN = new URL(script.src, window.location.href).origin;
  var EMBED_URL = APP_ORIGIN + '/embed';

  var POSITIONS = {
    'bottom-right': { bottom: '20px', right: '20px' },
    'bottom-left': { bottom: '20px', left: '20px' },
    'top-right': { top: '20px', right: '20px' },
    'top-left': { top: '20px', left: '20px' },
  };

  var data = script.dataset || {};
  var position = POSITIONS[data.position] ? data.position : 'bottom-right';
  var greeting = typeof data.greeting === 'string' ? data.greeting.slice(0, 200) : '';
  var title = typeof data.title === 'string' && data.title ? data.title.slice(0, 60) : 'Ask AARIZ AI';

  var MOBILE_BREAKPOINT_PX = 640;
  var PANEL_WIDTH_PX = 384;
  var PANEL_HEIGHT_PX = 560;
  var Z_INDEX = 2147483000; // Below the maximum, so a host page can still go above.

  var isOpen = false;
  var isReady = false;
  var unread = 0;
  var frame = null;

  function isMobile() {
    return window.innerWidth < MOBILE_BREAKPOINT_PX;
  }

  function applyPosition(el) {
    var coords = POSITIONS[position];
    el.style.top = coords.top || 'auto';
    el.style.bottom = coords.bottom || 'auto';
    el.style.left = coords.left || 'auto';
    el.style.right = coords.right || 'auto';
  }

  // --- Launcher -------------------------------------------------------------

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', title);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.style.cssText = [
    'position:fixed',
    'z-index:' + Z_INDEX,
    'width:56px',
    'height:56px',
    'border:0',
    'border-radius:9999px',
    'background:#2563eb',
    'color:#fff',
    'cursor:pointer',
    'box-shadow:0 6px 24px rgba(0,0,0,.24)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'padding:0',
    'font:inherit',
  ].join(';');
  applyPosition(launcher);

  // Inline SVG rather than an image request: one fewer round trip, and no
  // asset for a host page's CSP `img-src` to block.
  launcher.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>' +
    '</svg>';

  var badge = document.createElement('span');
  badge.style.cssText = [
    'position:absolute',
    'top:-2px',
    'right:-2px',
    'min-width:20px',
    'height:20px',
    'padding:0 5px',
    'border-radius:9999px',
    'background:#dc2626',
    'color:#fff',
    'font:600 12px/20px system-ui,-apple-system,Segoe UI,sans-serif',
    'text-align:center',
    'display:none',
    'box-sizing:border-box',
  ].join(';');
  launcher.appendChild(badge);

  function renderBadge() {
    if (unread > 0) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.style.display = 'block';
      launcher.setAttribute('aria-label', title + ' (' + unread + ' unread)');
    } else {
      badge.style.display = 'none';
      launcher.setAttribute('aria-label', title);
    }
  }

  // --- Panel ----------------------------------------------------------------

  var panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'z-index:' + Z_INDEX,
    'display:none',
    'overflow:hidden',
    'background:#fff',
    'border-radius:16px',
    'box-shadow:0 12px 48px rgba(0,0,0,.28)',
  ].join(';');

  function layoutPanel() {
    if (isMobile()) {
      // Full screen on a phone: a 384px panel floating over a 360px viewport
      // is not a usable chat.
      panel.style.inset = '0';
      panel.style.width = 'auto';
      panel.style.height = 'auto';
      panel.style.borderRadius = '0';
    } else {
      panel.style.inset = 'auto';
      applyPosition(panel);
      // Offset past the launcher when both sit at the same corner.
      if (position.indexOf('bottom') === 0) panel.style.bottom = '88px';
      else panel.style.top = '88px';
      panel.style.width = PANEL_WIDTH_PX + 'px';
      panel.style.height = 'min(' + PANEL_HEIGHT_PX + 'px, calc(100vh - 120px))';
      panel.style.borderRadius = '16px';
    }
  }

  function ensureFrame() {
    if (frame) return frame;

    frame = document.createElement('iframe');
    frame.src = EMBED_URL;
    frame.title = title;
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#fff';

    /**
     * Hardening the host page gets for free.
     *
     * `allow-same-origin` is required — without it the frame has an opaque
     * origin, and its relative `fetch('/api/chat')` becomes a cross-origin
     * request that this application (which sends no CORS headers, by design)
     * would refuse.
     *
     * What is deliberately absent matters more: no `allow-top-navigation`, so
     * the widget cannot navigate the page that hosts it, and no
     * `allow-modals`, `allow-downloads` or `allow-pointer-lock`.
     *
     * `allow-forms` IS granted, and the reason is honesty about what was
     * verified. The composer is a `<form>` whose submit handler always calls
     * `preventDefault`, and the HTML specification appears to fire the
     * `submit` event before the sandbox check — so the tighter sandbox would
     * very likely work. "Very likely" is not good enough for the widget's only
     * button, and this environment could not run that specific test (the
     * cross-origin frame is not scriptable from the host page, which is the
     * isolation working as intended). Rather than ship an unverified
     * dependency on specification step ordering, the permission is granted and
     * the exposure is bounded elsewhere: CSP `form-action 'self'` already
     * forbids this document from posting a form anywhere but back to this
     * application, so the permission cannot send anything off-origin.
     *
     * Popups are allowed because a citation opens its source document in a new
     * tab, and they escape the sandbox so that tab is a normal page rather
     * than a crippled one.
     */
    frame.setAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    );

    panel.appendChild(frame);
    return frame;
  }

  // --- Messaging ------------------------------------------------------------

  function post(type, payload) {
    if (!frame || !frame.contentWindow) return;
    var message = { type: type };
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
    }
    // Exact target origin, always.
    frame.contentWindow.postMessage(message, APP_ORIGIN);
  }

  window.addEventListener('message', function (event) {
    // Two checks, and both are needed. The origin says the message came from
    // the application; the source says it came from OUR frame and not from
    // some other window that happens to be served by the same application.
    if (event.origin !== APP_ORIGIN) return;
    if (!frame || event.source !== frame.contentWindow) return;

    var body = event.data;
    if (!body || typeof body !== 'object') return;

    /**
     * The frame finished hydrating and is now listening.
     *
     * This is the signal that removes the race rather than papering over it:
     * the parent cannot observe hydration inside a cross-origin document, so
     * the frame says when it is ready and we greet it immediately instead of
     * guessing with timers.
     */
    if (body.type === 'aariz:frame-ready') {
      if (isOpen && !isReady) sendHello();
      return;
    }

    if (body.type === 'aariz:ready') {
      isReady = true;
      stopHandshake();
      // Only now is the frame listening, so this is the first `open` it can
      // actually receive.
      if (isOpen) post('aariz:open');
      return;
    }

    if (body.type === 'aariz:answer') {
      // The frame reports that an answer arrived; only this side knows whether
      // anyone could see it.
      if (!isOpen) {
        unread++;
        renderBadge();
      }
      return;
    }

    if (body.type === 'aariz:close') {
      close();
    }
  });

  // --- Handshake ------------------------------------------------------------

  /**
   * The handshake RETRIES, and that is not belt-and-braces — it is the only
   * thing that makes it work.
   *
   * The obvious implementation sends `host-hello` from the iframe's `load`
   * event. That was the first version of this file, and it silently failed
   * every time: `load` fires when the frame's document and subresources have
   * arrived, which is BEFORE React hydrates inside it and attaches the
   * `message` listener that would hear us. The message was posted into a
   * document that was not yet listening and was simply dropped. Worse, `load`
   * never fires a second time, so reopening the panel could not recover.
   *
   * Proven rather than reasoned about: posting the same `host-hello` by hand
   * from the console, seconds after load, produced the `aariz:ready` reply
   * immediately.
   *
   * The real fix is `aariz:frame-ready`: the frame announces itself the moment
   * its listener exists, and we greet it then. This polling loop is the
   * FALLBACK for the one case that signal cannot cover — a host page sending
   * `Referrer-Policy: no-referrer`, which leaves the frame with no origin it
   * is allowed to address.
   *
   * THE WINDOW IS LONG AND THE INTERVAL BACKS OFF, and both were corrected
   * against measurement. The first version polled every 200ms and gave up
   * after 8 seconds; on the reference machine a COLD production start did not
   * finish hydrating within that window, the loop expired, and the widget
   * silently never connected — while a hello posted by hand a moment later was
   * answered instantly. A fixed short cap encodes an assumption about someone
   * else's hardware. Backing off to two seconds over a minute costs about
   * thirty messages instead of three hundred and survives a slow first load.
   *
   * A cap still exists, because a frame that a browser refused on
   * `frame-ancestors` will never answer and must not leave a timer running for
   * the life of the host page.
   */
  var HANDSHAKE_MIN_INTERVAL_MS = 200;
  var HANDSHAKE_MAX_INTERVAL_MS = 2000;
  var HANDSHAKE_WINDOW_MS = 60000;
  var handshakeTimer = null;
  var handshakeInterval = HANDSHAKE_MIN_INTERVAL_MS;
  var handshakeDeadline = 0;

  function stopHandshake() {
    if (handshakeTimer !== null) {
      window.clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  /**
   * Greet the frame once.
   *
   * The greeting travels with the handshake rather than in the frame URL: it
   * keeps arbitrary host text out of a URL, and the frame will only accept it
   * from an origin it has already checked.
   */
  function sendHello() {
    post('aariz:host-hello', greeting ? { greeting: greeting } : null);
  }

  function startHandshake() {
    stopHandshake();
    handshakeInterval = HANDSHAKE_MIN_INTERVAL_MS;
    handshakeDeadline = Date.now() + HANDSHAKE_WINDOW_MS;

    var attempt = function () {
      if (isReady || Date.now() > handshakeDeadline) {
        stopHandshake();
        return;
      }
      sendHello();
      handshakeInterval = Math.min(handshakeInterval * 1.5, HANDSHAKE_MAX_INTERVAL_MS);
      handshakeTimer = window.setTimeout(attempt, handshakeInterval);
    };

    attempt();
  }

  // --- Open / close ---------------------------------------------------------

  function open() {
    if (isOpen) return;
    isOpen = true;

    ensureFrame();
    layoutPanel();
    panel.style.display = 'block';
    launcher.setAttribute('aria-expanded', 'true');
    if (isMobile()) launcher.style.display = 'none';

    unread = 0;
    renderBadge();

    if (isReady) post('aariz:open');
    else startHandshake();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    // A frame that never answered is not going to start now that it is hidden.
    stopHandshake();
    panel.style.display = 'none';
    launcher.style.display = 'flex';
    launcher.setAttribute('aria-expanded', 'false');
    post('aariz:close');
    launcher.focus();
  }

  launcher.addEventListener('click', function () {
    if (isOpen) close();
    else open();
  });

  // Escape closes, the way every other overlay on the web does.
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen) close();
  });

  // Rotating a phone or dragging a desktop window across the breakpoint has to
  // re-lay-out, or the panel is left sized for the wrong form factor.
  window.addEventListener('resize', function () {
    if (isOpen) {
      layoutPanel();
      launcher.style.display = isMobile() ? 'none' : 'flex';
    }
  });

  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    renderBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
