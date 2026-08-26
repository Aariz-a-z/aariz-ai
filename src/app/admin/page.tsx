/**
 * Level 18 — the admin dashboard.
 *
 * ROADMAP.md Level 18 requires a page showing document count, ingestion
 * status, conversation count, message volume, failed requests, average
 * latency, retrieval failures and unanswered questions — and says "Do not
 * expose admin information to normal users."
 *
 * A SERVER COMPONENT, AND NO ADMIN API
 * ------------------------------------
 * Level 18 deliberately adds NO new HTTP endpoint. This page reads the
 * in-process metrics and queries the database directly during render, so there
 * is no `/api/admin/*` to authorise, rate limit, or accidentally leave open —
 * the smallest possible increase in attack surface is none at all.
 *
 * The cost is honest and small: refreshing means reloading the page. For an
 * operator page on a single-process deployment that is the right trade against
 * shipping a new public route.
 *
 * WHY A 404 AND NOT A 403
 * -----------------------
 * Every unauthorised case — signed out, signed in but not listed, and nobody
 * configured at all — renders the ordinary not-found page. A 403 would confirm
 * that `/admin` exists and that the visitor simply lacks the rights, which is
 * an invitation. A 404 says only that there is nothing here.
 *
 * WHAT IS DELIBERATELY NOT ON THIS PAGE
 * -------------------------------------
 * No question text, no answer text, no conversation titles, no email
 * addresses, no session ids, no IP addresses. No environment values, no
 * Supabase URL, no keys, and no Ollama address.
 *
 * The MODEL TAG is the one deliberate exception, added at Level 20. Level 18
 * kept it off this page because `LlmProvider.model` is documented server-side
 * only; ROADMAP.md Level 20 then required the admin interface to display
 * "Inference mode / Provider / Model" so that it is obvious no cloud API is
 * being consumed. That is a disclosure to an authenticated, allowlisted
 * administrator on a route that 404s for everyone else — not a leak. It
 * remains absent from the chat UI, the embedded widget, the 404 page and every
 * API response, and `verify-monitoring.ts` asserts that boundary directly.
 */

import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { resolveAdmin } from '@/lib/admin';
import { describeInference } from '@/lib/inference-mode';
import { metricsSnapshot, type LatencySummary } from '@/lib/metrics';
import { getRateLimitConfig } from '@/lib/rate-limit';
import { getSupabaseAdminClient, isSupabaseConfigured } from '@/lib/supabase/server';

// Counts and metrics are live figures; caching them would show an operator a
// snapshot of some earlier moment and give no hint that it was stale.
export const dynamic = 'force-dynamic';

/**
 * A count, or null when it could not be established.
 *
 * Null is NOT rendered as zero. Level 12 established why: a `head`+`count`
 * query against a table PostgREST cannot see resolves with `error === null`
 * and `count === null`, so a missing table would otherwise be displayed as a
 * confident "0 documents" rather than as the failure it is.
 */
type Count = number | null;

async function countRows(table: 'documents' | 'chunks' | 'conversations' | 'messages'): Promise<Count> {
  try {
    const { count, error } = await getSupabaseAdminClient()
      .from(table)
      .select('id', { head: true, count: 'exact' });
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

/** Documents grouped by ingestion status — the roadmap's "ingestion status". */
async function ingestionStatus(): Promise<Record<string, number> | null> {
  try {
    const { data, error } = await getSupabaseAdminClient().from('documents').select('status');
    if (error || data === null) return null;

    const byStatus: Record<string, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
    for (const row of data) {
      const status = typeof row.status === 'string' ? row.status : 'unknown';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    return byStatus;
  } catch {
    return null;
  }
}

/** Messages created in the last 24 hours — the roadmap's "message volume". */
async function recentMessageVolume(): Promise<Count> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await getSupabaseAdminClient()
      .from('messages')
      .select('id', { head: true, count: 'exact' })
      .gte('created_at', since);
    if (error) return null;
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

const nf = new Intl.NumberFormat('en-GB');

function showCount(value: Count): string {
  return value === null ? 'unavailable' : nf.format(value);
}

function showMs(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function showRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-zinc-900 tabular-nums dark:text-zinc-50">
        {value}
      </div>
      {hint !== undefined && (
        <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</div>
      )}
    </div>
  );
}

function LatencyRow({ label, summary }: { label: string; summary: LatencySummary }) {
  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">{label}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{showMs(summary.mean)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{showMs(summary.p50)}</td>
      <td className="py-2 pr-4 text-right tabular-nums">{showMs(summary.p95)}</td>
      <td className="py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">
        {summary.count}
      </td>
    </tr>
  );
}

export default async function AdminPage() {
  // Authorisation first, before a single query runs. A visitor who is not an
  // administrator must not be able to make this page do database work.
  const admin = await resolveAdmin(new Request('http://localhost/admin', { headers: await headers() }));
  if (admin === null) notFound();

  const metrics = metricsSnapshot();
  const limits = getRateLimitConfig();
  const inference = describeInference();

  const configured = isSupabaseConfigured();
  const [documents, chunks, conversations, messages, statuses, recentMessages] = configured
    ? await Promise.all([
        countRows('documents'),
        countRows('chunks'),
        countRows('conversations'),
        countRows('messages'),
        ingestionStatus(),
        recentMessageVolume(),
      ])
    : [null, null, null, null, null, null];

  return (
    <main className="mx-auto w-full max-w-5xl overflow-y-auto px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">AARIZ AI — operations</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Request metrics are held in this server process and reset when it restarts. Counting
          since {metrics.since}.
        </p>
      </header>

      {/*
        Level 20. ROADMAP.md asks the admin interface to display "Inference
        mode / Provider / Model" so that "it is obvious that the chatbot is not
        consuming a cloud AI API". First on the page, because that is the
        question this section exists to answer at a glance.

        This is the one place the model tag is shown. Level 18 deliberately
        kept it off the dashboard, since LlmProvider.model is documented
        server-side-only; Level 20 overrides that for THIS page specifically,
        which is reachable only by an authenticated, allowlisted administrator.
        It is still absent from the chat UI, the widget, the 404 page and every
        API response, and `verify-monitoring.ts` asserts exactly that.
      */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Inference</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Inference mode"
            value={inference.mode}
            hint={
              inference.zeroApiMode
                ? 'ZERO_API_MODE enforced — a cloud provider is refused'
                : 'all local by configuration; ZERO_API_MODE not enforced'
            }
          />
          <Stat label="Provider" value={inference.provider} />
          <Stat label="Model" value={inference.model} />
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Embeddings: {inference.embeddingModel} (local) · Retrieval: Postgres + pgvector ·
          Reranking: {inference.reranking}
          {inference.allLocal
            ? ' — no paid AI API is called on any request path.'
            : ' — this configuration reaches a cloud provider.'}
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Corpus</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Documents" value={showCount(documents)} />
          <Stat label="Chunks" value={showCount(chunks)} />
          <Stat label="Conversations" value={showCount(conversations)} />
          <Stat
            label="Messages"
            value={showCount(messages)}
            hint={`${showCount(recentMessages)} in the last 24h`}
          />
        </div>
        {!configured && (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-500">
            The database is not configured on this server, so corpus counts are unavailable.
          </p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Ingestion status
        </h2>
        {statuses === null ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">unavailable</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['ready', 'processing', 'pending', 'failed'] as const).map((status) => (
              <Stat key={status} label={status} value={nf.format(statuses[status] ?? 0)} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Requests</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={nf.format(metrics.totalRequests)} />
          <Stat
            label="Failed"
            value={nf.format(metrics.failedRequests)}
            hint={showRate(metrics.failureRate)}
          />
          <Stat label="Retrieval failures" value={nf.format(metrics.retrievalFailures)} />
          <Stat
            label="Unanswered"
            value={nf.format(metrics.refusedRequests)}
            hint={`${showRate(metrics.unansweredRate)} of answered`}
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          &quot;Unanswered&quot; counts answers in which the assistant declined for lack of
          grounding. Only the count is kept — no question or answer text is stored anywhere in
          these metrics.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Latency</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <th className="pb-2 text-left font-medium">Stage</th>
                <th className="pb-2 pr-4 text-right font-medium">Mean</th>
                <th className="pb-2 pr-4 text-right font-medium">p50</th>
                <th className="pb-2 pr-4 text-right font-medium">p95</th>
                <th className="pb-2 text-right font-medium">Samples</th>
              </tr>
            </thead>
            <tbody>
              <LatencyRow label="Query embedding" summary={metrics.embedding} />
              <LatencyRow label="Database search" summary={metrics.search} />
              <LatencyRow label="Generation" summary={metrics.generation} />
              <LatencyRow label="Total request" summary={metrics.total} />
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Drawn from the most recent {metrics.sampleCount} of at most {metrics.sampleCapacity}{' '}
          requests.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Load and limits
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/*
            A PEAK, not a live gauge, and for a concrete reason: Next compiles
            this page and the chat route into separate server bundles, so the
            Level 14 counters this page can import are a different instance
            from the ones the route increments — `concurrencySnapshot()` here
            would read a permanent zero. The route records its own occupancy
            into the shared metrics store instead. A peak is the more useful
            number anyway: "did we ever saturate" survives between page loads
            in a way an instantaneous reading does not.
          */}
          <Stat
            label="Peak concurrent"
            value={`${metrics.peakConcurrent} / ${limits.maxConcurrent}`}
            hint={`cap ${limits.maxConcurrentAnonymous} for anonymous callers`}
          />
          <Stat
            label="Mean chunks"
            value={metrics.meanChunks === null ? '—' : String(metrics.meanChunks)}
          />
          <Stat
            label="Mean prompt tokens"
            value={metrics.meanPromptTokens === null ? '—' : nf.format(metrics.meanPromptTokens)}
            hint="approximate"
          />
          <Stat label="Widget requests" value={nf.format(metrics.widgetRequests)} />
        </div>
      </section>
    </main>
  );
}
