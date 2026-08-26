/**
 * Level 10 — frozen evaluation fixture for reranking.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * ROADMAP.md Level 10 says reranking is done when "retrieval quality improves
 * on the evaluation dataset". That dataset (`evals/questions.jsonl`) is a
 * Level 11 artifact and does not exist yet, so Level 10 has to measure against
 * something of its own.
 *
 * Authoring both the reranker and its yardstick is a conflict of interest: it
 * is trivially easy to shape the questions around whatever the reranker happens
 * to do well. Three things guard against that:
 *
 *   1. This file was written and completed BEFORE any reranker code existed,
 *      and was not edited afterwards.
 *   2. It lives apart from both the reranker and the assertions, so tweaking it
 *      to rescue a failing run would be a visible, deliberate act rather than
 *      an incidental edit inside the test.
 *   3. It contains queries reranking is expected to gain nothing on — the
 *      plain semantic lookups Level 9 already answers correctly. The metric can
 *      therefore detect damage, not only improvement.
 *
 * This is a RETRIEVAL-quality fixture only: which chunks come back, and in what
 * order. Answer correctness, latency and failure rate are Level 11 measures and
 * are deliberately absent.
 *
 * WHY THE CORPUS LOOKS LIKE THIS
 * ------------------------------
 * Twelve pages of one fictional platform handbook. They are deliberately hard
 * in the way real corpora are hard, rather than hard in a way that flatters any
 * particular ranking method:
 *
 *   - Every page is the same genre, register and topic area (platform
 *     operations), so embeddings place them close together.
 *   - Pages cross-reference each other, so a query's vocabulary is scattered
 *     across several documents instead of sitting in exactly one.
 *   - Facts collide on purpose: "90 days" is both a log retention period and a
 *     feature-flag deadline; "timeout" is a request setting in one page and a
 *     connection-pool setting in another.
 *
 * No document contains a rare token that uniquely gives away its answer. That
 * was the Level 9 corpus's job and it is not repeated here.
 */

export interface FixtureDocument {
  slug: string;
  title: string;
  body: string;
}

export interface FixtureQuery {
  query: string;
  /** Slug of the document that actually contains the answer. */
  expectSlug: string;
  /**
   * `semantic`  — ordinary natural-language question. Level 9 hybrid search
   *               already handles these; reranking must not damage them.
   * `lexical`   — exact terminology lifted from the page, where wording matters
   *               more than paraphrase.
   * `colliding` — a fact that appears in more than one page, where the ranking
   *               has to pick the page the question is actually about.
   */
  kind: 'semantic' | 'lexical' | 'colliding';
  label: string;
}

export const FIXTURE_CORPUS: FixtureDocument[] = [
  {
    slug: 'retry-backoff',
    title: 'Retry and Backoff Policy',
    body: `Outbound calls that fail with a transient error are retried automatically. The client makes at most five attempts in total, counting the original call. Delays follow exponential backoff with full jitter, starting from a base delay of 250 milliseconds, so two clients that fail at the same moment do not retry in lockstep and re-create the load that caused the failure.

Only transient failures are retried. Connection resets, gateway errors and responses carrying a Retry-After header qualify. A validation error does not, because repeating a malformed request cannot succeed and only consumes the tenant's rate limit allowance.

Retries interact with timeouts: each attempt gets the full read timeout, so the worst-case wall time for a call is roughly five times the read timeout plus the accumulated backoff. Services with a tight latency budget should lower the attempt count rather than shorten the timeout.

Requests that change state must carry an idempotency key before retrying is safe. Without one, a retry after a partial success can duplicate the effect of the original call. Webhook delivery uses its own retry schedule and does not follow this policy.`,
  },
  {
    slug: 'timeouts',
    title: 'Timeout Configuration',
    body: `Every outbound HTTP client is configured with two separate timeouts. The connect timeout is two seconds and covers establishing the TCP connection and completing the TLS handshake. The read timeout is thirty seconds and covers waiting for the response once the request has been sent.

The two are deliberately different. A connection that cannot be established within two seconds usually indicates the remote host is down or unreachable, and waiting longer only delays the failure. A slow response, by contrast, is often a large or expensive query that will complete, so the read timeout is generous.

Timeouts are enforced per attempt, not per call. A request that is retried therefore experiences the read timeout once per attempt, which is why the retry policy limits the number of attempts.

These values are request timeouts. They are unrelated to the database connection pool's idle timeout, which governs how long an unused pooled connection is kept open and is documented separately.`,
  },
  {
    slug: 'rate-limits',
    title: 'API Rate Limits',
    body: `Each tenant may send six hundred requests per minute across all endpoints. The limit is enforced with a token bucket that refills continuously, plus a burst allowance of fifty requests so short spikes are not rejected outright.

Exceeding the limit returns HTTP 429 with a Retry-After header giving the number of seconds until capacity is available. Clients must honour that header. Retrying immediately is counted against the same bucket and extends the period during which the tenant is throttled.

Limits are per tenant, not per API key. Issuing additional keys does not increase throughput, and splitting traffic across keys to evade the limit is a violation of the acceptable use policy.

Bulk operations should use the batch endpoints, where one request carries many items and consumes a single token. A tenant that consistently needs more than the standard allowance can request an increase, which is reviewed against capacity rather than granted automatically.`,
  },
  {
    slug: 'queue-drain',
    title: 'Queue Drain Procedure',
    body: `A worker must be drained before it is restarted or removed from service. Draining stops the worker accepting new jobs while allowing the jobs it has already claimed to finish.

The reason is that claimed jobs are held in the worker's memory, not written back to the queue until they complete or fail. Restarting a worker that still holds claimed jobs discards them silently. They are not retried, because from the queue's point of view they were never returned, and nothing reports an error.

To drain, send SIGTERM and wait. The worker stops polling, finishes outstanding jobs and exits on its own. The grace period is ten minutes, after which the process is terminated and any remaining work is lost.

If a drain does not complete within the grace period, escalate rather than forcing the restart. The on-call runbook covers who to contact and when. Never combine a drain with a deployment during a freeze window.`,
  },
  {
    slug: 'webhooks',
    title: 'Webhook Delivery Guarantees',
    body: `Webhooks are delivered at least once. A given event can therefore arrive more than once, and receivers must be able to tolerate duplicates. This is a deliberate choice: guaranteeing exactly-once delivery across a network partition is not possible, and at-least-once with receiver-side deduplication is the honest alternative.

Every delivery carries a dedupe key in the request headers. The key is stable across redeliveries of the same event, so a receiver that records recently seen keys can discard repeats. The key is not the event identifier, because a single event may be delivered to several endpoints.

Failed deliveries are retried on their own schedule for up to twenty-four hours, with the interval widening after each attempt. This is separate from the general retry and backoff policy, which governs outbound API calls rather than webhook fan-out. After twenty-four hours the delivery is abandoned and the endpoint is marked unhealthy.

Receivers must respond within ten seconds. A slow endpoint is treated as a failed delivery and retried, which is a common cause of unexpected duplicates.`,
  },
  {
    slug: 'idempotency',
    title: 'Idempotency Keys',
    body: `Any request that creates or modifies state should carry an idempotency key. The server records the key together with the response it produced, so a repeat of the same request returns the original response instead of performing the work twice.

Keys are retained for forty-eight hours. After that the record is discarded and an identical request is treated as new work. Clients that retry beyond that window must therefore be prepared for the request to take effect a second time.

A key must be unique to the logical operation, not to the attempt. Generating a fresh key per retry defeats the mechanism entirely, which is the most common misuse. Reusing a key for a genuinely different request is rejected with a conflict error rather than silently returning the wrong cached response.

Idempotency keys are what make the retry and backoff policy safe for state-changing calls. They are unrelated to the webhook dedupe key, which is generated by the platform rather than the client and solves the mirror-image problem on the receiving side.`,
  },
  {
    slug: 'oncall',
    title: 'On-Call Rotation and Escalation',
    body: `The primary on-call engineer acknowledges pages and decides whether an incident needs wider involvement. Rotations run for one week and hand over on Wednesday morning, so a weekend incident is never inherited by someone who has just come on shift.

An unacknowledged page escalates to the secondary after fifteen minutes. If the secondary also does not acknowledge, the page goes to the engineering manager. Escalation is automatic and is not a judgement about the primary; it exists so that a sleeping phone cannot stall a response.

The primary is expected to acknowledge, not to resolve. Pulling in the people who know the system is the correct response to an unfamiliar alert, and is explicitly preferred over spending the first thirty minutes reading unfamiliar code.

Severity determines who else is involved and how quickly, and is defined separately. Procedures such as draining a queue before restarting a worker are covered in their own runbooks.`,
  },
  {
    slug: 'deploy-freeze',
    title: 'Deployment Freeze Windows',
    body: `Deployments to production are frozen from the twentieth of December to the second of January. The freeze exists because staffing is thin over the holiday period and the people who understand a given service may not be reachable to help if a release goes wrong.

During a freeze only two categories of change may ship: fixes for active customer-facing incidents, and security patches rated high or critical. Both require approval from the on-call engineering manager, recorded in the change log before the deployment rather than afterwards.

Teams should plan for the freeze rather than race it. A release pushed out on the nineteenth of December to beat the deadline carries all the risk the freeze is designed to avoid, with the additional problem that nobody will be watching it. Anything not ready by the middle of the month should wait for January.

A shorter freeze also applies around major public holidays and during large customer events, announced at least two weeks in advance.`,
  },
  {
    slug: 'retention',
    title: 'Data Retention Schedule',
    body: `Application logs are retained for ninety days. This covers the great majority of investigations, which look at events from the last few weeks, while keeping storage cost bounded.

Distributed traces are retained for fourteen days. Traces are far larger per request than logs, and their value falls away quickly once an incident has been diagnosed, so a shorter window is the right trade.

Audit records are kept for seven years. These are the records of who changed what, and the retention period is set by regulatory obligation rather than by engineering preference. Audit records cannot be deleted early, including at a customer's request.

Customer content is deleted within thirty days of account closure, apart from anything the audit obligation requires us to keep. Backups are purged on their own cycle, so content may persist in a backup for up to a further thirty days before it is fully removed.`,
  },
  {
    slug: 'severity',
    title: 'Incident Severity Definitions',
    body: `A SEV1 is a customer-facing outage affecting more than one tenant. Complete unavailability of a core service, data loss, and a confirmed security breach are all SEV1 regardless of how many tenants are affected. A SEV1 pages the on-call engineer immediately and requires a written update to stakeholders every thirty minutes.

A SEV2 is a significant degradation that customers can notice but work around, such as elevated error rates or a feature that is unavailable while the rest of the product functions. It pages during working hours and is picked up the next morning otherwise.

A SEV3 covers problems with no customer impact, including internal tooling failures and alerts that fire without a corresponding symptom. These are handled as ordinary work.

Severity is assigned by the responder and can be revised in either direction as understanding improves. Raising a severity late is common and is not treated as a mistake; the cost of under-reacting is higher than the cost of briefly over-reacting.`,
  },
  {
    slug: 'connection-pool',
    title: 'Database Connection Pooling',
    body: `Each application instance keeps a pool of twenty database connections. The size is a deliberate compromise: the database accepts a bounded number of connections in total, and twenty per instance allows the service to scale to its expected instance count without exhausting that budget.

An idle connection is closed after ten minutes. The idle timeout keeps a pool that grew during a traffic spike from holding connections open indefinitely once the spike has passed. This is a pool setting and has nothing to do with the request timeouts applied to outbound HTTP calls, despite the similar name.

When every connection is in use, further queries wait for one to be returned. The wait is capped at five seconds, after which the query fails rather than queueing indefinitely. A service that regularly hits this cap is usually holding connections across slow external calls, which is the pattern to fix rather than raising the pool size.

Long-running analytical queries must not use the application pool. They have a separate read-only pool with a much longer statement timeout, so that an expensive report cannot starve ordinary request traffic of connections.

Transactions should be short. A connection is held for the whole transaction, so wrapping an external API call inside one occupies a pooled connection for the duration of that call. Where work must span several steps, prefer several short transactions with an idempotency key over one long transaction.`,
  },
  {
    slug: 'feature-flags',
    title: 'Feature Flag Lifecycle',
    body: `A feature flag must be removed within ninety days of reaching full rollout. Flags are a delivery mechanism, not a permanent configuration surface, and one that outlives its rollout becomes a branch in the code that nobody tests.

Every flag is created with an owner and an expiry date. The expiry is not a hard cut-off that disables the feature; it is the date at which the flag is reported as overdue and appears on the owning team's cleanup list. Removing a flag means deleting the flag, the dead branch, and the tests that covered the disabled path.

Flags are evaluated locally from a snapshot refreshed every thirty seconds. Evaluation therefore never makes a network call and never fails, and a flag change takes up to thirty seconds to take effect everywhere. Code must not assume a flag change is instantaneous.

Flag removals are ordinary deployments and are subject to the deployment freeze. A flag that expires in late December will be reported as overdue and should be cleaned up in January rather than shipped during the freeze.

Kill switches are a separate category and are exempt from the ninety-day rule, provided they are documented as kill switches when created and reviewed each quarter.`,
  },
];

/**
 * Sixteen queries, fixed before the reranker was written.
 *
 * Twelve are plain questions of the kind a user actually asks; four use exact
 * terminology from the page. Several are answerable only by picking between two
 * pages that both discuss the topic, which is where a ranking method's quality
 * actually shows.
 */
export const FIXTURE_QUERIES: FixtureQuery[] = [
  // --- Ordinary semantic questions -----------------------------------------
  {
    query: 'How many times will a failed request be retried?',
    expectSlug: 'retry-backoff',
    kind: 'semantic',
    label: 'retry attempt count',
  },
  {
    query: 'How long does the client wait for a response before giving up?',
    expectSlug: 'timeouts',
    kind: 'semantic',
    label: 'read timeout',
  },
  {
    query: 'How many requests per minute is a single tenant allowed to send?',
    expectSlug: 'rate-limits',
    kind: 'semantic',
    label: 'rate limit',
  },
  {
    query: 'What has to happen before a worker process is restarted?',
    expectSlug: 'queue-drain',
    kind: 'semantic',
    label: 'drain before restart',
  },
  {
    query: 'Can the same event be delivered to a receiver more than once?',
    expectSlug: 'webhooks',
    kind: 'semantic',
    label: 'at-least-once delivery',
  },
  {
    query: 'How long until an unacknowledged page is escalated to someone else?',
    expectSlug: 'oncall',
    kind: 'semantic',
    label: 'escalation delay',
  },
  {
    query: 'When does the end-of-year change freeze run?',
    expectSlug: 'deploy-freeze',
    kind: 'semantic',
    label: 'freeze window',
  },
  {
    query: 'What makes an incident the most severe category?',
    expectSlug: 'severity',
    kind: 'semantic',
    label: 'SEV1 definition',
  },

  // --- Colliding facts: two pages plausibly answer, one actually does -------
  {
    query: 'How long is an unused database connection kept open?',
    expectSlug: 'connection-pool',
    kind: 'colliding',
    label: 'idle timeout vs request timeouts',
  },
  {
    query: 'How long do we keep distributed traces?',
    expectSlug: 'retention',
    kind: 'colliding',
    label: 'trace retention vs log retention',
  },
  {
    query: 'How long after a full rollout must a feature flag be deleted?',
    expectSlug: 'feature-flags',
    kind: 'colliding',
    label: 'ninety days: flags vs log retention',
  },
  {
    query: 'How long is a key kept before a repeat request counts as new work?',
    expectSlug: 'idempotency',
    kind: 'colliding',
    label: 'idempotency key vs webhook dedupe key',
  },

  // --- Exact terminology ----------------------------------------------------
  {
    query: 'dedupe key',
    expectSlug: 'webhooks',
    kind: 'lexical',
    label: 'dedupe key',
  },
  {
    query: 'full jitter',
    expectSlug: 'retry-backoff',
    kind: 'lexical',
    label: 'full jitter',
  },
  {
    query: 'SEV3',
    expectSlug: 'severity',
    kind: 'lexical',
    label: 'SEV3',
  },
  {
    query: 'token bucket burst allowance',
    expectSlug: 'rate-limits',
    kind: 'lexical',
    label: 'token bucket',
  },
];
