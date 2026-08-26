/**
 * GET /api/health — Level 23.
 *
 * ROADMAP.md Level 23 specifies the shape exactly:
 *
 *     { "ok": true, "llm": "available/unavailable", "database": "available/unavailable" }
 *
 * and adds "Do not expose secrets." Those three fields are the entire response.
 * No version, no uptime, no hostname, no model name, no upstream error, no
 * addresses — see the note in `src/lib/health.ts` for why a public endpoint is
 * the wrong place to be helpful.
 *
 * WHY IT ANSWERS 200 EVEN WHEN A DEPENDENCY IS DOWN
 * -------------------------------------------------
 * The obvious convention is 503 when unhealthy, so an orchestrator can pull
 * the instance. That convention is wrong for THIS architecture, and the reason
 * is concrete: Ollama runs as a separate process, frequently on a separate
 * machine (docs/DEPLOYMENT.md Mode A). Restarting or replacing the Next
 * process does not start a stopped Ollama — it just destroys a web server that
 * was working, along with the in-memory Level 14 rate-limit counters and the
 * Level 18 metrics, and then does it again on the next check.
 *
 * So the HTTP status answers "is the application serving?" — it is, that is
 * why you got a reply — and the BODY answers "are its dependencies healthy?".
 * A monitor should alert on `ok: false`, not on the status code. This is
 * documented beside the endpoint in docs/DEPLOYMENT.md so nobody wires it up
 * the other way by habit.
 *
 * NOT RATE LIMITED, AND THAT IS DELIBERATE
 * ----------------------------------------
 * A throttled health check is a false alarm: the monitor cannot tell a 429
 * from an outage, so protecting this route with the Level 14 token bucket
 * would manufacture the incidents it exists to detect. The abuse this would
 * otherwise enable — using a cheap public endpoint to amplify load onto Ollama
 * and Postgres — is closed at the source instead, by the probe cache in
 * `src/lib/health.ts`: upstreams see at most one probe per interval however
 * often this is called.
 */

import { checkHealth } from '@/lib/health';
import { rejectPreflight } from '@/lib/security-headers';

// Must reach a local Ollama, which the Edge runtime cannot do; and a cached
// health report is still a live reading, so it must never be statically built.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const report = await checkHealth();

  return Response.json(report, {
    status: 200,
    headers: {
      // A cached health check is a lie about the present. The short in-process
      // cache is bounded and deliberate; an intermediary's cache is not.
      'cache-control': 'no-store, must-revalidate',
    },
  });
}

/**
 * Level 16: refuse CORS preflight explicitly, as every other route does.
 *
 * A monitor sends no `Origin` and is unaffected. A browser page on another
 * origin cannot read this response, which is correct — dependency status is
 * operational information, and there is no reason for a foreign page to have
 * it.
 */
export async function OPTIONS(): Promise<Response> {
  return rejectPreflight();
}
