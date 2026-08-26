# Deployment Architecture

**ROADMAP.md Level 15 — Local/Public Architecture.**

This document exists to prevent one specific and very common mistake: assuming
that because the chatbot works on your laptop, it will work the same way once
the website is deployed. It will not, and the reason is not a bug.

---

## Scope

**This document covers:** the two deployment topologies, what runs where in
each, which configuration differs between them, and what each mode genuinely
cannot do.

**This document does NOT cover, because those belong to later roadmap levels:**

| Not here | Belongs to |
|---|---|
| CORS, CSP, secure headers, timeout handling, error boundaries | **Level 16 — Public Security** |
| Reverse proxy, TLS termination | **Level 16** (and not named anywhere in `ROADMAP.md`) |
| `GET /api/health`, production env checklist, operational runbook | **Level 23 — Deployment** |
| README with Mermaid diagram, screenshots | **Level 24 — Final README** |
| Docker / Docker Compose | **Not in `ROADMAP.md` at any level** |

Nothing in this document was implemented as part of it. Level 15 is an
architecture and documentation level; it changes no application behaviour.

---

## The problem, stated plainly

### Local development

```
Browser
   ↓
Next.js  (localhost:3000)
   ↓
Ollama   (localhost:11434)
```

Everything is on one machine. `localhost` resolves to that machine, and it
works.

### Public deployment

```
Browser
   ↓
Public Next.js application      (a hosting provider's server)
   ↓
Secure API / backend
   ↓
Publicly reachable inference server
   ↓
Ollama
```

**A remotely hosted frontend cannot reach `http://localhost:11434` on your
computer.** When code running on a hosting provider's server resolves
`localhost`, it resolves to *that provider's* machine — where no Ollama is
running. It is not blocked by a firewall or fixable with a setting; the address
simply refers to somewhere else.

This application defaults `OLLAMA_BASE_URL` to `http://localhost:11434` in two
places — [`src/lib/llm.ts:21`](../src/lib/llm.ts) and
[`src/lib/embeddings.ts:35`](../src/lib/embeddings.ts). That default is correct
for development and wrong for any remote deployment.

---

## Mode A — Portfolio Demo

The application is hosted on a free or low-cost platform so the interface is
publicly visible. **Local Ollama is the development and self-hosted mode; it is
not reachable from Mode A.**

That leaves the deployed app with no model unless one is supplied another way.
There are three honest options. None is chosen here — this is a deployment-time
decision, and each has a real cost.

### Option A1 — Hosted UI plus a separately reachable inference server

`OLLAMA_BASE_URL` points at an inference endpoint you run and expose: a tunnel
to your own machine, or a VPS running Ollama.

**Trade-offs**

- Your machine must be **online and awake** whenever anyone uses the demo.
- Tunnel latency is added to an answer that already takes ~31–39 s (measured
  below), on every request.
- **Ollama has no authentication of any kind.** Anything that can reach the
  endpoint can use the model *and* list, pull or delete installed models. An
  exposed endpoint must sit behind an authenticated tunnel or a proxy that
  requires credentials.
- That authentication layer is **Level 16 work and does not exist yet.** Until
  it does, A1 is not safe to expose publicly.
- The application warns at startup when `OLLAMA_BASE_URL` is neither loopback
  nor a private address — see `warnIfOllamaLooksExposed` in
  [`src/lib/rate-limit.ts`](../src/lib/rate-limit.ts). It warns; it cannot
  verify what sits between the app and the endpoint.

### Option A2 — Hosted UI plus a cloud API

`LLM_PROVIDER=gemini`, with inference from a hosted provider.

**Implemented as of Mode C below.** `LLM_PROVIDER=gemini` now selects Gemini
for generation *and* embeddings. What follows described the state before that
and is kept for the reasoning about cost and embedding dimension, which still
applies:

> `LLM_PROVIDER=gemini is not implemented. The default architecture is self-hosted.`

Implementing that adapter is **Level 19 — Model Switching**. Even once it
exists:

- It costs money per request. The project's "zero per-request AI API cost"
  description would no longer be true of a deployment using it.
- Roadmap Rule 6 forbids *requiring* a paid API in the default architecture, so
  A2 may be an option but must never become a prerequisite.
- Embeddings would also need a decision: retrieval currently uses local
  `nomic-embed-text`, and the stored vectors are 768-dimensional. Changing the
  embedding model invalidates every stored embedding and requires the Level 22
  re-ingestion procedure.

### Option A3 — Hosted UI with chat disabled

The interface is deployed as a visual and architectural demonstration, with
document-grounded chat switched off and clearly labelled as unavailable.

**Trade-offs**

- No inference at all — visitors see the product, not the answers.
- Honest and free, with no machine to keep online and no endpoint to secure.
- The least impressive option, and the only one that is unambiguously safe with
  what exists today.

### What Mode A cannot do, in any option

- Serve more concurrent users than the configured concurrency slots allow
  (default **2**; see below).
- Guarantee availability while the inference machine sleeps, reboots, or loses
  its network connection.
- Provide inference at zero marginal cost. Somebody pays: in electricity and
  uptime (A1), in API charges (A2), or in capability (A3).

---

## Mode B — Fully Self-Hosted

Everything runs on one continuously reachable machine: your own computer, a
dedicated machine, or a future GPU server.

```
Browser
   ↓
Next.js            (this application)
   ↓
Ollama             (llama3.2:3b + nomic-embed-text, same machine)
   ↓
Supabase           (managed Postgres + pgvector, or self-hosted Postgres)
```

### Measured characteristics of this project

These are figures this project actually recorded, not estimates. The reference
machine is an **Intel i3-1115G4 — 2 physical cores / 4 logical threads, 19.7 GB
RAM**, running the models below on CPU.

| Measurement | Value | Source |
|---|---|---|
| Model | `llama3.2:3b` (Q4_K_M) | selected by benchmark at Level 2 |
| Embeddings | `nomic-embed-text`, 768-dimensional | Level 2 / Level 5 |
| Total answer latency | mean **31–39 s** | six Level 11 evaluation runs |
| Time to first token | mean **24–31 s** | same |
| Slowest observed answer | **p95 43–66 s** | same |
| Retrieval latency | **200–320 ms** | Level 11 |
| Embedding | **~1.6 s per chunk** | Level 5 |
| Prompt processing | 115 tok/s, falling to **38 tok/s at ~1000 tokens** | Level 2 |
| Retrieval hit rate | **96.2%** | six consecutive Level 11 runs |

### What those numbers mean for capacity

The default concurrency limit is **2** simultaneous requests occupying the model
(`RATE_LIMIT_MAX_CONCURRENT`), because Ollama serves one request at a time and
queueing behind a ~31 s answer means later callers wait minutes and time out.

So Mode B supports roughly **two concurrent conversations**, not "many users".
A third simultaneous request receives HTTP 429 immediately rather than being
queued. This is a property of the hardware, not a configuration to raise
casually: raising the limit does not create capacity, it only moves the failure
from a clean 429 to a timeout.

### Real, non-optional costs

- The machine must remain **online and awake**. A sleeping laptop is a down service.
- **Bandwidth** matters: answers stream, and uploads are up to 10 MB each.
- **Electricity** is a real, continuous cost.
- **Hardware limits concurrency.** There is no configuration that removes this.

---

## Environment variables by mode

No variable selects the mode. There is deliberately **no `DEPLOYMENT_MODE`
variable** — the mode is a description of where things run, and inventing a flag
would imply the application behaves differently when it does not.

All 33 variables are defined in [`.env.example`](../.env.example). Only these
differ between modes:

| Variable | Mode A | Mode B |
|---|---|---|
| `OLLAMA_BASE_URL` | A1: the reachable endpoint. **Never `localhost`.** A2: unused. A3: unused | `http://localhost:11434` |
| `LLM_PROVIDER` | A1/A3: `ollama`. A2: `gemini` — **not implemented, see above** | `ollama` |
| `NODE_ENV` | `production` | `production` |
| `RATE_LIMIT_*` | the **production values in `.env.example`** | same |
| `RATE_LIMIT_TRUST_PROXY` | `false` until Level 16 adds a proxy | `false` |

Everything else — Supabase URL and keys, model names, retrieval, hybrid search,
reranking, conversation memory, upload and generation limits — is identical in
both modes.

### A deployment hazard worth stating explicitly

`.env.local` in this repository carries **development-generous** rate limits so
the verification suites can run without throttling each other:

```
RATE_LIMIT_CHAT_ANONYMOUS=500      # production default: 10
RATE_LIMIT_CHAT_AUTHENTICATED=500  # production default: 60
RATE_LIMIT_READ_ANONYMOUS=2000     # production default: 120
RATE_LIMIT_READ_AUTHENTICATED=2000 # production default: 300
```

Deploying with those values would leave the service effectively unthrottled.
**Use the production values from `.env.example`.** Rate limiting itself is
genuinely enabled in both files — only the budgets differ, and there is no
test-environment bypass anywhere in the code.

---

## Security and deployment caveats

### Already in place — Level 14

Per-IP and per-user rate limits, a concurrency cap, HTTP 429 with `Retry-After`,
HTTP 413 for oversized bodies checked before parsing, generation-token ceilings,
and the non-local `OLLAMA_BASE_URL` startup warning. Applied to all 13 route
handlers.

### NOT in place — required before public exposure (Level 16)

`ROADMAP.md` Level 16 opens with *"Before exposing the application publicly"*.
The following are **not implemented**:

- CORS restrictions
- Content Security Policy
- Secure headers
- Timeout handling
- Error boundaries
- Structured logging

Neither mode should be exposed to the public internet until Level 16 is done.

### Further caveats

- **Ollama has no authentication.** Anything that can reach it can use the model
  and manage installed models. Never expose port 11434 directly.
- **Auth cookies set `Secure` only when `NODE_ENV=production`**
  ([`src/lib/auth.ts:102`](../src/lib/auth.ts)). Deploying without it sends
  session cookies over plaintext.
- **Per-IP limiting is best-effort while `RATE_LIMIT_TRUST_PROXY=false`.**
  `X-Forwarded-For` is attacker-controlled without a proxy that overwrites it,
  so anonymous callers are keyed on the server-issued session cookie, which a
  caller can discard. **The concurrency limit is the real backstop** — it counts
  work actually in flight, which no header can misrepresent. Setting the flag
  to `true` requires a trusted proxy, which is Level 16.
- **Rate-limit counters are in memory.** They reset on restart and do not
  coordinate across instances; two instances means double the effective limit.
- **`localhost:11434` is defaulted in two modules.** A Mode B misconfiguration
  can half-apply — chat pointing one way and embeddings another.
- **Signing in changes which documents are searchable.** Authenticated users
  retrieve only their own uploads, never the shared CLI-ingested corpus.

---

## Honest claims

Stated directly, because the roadmap requires it:

- **No free hosting provider supplies unlimited GPU inference.** No free tier of
  any hosting platform runs `llama3.2:3b` for you at no cost. If the model runs,
  either you are running it, or somebody is charging for it.
- **`localhost` Ollama is not publicly accessible**, and no configuration makes
  it so. Reaching it from outside requires deliberately exposing it — which,
  given Ollama has no authentication, must not be done without an authenticated
  layer in front.
- **This project is not "unlimited".** It is *self-hosted with no per-request AI
  API cost*, which is a different and smaller claim: capacity is bounded by one
  machine, currently to about two concurrent conversations.
- **There is no magical unlimited free GPU.** Level 21 measured this rather than
  assuming it: Ollama reports **0 MB in VRAM** on the reference machine, with
  7,872 MB of model resident in ordinary system RAM, and CPU at **98.6% across
  all four logical cores** during a generation. The Intel UHD integrated
  graphics is not used for inference. Every token this project produces is
  produced by the CPU, which is exactly why an answer takes tens of seconds and
  why two concurrent conversations is the ceiling. A GPU would change those
  numbers; wishing for one does not.

---

## Health endpoint  (Level 23)

```
GET /api/health   ->   200
{ "ok": true, "llm": "available", "database": "available" }
```

Three fields, and deliberately nothing else. No version, uptime, hostname,
model name, upstream error or address — a health endpoint is the most reliably
unauthenticated route an application has, so everything it returns is returned
to everybody. When a probe fails the *reason* goes to the structured log
(server-side); the public JSON gets one word.

### It returns 200 even when a dependency is down — read the body, not the status

This is the opposite of the usual convention, and the reason is specific to this
architecture. Ollama is a separate process, often on a separate machine
(Mode A). Restarting or replacing the Next process **does not start a stopped
Ollama**. It destroys a web server that was working, along with the in-memory
Level 14 rate-limit counters and Level 18 metrics, and then does it again on the
next check.

So the two questions are answered separately:

| Question | Answered by |
|---|---|
| Is the application serving? | the HTTP status — you got a reply, so yes |
| Are its dependencies healthy? | `ok` in the body |

**Alert on `ok: false`, not on the status code.** Wiring a platform health check
to restart the app on a non-2xx will do nothing useful here.

### It is not rate limited, on purpose

A throttled health check is a false alarm: a monitor cannot tell a 429 from an
outage, so protecting this route with the Level 14 token bucket would
manufacture the incidents it exists to detect. The abuse that would otherwise
enable — using a cheap public endpoint to amplify load onto Ollama and Postgres
— is closed at the source by a short probe cache in
[`src/lib/health.ts`](../src/lib/health.ts): upstreams see at most one probe per
interval however often the endpoint is called. The probe timeout is 2 s,
unrelated to the 120 s generation budget; an upstream that has not answered in
two seconds is not healthy whatever it does at second ninety.

---

## Production environment checklist  (Level 23)

Work down this list before exposing the application. Every item is checkable.

**Secrets**

- [ ] `SUPABASE_SERVICE_ROLE_KEY` is set and appears in **no** `NEXT_PUBLIC_*`
      variable. It bypasses RLS entirely — treat it as a database password.
- [ ] `.env.local` is not committed. `.env.example` carries placeholders only.
- [ ] No secret is passed on a command line, where it lands in shell history.

**Rate limits — the most likely mistake**

- [ ] The `RATE_LIMIT_*` values came from `.env.example`, not from the
      development-generous ones in `.env.local`. See the hazard note above.
- [ ] `RATE_LIMIT_ENABLED=true`.
- [ ] `RATE_LIMIT_TRUST_PROXY` is `true` **only** behind a proxy that
      overwrites `X-Forwarded-For`. Set it true without one and any caller can
      mint a fresh budget per request by varying a header.

**Inference**

- [ ] `OLLAMA_BASE_URL` is not `localhost` in Mode A. A hosting provider
      resolving `localhost` reaches its own machine.
- [ ] If the endpoint is remote, something authenticated sits in front of it.
      **Ollama authenticates nobody**: anything that can reach it can use the
      model and list, pull or delete installed models.
- [ ] `ZERO_API_MODE=true` if local-only inference should be *enforced* rather
      than merely currently true (Level 20).

**Build-time configuration**

- [ ] `WIDGET_ALLOWED_ORIGINS` is correct **before** `next build`. Next bakes
      `headers()` into the routes manifest, so this one needs a rebuild, not a
      restart — unlike every other variable here (Level 17).
- [ ] `ADMIN_EMAILS` names real administrator addresses, not the `.test`
      address the verification suite uses (Level 18).

**Migrations**

- [ ] Every migration in `supabase/migrations/` is applied. The application does
      not apply them and will not warn at startup; it fails at the first request
      that needs the missing table.

**After deploying**

- [ ] `GET /api/health` returns `ok: true`.
- [ ] `GET /` sends a `Content-Security-Policy` and **no** `X-Powered-By`.
- [ ] `/admin` returns 404 when signed out.

---

## Operational runbook  (Level 23)

| Symptom | Most likely cause | What to do |
|---|---|---|
| `health.llm: "unavailable"` | Ollama stopped, or the machine slept | Start `ollama serve`. Nothing in the app fixes this, and restarting the app will not help. |
| `health.database: "unavailable"` | Supabase unreachable, or a migration missing | Check the project is not paused, then confirm migrations are applied. |
| Chat returns 503 | Model server unreachable mid-request | Same as `llm: unavailable`. The 503 is the app reporting honestly, not failing. |
| Chat returns 429 immediately | Level 14 concurrency cap — two requests already occupy the model | Expected under load. Raising the cap does not create capacity; it converts a fast 429 into a slow timeout (Level 21). |
| Every caller gets 429 | Production budgets while a suite runs, or one shared anonymous bucket | Check `RATE_LIMIT_*`. Counters are in-memory and reset on restart. |
| Answers decline questions the documents do cover | Model over-refusal on identifier-led phrasing | Known model behaviour, measured at Level 11 (2–4 of 26 answerable questions). Rephrasing without a leading identifier usually works. |
| Latency roughly doubled | A second request is sharing two CPU cores | Check `/admin` → peak concurrent. Hardware, not configuration. |
| `/admin` 404s for an administrator | `ADMIN_EMAILS` unset, or not the address on the Supabase account | Fail-closed by design. Check the variable and the signed-in address. |
| The widget loads but cannot chat | `WIDGET_ALLOWED_ORIGINS` changed without a rebuild | Rebuild. The browser-facing half is baked at build time, the API half is read per request. |

**Restarting is not free.** The Level 14 rate-limit counters and the Level 18
metrics live in the process. A restart resets both: callers who had exhausted a
budget get a fresh one, and the dashboard starts counting from zero.

---

## Deploying the public demo to Vercel (free tier)

This is **Mode A3** from the top of this document: the interface is public, and
inference is switched off because a Vercel function cannot reach the Ollama on
your machine. `localhost` inside a serverless container *is that container*, so
`OLLAMA_BASE_URL` there is not misconfigured — it is meaningless.

Set `LLM_PROVIDER=disabled` and the application says so plainly instead of
timing out.

### What works and what does not

| Works on Vercel | Does not |
|---|---|
| The full interface, sign-up, sign-in | Chat — refused with 503 and one honest sentence |
| Listing and reading conversations | Document upload — it embeds before storing, so it needs the same model server |
| Listing documents, `/admin`, `/embed` | Retrieval — a query has to be embedded first |
| `/api/health`, every security header | |

Nothing is faked. There are no canned answers and no placeholder text dressed
up as model output — a grounded-answer project that invents one to fill a demo
has thrown away the only thing it was for.

### Serverless changes two real guarantees

Vercel runs each request in a container that may be new and may vanish. Two
Level 14/18 mechanisms depend on a single long-lived process and are genuinely
weaker there. This is stated rather than worked around:

| Mechanism | On one process | On Vercel |
|---|---|---|
| **Rate limiting** (Level 14) | Accurate: one set of counters | **Weaker.** Counters are per-instance, so N instances mean roughly N× the intended budget. Still bounds a single hot instance; no longer a global cap. |
| **Metrics** (Level 18) | Whole process lifetime | **Near-zero.** `/admin` shows only what the instance serving that page happened to see. Corpus counts come from the database and stay correct. |
| **Concurrency cap** (Level 14) | Protects the one Ollama | **Not meaningful** — there is no model to protect in A3. |

The fix for either is shared state (Redis, or a database table), which means a
paid add-on or a write on every request. Neither is in scope for a free demo,
and pretending the in-memory versions behave the same on serverless would be
worse than saying this.

### Steps (dashboard — simpler than the CLI)

1. Push the repository to GitHub.
2. Go to **vercel.com** → **Add New… → Project**.
3. **Import** the GitHub repository.
4. Framework preset: Vercel detects **Next.js**. Leave build command, output
   directory and install command at their defaults — this project needs no
   overrides.
5. Expand **Environment Variables** and add, before the first deploy:

   | Name | Value | Notes |
   |---|---|---|
   | `LLM_PROVIDER` | `disabled` | **Required.** Without it the demo tries to reach a model it cannot have |
   | `SUPABASE_URL` | your project URL | server-only |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service-role key | **bypasses RLS — never prefix `NEXT_PUBLIC_`** |
   | `SUPABASE_ANON_KEY` | your anon key | server-only |
   | `ADMIN_EMAILS` | your address | omit and `/admin` 404s for everyone, which is the safe default |
   | `WIDGET_ALLOWED_ORIGINS` | your Vercel origin | only if you want `/embed` framable; **must be set before the build** |

   Do **not** set `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, or `ZERO_API_MODE`. The
   first two are unreachable and unused; `ZERO_API_MODE` enforces *local* infer‑
   ence and would reject `disabled`.

6. **Deploy**, then open the URL Vercel generates.
7. Verify, in this order:

   ```
   /              interface loads, and states chat is unavailable
   /api/health    {"ok":false,"llm":"unavailable","database":"available"}
   /embed         renders (404 if WIDGET_ALLOWED_ORIGINS is unset — correct)
   /admin         404 signed out; 200 for an ADMIN_EMAILS address
   ```

   `ok: false` is the **correct** result here: there is no model, and the
   endpoint reports rather than flatters.

### CLI alternative

```bash
npm i -g vercel
vercel login
vercel link
vercel env add LLM_PROVIDER production      # enter: disabled
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_ANON_KEY production
vercel --prod
```

No paid plan is required for any of this.

### After deploying

`WIDGET_ALLOWED_ORIGINS` is baked into the routes manifest at build time, so
changing it needs a **redeploy**, not a restart. Every other variable here is
read per request.

Supabase's free tier **pauses a project after about a week of inactivity**. A
paused project shows `database: "unavailable"` and fails sign-in. That is fine
for a demo you open deliberately; it is not a service that stays up unattended.

---

## Mode C — Vercel + Gemini (a working public deployment)

Modes A and B assume the model runs on hardware you control. This one does not:
generation and embeddings both go to Google's API, so the deployment needs no
machine of yours to be awake, and **Ollama is not required in production**.

```
Browser
   ↓
Vercel / Next.js            ← the whole application
   ↓
Supabase                    ← auth, Postgres, pgvector
   ↓
Google Gemini API           ← generation AND embeddings
```

Local development is unchanged: `LLM_PROVIDER=ollama` still uses Ollama for
both, and nothing about that path was modified.

### One switch selects both

`LLM_PROVIDER=gemini` changes generation *and* embeddings together. There is
deliberately no second variable: two would permit Gemini generation with Ollama
embeddings — a combination that works on a laptop, cannot work on Vercel, and
would fail at the first upload rather than at startup.

### Embedding dimension: 768, and no migration

`chunks.embedding` is `vector(768)`, and that width appears in both search
RPCs. The schema, the RPCs and the HNSW indexes are untouched by this mode — no
migration is required.

`gemini-embedding-001` returns **3072** dimensions by default, which the
dimension check in `src/lib/embeddings.ts` would refuse before anything reached
the database. It does not come to that: the adapter **always** sends
`outputDimensionality: 768`, so the truncation happens upstream and the default
configuration works with nothing extra set. `GEMINI_EMBED_DIMENSIONS` exists
only to override that, and should be left unset.

This is belt and braces rather than one mechanism trusted twice — whatever the
API returns is measured against `EMBEDDING_DIMENSION`, so a wrong model produces
a precise error on the first call instead of a corrupted index found later.
Verified against the live API: a real embedding came back with exactly 768
finite components.

### ⚠ Switching providers on a populated corpus requires re-ingestion

**Same width is not the same vector space.** A Gemini vector and a nomic vector
of equal length are not comparable — cosine similarity between them is
meaningless, and a half-migrated index returns confident nonsense.

> **Checked before this deployment: the corpus is empty** — 0 documents,
> 0 chunks, 0 rows staged in `chunks_reindex`. There is nothing to migrate, so
> the first public deployment starts clean and every vector it stores will be
> produced by Gemini. This warning applies to any *later* provider switch, once
> real users have uploaded documents.

If documents already exist when you switch, re-embed them:

```bash
npm run reingest -- --status
npm run reingest -- --build      # embeds every chunk with the NEW provider
npm run reingest -- --validate
npm run reingest -- --promote    # one transaction; no downtime
npm run reingest -- --cleanup
```

The live index keeps answering from the old vectors throughout, and
`promote_reindex` refuses a mixed-provider staging set on its own — the
per-row model guard catches it without you having to notice.

With an empty corpus there is nothing to do.

### Free-tier safety

Two independent layers, both preserved:

| Layer | Scope | Purpose |
|---|---|---|
| **Level 14** (unchanged) | per caller / per site | stops one person monopolising the service |
| **Gemini budget** (new) | the whole application | stops everyone *collectively* exhausting the quota |

`GEMINI_REQUESTS_PER_HOUR` / `GEMINI_REQUESTS_PER_DAY` count **embedding as well
as generation** — one upload can be dozens of embedding calls, so a budget
watching only chat would miss the larger spender. Exhaustion returns **429**
with a friendly message that names no provider or quota, and **nothing retries**:
retrying a rate-limit response is how a small overrun becomes a large one.

**Serverless caveat, stated plainly:** these counters live in the process. On
one long-lived server the budget is a true global cap. On Vercel each instance
keeps its own, so the effective ceiling is roughly the configured number times
the warm instance count. It genuinely bounds a hot instance; it is not an
account-wide guarantee. Google's own quota is the final backstop, and you should
set a billing alert rather than rely on this alone.

**This is not a promise of $0.** It is designed to run within the free tiers of
Vercel, Supabase and Gemini, subject to their quotas and to changes in them.

### Privacy — the trade this mode makes

In Mode B nothing leaves your machine. In Mode C **every question and every
uploaded document is sent to Google**, and the Gemini free tier generally
permits Google to use submitted data to improve its products. That is the
opposite of the project's self-hosted premise and of Level 20's
`ZERO_API_MODE`. It is a legitimate choice for a public demo; it should be a
knowing one, and users should be told if they are uploading anything sensitive.

### Vercel environment variables

Dashboard → Settings → Environment Variables. **All server-only. Never
`NEXT_PUBLIC_`.**

| Variable | Value |
|---|---|
| `LLM_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | your key from aistudio.google.com/apikey |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` |
| `GEMINI_REQUESTS_PER_HOUR` / `_PER_DAY` | e.g. `100` / `500` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` | as in `.env.example` |
| `ADMIN_EMAILS` | your address, or `/admin` 404s for everyone |
| `RATE_LIMIT_TRUST_PROXY` | `true` — **recommended on Vercel**, see below |
| `WIDGET_ALLOWED_ORIGINS` | your Vercel origin — **set before the build** |

> **These two model ids were verified against a live key, and the previously
> documented ones do not exist.** `gemini-2.0-flash` and `text-embedding-004`
> both return 404 — the embedding model has been withdrawn, and a `ListModels`
> call offers only `gemini-embedding-*`. Documentation is a guess until
> something calls the API. If a future id is retired the same way, chat fails
> with `model_not_found` and the fix is this table, not the code.
>
> `gemini-3.5-flash-lite` is chosen over the full flash tier because 3.x flash
> models spend `maxOutputTokens` on internal reasoning before answering —
> measured at 264–367 tokens of a 384 budget, leaving almost nothing for the
> reply. The lite tier uses zero.

**Do not set on Vercel:**

- `OLLAMA_BASE_URL`, `OLLAMA_MODEL` — unreachable from a serverless container
- **`ZERO_API_MODE`** — it enforces *local-only* inference and will **reject
  Gemini with a 500**. Leave it unset in production; keep `true` locally.

### Email delivery — required before real users can sign in

**This is the most likely way a public launch fails, and it fails quietly.**

Supabase projects have "Confirm email" enabled. An account exists the moment
someone signs up, but it cannot sign in until the address is confirmed — and
Supabase refuses an unconfirmed sign-in with the *same* generic error as a wrong
password. That wording is deliberate (distinguishing the two would turn the form
into an account enumerator), but it means an affected user sees only "incorrect
email or password" and retypes a password that was always correct.

The application does what it can about this: sign-up raises a dialog telling the
user to confirm, and the sign-in error names unconfirmed-address as a possible
cause. Neither helps if the email never arrives.

#### The quota is the problem

Supabase's built-in SMTP is for development. It sends a **handful of messages
per hour across the whole project** and is explicitly not for production. That
ceiling was hit during testing on this project without a single real user. Past
it, sign-up fails with `email rate limit exceeded` and no message is sent.

#### Fix: custom SMTP

Supabase Dashboard → **Project Settings → Authentication → SMTP Settings** →
enable **Custom SMTP**, then fill in host, port `587`, username, password and a
sender address. Afterwards raise the cap under **Authentication → Rate Limits →
"Rate limit for sending emails"**, which stays low until you do.

Two free providers work; the difference matters:

| Provider | Free tier | The catch |
|---|---|---|
| **Brevo** | ~300 emails/day | Sends to any address once the account is validated. Best choice without a domain. |
| **Resend** | 3,000/month | Needs a **verified domain**. Without one it only delivers to your own address — which looks like it works in testing and fails for every real user. |

Enter those credentials yourself in the Supabase dashboard. They are secrets,
they belong in no file in this repository, and no `NEXT_PUBLIC_` variable.

#### Verifying it actually works

Sign up with an address **you do not own** — a second personal account, not the
one that already exists. Confirm the message arrives and the link permits
sign-in. Testing with an already-confirmed address proves nothing, because that
account can sign in whether or not mail is being delivered.

#### The alternative, and its cost

Turning "Confirm email" off removes the blocker entirely and lets anyone sign in
immediately. It also lets anyone register an address they do not own. That is a
product decision, it lives in the Supabase dashboard, and it is not something
the application can or should do on its own — see the note in
`scripts/verify-auth.ts` about why the code must never self-confirm an account
to work around a quota.

### Why `RATE_LIMIT_TRUST_PROXY=true` on Vercel

`resolveIdentity` keys anonymous rate limits on the client address only when
this is `true`, because `X-Forwarded-For` is forgeable by default and keying on
a header a caller controls would let anyone mint a fresh budget per request.

Vercel's proxy **overwrites** that header, so on Vercel the leftmost entry is
trustworthy and this should be `true`. Left at `false`, anonymous callers fall
back to the server-issued session cookie — which still separates most visitors,
but lumps every *first* request, before a cookie exists, into one shared bucket.

It is a recommendation, not a change made for you: it is a security-relevant
setting and the choice is yours.

### Redeploy after changing environment variables

`WIDGET_ALLOWED_ORIGINS` is baked into the routes manifest at build time, so it
needs a **redeploy**, not a restart. Every other variable is read per request,
but Vercel applies environment changes to new deployments — trigger one after
editing any of them.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `health.llm: "unavailable"` in Gemini mode | key missing, rejected, or over quota | check `GEMINI_API_KEY`; the reason is in the server log, never in the response |
| Chat returns 500, log says `invalid_configuration` | `ZERO_API_MODE` is set in production | unset it — it forbids non-local providers |
| Chat returns 500 mentioning `GEMINI_API_KEY` | variable not set for the Production environment | add it, then redeploy |
| Everything 429s | the global Gemini budget is spent | wait for the window, or raise `GEMINI_REQUESTS_PER_*` knowingly |
| Retrieval returns nonsense after switching providers | nomic and Gemini vectors mixed | run the re-ingestion cycle above |
| Upload fails with `dimension_mismatch` | embedding model returns ≠ 768 | the adapter already requests 768; check `GEMINI_EMBED_MODEL` is `gemini-embedding-001` |
| Sign-up succeeds, sign-in says the password is wrong | the address was never confirmed | see *Email delivery* below — this is the most likely launch failure |

### Keeping Ollama for local development

Nothing to undo. `.env.local` keeps `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL` and `ZERO_API_MODE=true`; `.env.local` is
git-ignored and never reaches Vercel. The two configurations coexist because
the provider is chosen at runtime from the environment, not compiled in.

---

## Known gaps, flagged not fixed

Recorded here for later levels rather than changed as part of this one.

| Item | Detail | Owner |
|---|---|---|
| `payload1b.json`, `payload3b.json` | Level 10 benchmarking leftovers in the repository root; not git-ignored, so they would be committed | Level 25 (no dead code) |
| `README.md` status line | Claims *"Status: Level 3 of 25"*; fifteen levels are complete | Level 24 |
| Duplicated Ollama default | `http://localhost:11434` defined in both `llm.ts` and `embeddings.ts` | not scheduled |
