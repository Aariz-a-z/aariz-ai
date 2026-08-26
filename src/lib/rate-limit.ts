/**
 * Level 14 — abuse protection.
 *
 * ROADMAP.md Level 14: "Prevent one person from consuming all available
 * resources… Because the LLM is self-hosted, rate limiting is especially
 * important."
 *
 * That last sentence is the whole design constraint. There is no elastic
 * capacity behind this application: inference runs on the same two cores that
 * serve HTTP, and Level 11 measured a single answer taking a mean of ~31
 * seconds. One caller issuing requests in a loop does not raise a bill, it
 * makes the service unusable for everyone. The concurrency limiter below is
 * therefore the load-bearing control, and the per-caller counters are what stop
 * one person monopolising the queue.
 *
 * IN-MEMORY, AND WHAT THAT COSTS
 * ------------------------------
 * State lives in this process and nowhere else. Two consequences, both real:
 *
 *   1. Counters RESET WHEN THE SERVER RESTARTS. A caller who has exhausted
 *      their budget gets a fresh one after a redeploy.
 *   2. Counters DO NOT COORDINATE ACROSS INSTANCES. Run two copies behind a
 *      load balancer and the effective limit doubles.
 *
 * This is a deliberate trade, not an oversight. The deployment is one Next.js
 * process beside one Ollama, and a shared store would mean Redis (excluded by
 * Roadmap Rule 9) or a database round trip on every request — real latency to
 * solve a problem this topology does not have. Concurrency limiting could not
 * be shared anyway: it gates *this* machine's inference. If the architecture
 * ever becomes multi-instance, a shared store belongs with that change.
 *
 * There is deliberately NO test-environment bypass. The limiter is configured,
 * never skipped — a code path that disables protection when it thinks it is
 * being tested is a code path that can be reached in production.
 */

import { log } from './log.ts';

/**
 * Which budget a request draws from. Costs differ by orders of magnitude.
 *
 * `widget` is Level 17 and is the one category NOT keyed to a caller — see
 * `widgetIdentity` below for why, and for what that costs.
 */
export type LimitCategory = 'chat' | 'upload' | 'auth' | 'read' | 'widget';

/**
 * Defaults, in requests per window.
 *
 * Sized against measured cost rather than guessed: a chat turn is ~31 s of
 * fully-occupied CPU (Level 11), an upload is extraction plus one embedding
 * call per chunk, and a read is a single indexed query. Sixty chat turns an
 * hour for a signed-in user is roughly half an hour of solid inference — a
 * generous allowance on this hardware, and still a bound.
 */
const DEFAULTS = {
  windowSeconds: 3_600,
  chat: { anonymous: 10, authenticated: 60 },
  upload: { anonymous: 0, authenticated: 20 },
  auth: { anonymous: 10, authenticated: 10 },
  read: { anonymous: 120, authenticated: 300 },
  /**
   * Level 17. Per allowlisted embedding SITE, not per visitor — the widget has
   * no cookie to tell visitors apart, so this is a site-wide allowance.
   *
   * 60/hour rather than the anonymous chat figure of 10 because the two are
   * counting different things: 10 bounds one person, 60 bounds an entire
   * website's traffic, and a site whose visitors could only ask ten questions
   * an hour between them would not be a working widget. It remains far below
   * what this machine can serve — two concurrent answers at ~31 s each is
   * roughly 230/hour of theoretical capacity — and the concurrency limiter,
   * not this counter, is what protects the CPU.
   *
   * Both entries are equal because a widget request is always anonymous; the
   * authenticated column is unreachable for this category.
   */
  widget: { anonymous: 60, authenticated: 60 },
  maxConcurrent: 2,
  maxConcurrentAnonymous: 1,
  /** JSON bodies. 128 KB comfortably holds the 24,000-char ceiling Level 3 allows. */
  maxRequestBytes: 128 * 1024,
  generationTokens: { anonymous: 384, authenticated: 512 },
} as const;

export interface RateLimitConfig {
  enabled: boolean;
  trustProxy: boolean;
  windowSeconds: number;
  limits: Record<LimitCategory, { anonymous: number; authenticated: number }>;
  maxConcurrent: number;
  maxConcurrentAnonymous: number;
  maxRequestBytes: number;
  generationTokens: { anonymous: number; authenticated: number };
}

function readInt(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}, received "${raw}".`);
  }
  return parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be "true" or "false", received "${raw}".`);
}

/** Effective configuration. Read per request so tests can vary it in-process. */
export function getRateLimitConfig(): RateLimitConfig {
  return {
    enabled: readBool('RATE_LIMIT_ENABLED', true),
    trustProxy: readBool('RATE_LIMIT_TRUST_PROXY', false),
    windowSeconds: readInt('RATE_LIMIT_WINDOW_SECONDS', DEFAULTS.windowSeconds, 1),
    limits: {
      chat: {
        anonymous: readInt('RATE_LIMIT_CHAT_ANONYMOUS', DEFAULTS.chat.anonymous),
        authenticated: readInt('RATE_LIMIT_CHAT_AUTHENTICATED', DEFAULTS.chat.authenticated),
      },
      upload: {
        anonymous: readInt('RATE_LIMIT_UPLOAD_ANONYMOUS', DEFAULTS.upload.anonymous),
        authenticated: readInt('RATE_LIMIT_UPLOAD_AUTHENTICATED', DEFAULTS.upload.authenticated),
      },
      auth: {
        anonymous: readInt('RATE_LIMIT_AUTH', DEFAULTS.auth.anonymous),
        authenticated: readInt('RATE_LIMIT_AUTH', DEFAULTS.auth.authenticated),
      },
      read: {
        anonymous: readInt('RATE_LIMIT_READ_ANONYMOUS', DEFAULTS.read.anonymous),
        authenticated: readInt('RATE_LIMIT_READ_AUTHENTICATED', DEFAULTS.read.authenticated),
      },
      // One variable, because a widget request is always anonymous.
      widget: {
        anonymous: readInt('RATE_LIMIT_WIDGET', DEFAULTS.widget.anonymous),
        authenticated: readInt('RATE_LIMIT_WIDGET', DEFAULTS.widget.authenticated),
      },
    },
    maxConcurrent: readInt('RATE_LIMIT_MAX_CONCURRENT', DEFAULTS.maxConcurrent, 1),
    maxConcurrentAnonymous: readInt(
      'RATE_LIMIT_MAX_CONCURRENT_ANONYMOUS',
      DEFAULTS.maxConcurrentAnonymous,
      1,
    ),
    maxRequestBytes: readInt('MAX_REQUEST_BYTES', DEFAULTS.maxRequestBytes, 1024),
    generationTokens: {
      anonymous: readInt('GENERATION_MAX_TOKENS_ANONYMOUS', DEFAULTS.generationTokens.anonymous, 1),
      authenticated: readInt(
        'GENERATION_MAX_TOKENS_AUTHENTICATED',
        DEFAULTS.generationTokens.authenticated,
        1,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Token buckets
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Drop buckets nobody has touched for a full window.
 *
 * Without this the map grows once per distinct caller and never shrinks, which
 * would turn the rate limiter into its own slow denial of service. Swept on
 * access rather than on a timer so there is no interval to leak.
 */
let lastSweep = 0;
function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > windowMs) buckets.delete(key);
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until one token is available. Always >= 1 when denied. */
  retryAfterSeconds: number;
  limit: number;
  remaining: number;
}

/**
 * Take one token from `key`'s bucket.
 *
 * A token bucket rather than a fixed window: a fixed window lets a caller spend
 * a whole budget in the last second of one window and the next budget in the
 * first second of the following one, briefly doubling the rate at exactly the
 * moment the machine is least able to absorb it. Continuous refill has no such
 * boundary.
 *
 * Exported for direct testing; routes go through `enforceRateLimit`.
 */
export function consumeToken(key: string, capacity: number, windowSeconds: number): RateLimitDecision {
  if (capacity <= 0) {
    return { allowed: false, retryAfterSeconds: windowSeconds, limit: 0, remaining: 0 };
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1_000;
  sweep(now, windowMs);

  const refillPerMs = capacity / windowMs;
  const bucket = buckets.get(key) ?? { tokens: capacity, lastRefill: now };

  bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.lastRefill) * refillPerMs);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return {
      allowed: true,
      retryAfterSeconds: 0,
      limit: capacity,
      remaining: Math.floor(bucket.tokens),
    };
  }

  buckets.set(key, bucket);
  const msUntilToken = (1 - bucket.tokens) / refillPerMs;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil(msUntilToken / 1_000)),
    limit: capacity,
    remaining: 0,
  };
}

/** Testing helper: forget every bucket. Never called by application code. */
export function resetRateLimitState(): void {
  buckets.clear();
  lastSweep = 0;
  inFlight = 0;
  anonymousInFlight = 0;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

let inFlight = 0;
let anonymousInFlight = 0;

export interface ConcurrencySlot {
  release: () => void;
}

/**
 * Take a slot for a request that is about to occupy the CPU, or null if full.
 *
 * Non-blocking on purpose. Queueing would hold sockets open behind work that
 * already takes ~31 seconds, so a caller would wait minutes and then very
 * likely time out — worse than being told immediately to come back.
 *
 * `release` is idempotent: the chat route releases from a stream's `finally`,
 * which can be reached by completion, error, or client disconnect.
 */
export function acquireSlot(
  isAnonymous: boolean,
  config: RateLimitConfig = getRateLimitConfig(),
): ConcurrencySlot | null {
  if (!config.enabled) return { release: () => {} };

  if (inFlight >= config.maxConcurrent) return null;
  if (isAnonymous && anonymousInFlight >= config.maxConcurrentAnonymous) return null;

  inFlight++;
  if (isAnonymous) anonymousInFlight++;

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      inFlight = Math.max(0, inFlight - 1);
      if (isAnonymous) anonymousInFlight = Math.max(0, anonymousInFlight - 1);
    },
  };
}

/** Current occupancy. Diagnostics and tests only. */
export function concurrencySnapshot(): { inFlight: number; anonymousInFlight: number } {
  return { inFlight, anonymousInFlight };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface LimitIdentity {
  /** Bucket key. Never derived from anything the client can choose freely. */
  key: string;
  isAnonymous: boolean;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Decide whose budget this request spends.
 *
 * Authenticated callers are keyed by the SERVER-VERIFIED user id, passed in by
 * the route from `getServerUser`. No user id is ever read from a body, query
 * string or header for this purpose.
 *
 * For anonymous callers the key depends on whether a client address can be
 * trusted, and this is the honest part:
 *
 *   RATE_LIMIT_TRUST_PROXY=true   X-Forwarded-For is set by a reverse proxy
 *                                 that OVERWRITES it. The leftmost entry is the
 *                                 client and is keyable.
 *
 *   RATE_LIMIT_TRUST_PROXY=false  (default) The header is attacker-controlled
 *                                 and is NOT used — keying on it would let a
 *                                 caller mint a fresh budget per request by
 *                                 varying one header. The server-issued
 *                                 httpOnly session cookie is used instead. That
 *                                 is still evadable by discarding cookies, so
 *                                 per-caller limiting is best-effort here and
 *                                 the CONCURRENCY limit is the real backstop:
 *                                 it counts work in flight, which no header can
 *                                 lie about.
 */
export function resolveIdentity(
  request: Request,
  userId: string | null,
  config: RateLimitConfig = getRateLimitConfig(),
): LimitIdentity {
  if (userId !== null) return { key: `user:${userId}`, isAnonymous: false };

  if (config.trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    const client = forwarded?.split(',')[0]?.trim();
    if (client) return { key: `ip:${client}`, isAnonymous: true };
  }

  const session = readCookie(request, 'aariz_session');
  if (session) return { key: `sid:${session}`, isAnonymous: true };

  // No verifiable identity at all. One shared bucket, which is deliberately
  // harsh: it is the only safe assumption when callers are indistinguishable.
  return { key: 'anonymous:shared', isAnonymous: true };
}

/**
 * Level 17 — the bucket an embedded widget request spends from.
 *
 * WHY THE EMBEDDING ORIGIN, AND NOT THE VISITOR
 * ---------------------------------------------
 * The widget runs in a third-party iframe. Every cookie this application sets
 * is `SameSite=Lax`, so NONE of them is sent there — not the anonymous session
 * cookie, not the auth cookies. `resolveIdentity` would therefore fall all the
 * way through to `anonymous:shared` for every widget user on every site at
 * once, and the whole widget would stop working for everyone after the shared
 * anonymous budget was spent. The embedding origin is the only durable
 * distinction that survives into that context.
 *
 * WHY THIS CANNOT BE TURNED INTO A MEMORY ATTACK
 * ----------------------------------------------
 * `origin` here is NOT a caller's string. It is the entry `resolveWidgetOrigin`
 * matched in `WIDGET_ALLOWED_ORIGINS`, and a request whose claimed origin
 * matches nothing is refused BEFORE this function is reached — no bucket is
 * created for it. So the number of distinct `widget:` keys the bucket map can
 * ever hold equals the number of configured origins, which the operator chose
 * and which `getAllowedWidgetOrigins` caps at 20. Case, port, trailing-slash
 * and punycode variants all canonicalise onto the same entry, so a caller
 * cannot mint a second bucket for one allowed site either. That is the
 * property that makes an origin-keyed bucket safe where a raw client-supplied
 * key would not be.
 *
 * WHAT IT COSTS, PLAINLY
 * ----------------------
 * Every visitor to one allowlisted site shares one bucket, so a single abusive
 * visitor can exhaust that site's hourly allowance for its other visitors. That
 * is unavoidable without an identifier per visitor, which is exactly what the
 * third-party cookie decision rules out. It is bounded harm — one site's
 * widget, for the rest of the window — and the concurrency limiter still stops
 * that visitor from occupying the machine in the meantime.
 */
export function widgetIdentity(origin: string): LimitIdentity {
  return { key: `widget:${origin}`, isAnonymous: true };
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

const FRIENDLY: Record<LimitCategory, string> = {
  chat: 'You have sent a lot of messages in a short time. This assistant runs on a single self-hosted machine, so please wait a moment before asking again.',
  upload: 'You have uploaded several documents in a short time. Please wait a moment before uploading another.',
  auth: 'Too many sign-in attempts. Please wait a moment and try again.',
  read: 'Too many requests in a short time. Please wait a moment and try again.',
  // Deliberately says "this site" and not which one, and never mentions that
  // the budget is shared across the site's visitors — that would tell an
  // abusive visitor exactly what they had achieved.
  widget: 'This site has sent a lot of messages in a short time. Please try again shortly.',
};

/**
 * The 429.
 *
 * Says what to do and nothing else. It does not name which limit fired, how
 * much another caller has consumed, or whether an account exists — for the auth
 * endpoints in particular, a chattier message would help someone confirm which
 * addresses are registered.
 */
export function tooManyRequests(category: LimitCategory, retryAfterSeconds: number): Response {
  return Response.json(
    { error: FRIENDLY[category], retryAfterSeconds },
    {
      status: 429,
      headers: {
        'retry-after': String(retryAfterSeconds),
        'cache-control': 'no-store',
      },
    },
  );
}

/**
 * Reject an oversized body BEFORE it is parsed.
 *
 * `await request.json()` reads the whole body into memory first, so validating
 * afterwards — which is all Level 3 could do — still pays the memory cost of
 * whatever was sent. Checking the declared length first is what makes a large
 * body cheap to refuse.
 *
 * A caller can of course lie about or omit Content-Length; that is why this is
 * one layer among several rather than the whole defence.
 */
export function checkBodySize(request: Request, maxBytes: number): Response | null {
  const declared = request.headers.get('content-length');
  if (declared === null) return null;

  const bytes = Number(declared);
  if (!Number.isFinite(bytes) || bytes <= maxBytes) return null;

  return Response.json(
    {
      error: `Request body is too large (${Math.ceil(bytes / 1024)} KB). Maximum is ${Math.floor(maxBytes / 1024)} KB.`,
    },
    { status: 413, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Apply the per-caller budget for one request.
 *
 * Returns a 429 to send, or null to continue. Routes call this immediately
 * after establishing identity and before doing any real work.
 *
 * `override` exists for Level 17 and for nothing else. A widget request cannot
 * be identified by `resolveIdentity` — it arrives with no usable cookie, so
 * that function would collapse every embedded visitor onto `anonymous:shared`.
 * The chat route passes `widgetIdentity(origin)` instead, where `origin` is an
 * entry the allowlist already matched. It is NOT a hook for a caller to choose
 * its own bucket: nothing reachable from a request body or header can set it.
 */
export function enforceRateLimit(
  request: Request,
  category: LimitCategory,
  userId: string | null,
  config: RateLimitConfig = getRateLimitConfig(),
  override?: LimitIdentity,
): Response | null {
  if (!config.enabled) return null;

  // Resolved after the enabled check, not as a default argument value, so a
  // disabled limiter still does exactly no work.
  const identity = override ?? resolveIdentity(request, userId, config);
  const capacity = identity.isAnonymous
    ? config.limits[category].anonymous
    : config.limits[category].authenticated;

  const decision = consumeToken(`${category}:${identity.key}`, capacity, config.windowSeconds);
  return decision.allowed ? null : tooManyRequests(category, decision.retryAfterSeconds);
}

/** Output ceiling for this caller. Anonymous callers get the smaller budget. */
export function generationTokenLimit(
  isAnonymous: boolean,
  config: RateLimitConfig = getRateLimitConfig(),
): number {
  return isAnonymous ? config.generationTokens.anonymous : config.generationTokens.authenticated;
}

/**
 * Warn when Ollama is configured somewhere other than this machine.
 *
 * ROADMAP.md Level 14: "Do not expose the Ollama server directly to the public
 * internet without appropriate authentication/network controls." Ollama has no
 * authentication of its own — anything that can reach it can use it, and can
 * also enumerate and delete models. This cannot verify what is between here and
 * there, so it warns rather than claiming to have checked.
 *
 * Logged once at startup, server-side. The address is never sent to a client.
 */
let exposureWarned = false;
export function warnIfOllamaLooksExposed(baseUrl: string): void {
  if (exposureWarned) return;
  exposureWarned = true;

  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return;
  }

  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');

  if (isLoopback || isPrivate) return;

  // The host itself is deliberately NOT logged: this line may reach a shared
  // log, and naming the inference endpoint there defeats the point of warning.
  log.warn('security.ollama_non_local', {
    advice:
      'Ollama has no built-in authentication. Keep it on loopback, a private network, ' +
      'or behind an authenticated tunnel — never directly on the public internet.',
  });
}
