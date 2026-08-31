# AARIZ AI

**A retrieval-augmented chatbot that answers questions from your own documents and cites what it used.**

**Status: Completed** · **Live demo: <https://aariz-ai-three.vercel.app>**

Upload documents, ask questions, get answers grounded in the text you supplied — with the
source passages shown beside every reply. It runs against either a local open-source model
(Ollama, no per-question API cost) or a hosted one (Google Gemini), selected by a single
environment variable and with no other code change.

---

## Overview

Most chatbot demos answer from the model's training data. This one answers from *your* files,
and says so when it cannot.

- **Documents in, grounded answers out.** Ten file formats are ingested, chunked, embedded and
  stored in Postgres with pgvector. A question is embedded, matched against that corpus, and
  the retrieved passages — not the model's memory — form the answer.
- **It refuses rather than guesses.** When retrieval returns nothing relevant, the model is
  instructed to say the uploaded documents do not cover the question and stop. A grounded
  refusal is a correct answer.
- **Every answer shows its sources.** Retrieved passages are rendered beside the reply.
- **The provider is swappable.** `LLM_PROVIDER` selects `ollama` (local), `gemini` (hosted) or
  `disabled`. Nothing above the provider boundary knows which is in use.
- **No paid API is required.** The default configuration is fully local. `ZERO_API_MODE=true`
  turns that from a description into an enforced guarantee — the application refuses any
  provider that is not local.

### Measured results

From `npm run eval` over a 30-question fixture set (`evals/questions.jsonl`), most recent runs,
`llama3.2:3b` with `nomic-embed-text`:

| Metric | Result |
|---|---|
| Retrieval hit rate | **96.2%** |
| Answer correctness | **86.7 – 90%** |
| Failure rate | **0** |
| Retrieval latency | p50 ~280 ms · p95 ~350 ms |

Reports are committed under `evals/reports/`. Reproduce with `npm run eval`.

---

## Architecture

```
Browser (React)
  └── src/lib/chat-transport.ts          knows only: POST /api/chat
        │  HTTP, NDJSON stream
        ▼
  src/app/api/chat/route.ts              auth, rate limit, validate, stream
        │
        ▼
  src/lib/rag.ts                         retrieve → build grounded context → prompt
        │                                 <document index="N" title="…"> blocks
        ├──▶ src/lib/rerank.ts           optional reordering, fail-open
        │       └── rerank/lexical.ts · rerank/llm.ts
        │
        ├──▶ src/lib/retrieval.ts        hybrid search, over-fetch, deduplicate
        │       └── Supabase RPC: hybrid_search / match_chunks
        │             └── Postgres + pgvector (HNSW, cosine)
        │
        └──▶ src/lib/llm.ts              picks a provider from LLM_PROVIDER
                 ├── llm/ollama.ts       the only Ollama-aware module
                 └── llm/gemini.ts       the only Gemini-aware module
```

Three boundaries are load-bearing:

**The browser never learns which model answers.** No provider variable carries a
`NEXT_PUBLIC_` prefix, so Next.js never inlines one into the client bundle, and no error
message echoes one back. `src/lib/llm.ts` throws if imported from a client component.

**Swapping providers touches one file.** Everything above `llm.ts` depends on the
`LlmProvider` interface, so a model switch is an environment-variable change. `npm run
verify:model-switch` runs the same question through two models and asserts the retrieved
chunks come back identical.

**Reranking can never break a request.** It reorders results that already exist, so every
failure has a correct answer available — the fused order from hybrid search. `rerankResults`
catches everything a strategy can throw, logs it server-side, and returns that order.

---

## RAG pipeline

Every stage below is implemented; the file that implements it is named.

| # | Stage | Implementation |
|---|---|---|
| 1 | **Ingestion** | `src/app/api/documents/route.ts`, `src/lib/ingest/pipeline.ts` — upload, or `npm run ingest` from the CLI |
| 2 | **Extraction** | `src/lib/ingest/extract.ts` — `unpdf` for PDF, `node-html-parser` for HTML, `structured.ts` for CSV/JSON/XLSX, `cfb.ts` + `legacy-office.ts` for OLE2 `.doc`/`.xls` |
| 3 | **OCR** (scanned PDFs) | `src/lib/ingest/ocr.ts` — **Gemini mode only**, see caveat below |
| 4 | **Chunking** | `src/lib/ingest/chunking.ts` — 600–900 token target, 100-token overlap, 150-token minimum |
| 5 | **Embeddings** | `src/lib/embeddings/ollama.ts` (`nomic-embed-text`) · `src/lib/embeddings/gemini.ts` (`gemini-embedding-001`). Both produce **768 dimensions** |
| 6 | **Vector storage** | `chunks.embedding vector(768)`, indexed `using hnsw (embedding vector_cosine_ops)` |
| 7 | **Semantic search** | `match_chunks` RPC — pgvector cosine, `similarity = 1 - (embedding <=> query)` |
| 8 | **Hybrid search** | `hybrid_search` RPC — a generated `tsvector` column, `websearch_to_tsquery`, `ts_rank_cd`, fused with the vector arm by **Reciprocal Rank Fusion**: `1/(k + rank_vector) + 1/(k + rank_text)`, `k = 60` |
| 9 | **Reranking** | `src/lib/rerank.ts` over an over-fetched candidate set. Two strategies: `lexical` and `llm`. **Off by default** — see below |
| 10 | **Grounded generation** | `src/lib/rag.ts` `buildGroundedContext()` emits `<document index="N" title="…">` blocks; `src/lib/llm/system-prompt.ts` carries the refusal rule; `src/components/message-sources.tsx` renders citations |

### Two honest caveats

**OCR requires Gemini.** Scanned PDFs are transcribed by the provider's vision model, which
means `LLM_PROVIDER=gemini` and a `GEMINI_API_KEY`. A local Ollama deployment cannot OCR, and
`ZERO_API_MODE=true` stops ingestion before OCR is reached. This was a deliberate trade —
Tesseract would have added a rasteriser, a canvas implementation and tens of megabytes of WASM
to a serverless function with a bundle ceiling. `MAX_OCR_PAGES` (default 20) caps pages per
document; a longer document is indexed up to that point and the shortfall is stated in the
stored text.

**Reranking is off by default, from measurement rather than preference.** On the project's own
fixture set the lexical reranker left every metric exactly where hybrid search had it — top-1
87.5%, hit@5 100%, MRR 0.9375, with 0 queries improved and 0 degraded. A stage not shown to
help should not sit in the request path. The `llm` strategy is implemented and selectable but
was measured at 0.7–10.4 s *per candidate* on the reference hardware, so it is not usable
interactively there. Re-measure on your own corpus with `npm run verify:rerank` before
enabling it.

---

## Supported document types

**10 source types across 14 extensions**, defined once in `src/lib/ingest/formats.ts` and
derived everywhere else — the file picker, the upload route and the extractor all read the same
list.

| Type | Extensions | Extraction |
|---|---|---|
| PDF | `.pdf` | `unpdf`; scanned PDFs via OCR (Gemini mode) |
| Word | `.docx` | XML part extraction |
| Word (legacy) | `.doc` | OLE2 compound-file reader (`cfb.ts`, `legacy-office.ts`) |
| Excel | `.xlsx` | Sheet and row flattening |
| Excel (legacy) | `.xls` | OLE2 compound-file reader |
| CSV | `.csv` | `structured.ts` |
| JSON | `.json` | `structured.ts` |
| Markdown | `.md`, `.markdown`, `.mdx` | Plain text |
| Plain text | `.txt`, `.text` | Plain text |
| HTML | `.html`, `.htm` | `node-html-parser` |

Upload size is capped by `MAX_DOCUMENT_SIZE_MB` (default 50, clamped at 200). MIME types the
browser reports are treated as advisory; the extension list is authoritative.

---

## Technology stack

- **Next.js 16.3.1** (App Router) · **React 19.2.8** · **TypeScript 5**
- **Tailwind CSS 4** — configured in CSS via `@theme`; no `tailwind.config.js`
- **Supabase** — Postgres, `pgvector`, Row Level Security, Supabase Auth
- **Ollama** — `llama3.2:3b` generation, `nomic-embed-text` embeddings (local mode)
- **Google Gemini** — `gemini-3.5-flash-lite` generation, `gemini-embedding-001` embeddings
  (hosted mode, requested at 768 dimensions so the schema is unchanged)
- **unpdf** · **node-html-parser** — the only parsing dependencies

Runtime dependencies are deliberately few: `@supabase/supabase-js`, `next`, `react`,
`react-dom`, `node-html-parser`, `unpdf`.

### Beyond retrieval

Authentication and per-user document ownership enforced by RLS · conversation history with
bounded context and summarisation · in-process rate limiting and concurrency caps · an admin
dashboard at `/admin` · an embeddable widget at `/embed` with a fail-closed origin allowlist ·
`/api/health` reporting LLM and database reachability · security headers and CSP in
`next.config.ts` · a 30-question evaluation harness with committed reports.

---

## Setup

### Requirements

| Tool | Minimum |
|---|---|
| Node.js | 20.x |
| npm | 10.x |
| Ollama | 0.30.x (local mode only) |
| Supabase project | with the `vector` extension enabled |

### 1. Install and configure

```bash
npm install
```

```bash
cp .env.example .env.local
```

`.env.example` is committed and contains placeholders only. Real values go in `.env.local`,
which is git-ignored.

### 2. Create the database schema

Apply the migrations in `supabase/migrations/` in filename order, via the Supabase SQL editor
or the Supabase CLI. They create the `documents` and `chunks` tables, the HNSW vector index,
the `match_chunks` and `hybrid_search` RPCs, conversations, authentication and RLS policies.

```bash
npm run verify:supabase
```

### 3. Start a model (local mode)

```bash
ollama serve
```

```bash
ollama pull llama3.2:3b && ollama pull nomic-embed-text
```

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. If Ollama is not running, the interface says so and offers a
retry rather than failing silently.

### 5. Load documents

Upload through the interface, or ingest from the command line:

```bash
npm run ingest -- ./path/to/documents
```

### Verification scripts

The repository ships around thirty verification scripts, each asserting against real files and
a real database rather than mocks:

```bash
npm run verify:embeddings
```

```bash
npm run verify:ingestion
```

```bash
npm run verify:hybrid
```

```bash
npm run verify:grounding
```

```bash
npm run eval
```

Others cover retrieval, reranking, OCR, security, auth, documents, limits, conversations,
widget, monitoring, model switching, offline mode, re-ingestion, deployment and Gemini —
alongside `build`, `start`, `lint`, `typecheck`, `system-info`, `bench`, `reingest` and `demo`.

---

## Environment variables

Every variable is **server-only**. None carries a `NEXT_PUBLIC_` prefix, and none should be
given one. `.env.example` documents each in full; the tables below are the map.

### Core

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `ollama` (default, local) · `gemini` (hosted) · `disabled` (no inference) |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses Row Level Security — treat as a database password.** Server-side only |
| `SUPABASE_ANON_KEY` | Publishable key; RLS decides what the bearer may see |

### Local inference (Ollama)

| Variable | Default |
|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` |
| `OLLAMA_MODEL` | `llama3.2:3b` |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` — changing this invalidates every stored vector and requires re-ingestion |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_EMBED_TIMEOUT_MS` | `120000` / `30000` |
| `ZERO_API_MODE` | `false`. `true` refuses any non-local provider |

### Hosted inference (Gemini)

| Variable | Default |
|---|---|
| `GEMINI_API_KEY` | *(unset — required for this mode)* |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` |
| `GEMINI_EMBED_DIMENSIONS` | `768` when unset |
| `GEMINI_TIMEOUT_MS` | `60000` |
| `GEMINI_REQUESTS_PER_HOUR` / `_PER_DAY` | `100` / `500` — a global spend ceiling on top of per-caller limits |

### Retrieval, hybrid search and reranking

| Variable | Default |
|---|---|
| `MATCH_COUNT` | `5` |
| `SIMILARITY_THRESHOLD` | `0.5` cosine similarity |
| `RAG_MAX_CONTEXT_CHARS` | `6000` (minimum 500) |
| `RRF_K` | `60` |
| `HYBRID_CANDIDATES` | `30` per arm before fusion |
| `RERANK_ENABLED` | `false` |
| `RERANK_STRATEGY` | `lexical` or `llm` |
| `RERANK_CANDIDATES` | `20` |
| `RERANK_TIMEOUT_MS` | `5000` |

### Conversations, uploads and generation

| Variable | Default |
|---|---|
| `CONVERSATION_MAX_TURNS` | `10` |
| `CONVERSATION_MAX_HISTORY_CHARS` | `4000` |
| `CONVERSATION_SUMMARY_INPUT_CHARS` | `6000` |
| `MAX_DOCUMENT_SIZE_MB` | `50` (clamped at 200) |
| `MAX_OCR_PAGES` | `20` (clamped at 200) |
| `GENERATION_MAX_TOKENS_ANONYMOUS` / `_AUTHENTICATED` | `384` / `512` |
| `MAX_REQUEST_BYTES` | `131072` |

### Abuse protection, admin and widget

| Variable | Default |
|---|---|
| `RATE_LIMIT_ENABLED` | `true` |
| `RATE_LIMIT_TRUST_PROXY` | `false` — set `true` only behind a proxy that rewrites `X-Forwarded-For` |
| `RATE_LIMIT_WINDOW_SECONDS` | `3600` |
| `RATE_LIMIT_CHAT_ANONYMOUS` / `_AUTHENTICATED` | `10` / `60` |
| `RATE_LIMIT_UPLOAD_ANONYMOUS` / `_AUTHENTICATED` | `0` / `20` |
| `RATE_LIMIT_AUTH` | `10` |
| `RATE_LIMIT_READ_ANONYMOUS` / `_AUTHENTICATED` | `120` / `300` |
| `RATE_LIMIT_MAX_CONCURRENT` / `_ANONYMOUS` | `2` / `1` |
| `RATE_LIMIT_WIDGET` | `60` per allowlisted site |
| `ADMIN_EMAILS` | *(unset — `/admin` returns 404 for everyone)* |
| `WIDGET_ALLOWED_ORIGINS` | *(unset — widget disabled; **read at build time**, so changing it needs a rebuild, not a restart)* |
| `SITE_URL` | Optional; used to build email-confirmation links |

Rate-limit counters live **in process**. They reset on restart and do not coordinate across
instances, so on a serverless host the effective ceiling is roughly the limit times the warm
instance count. See `docs/DEPLOYMENT.md`.

---

## Deployment

`docs/DEPLOYMENT.md` covers the deployment modes in full, including what each can and cannot
do, and the privacy trade that hosted mode makes.

The short version: a serverless function cannot reach an Ollama running on your laptop —
`localhost` inside a container is the container itself. So a public deployment either uses
`LLM_PROVIDER=gemini`, or `LLM_PROVIDER=disabled`, which switches inference off explicitly
(chat and upload answer 503 with one plain sentence; nothing is faked) while sign-in,
conversations, documents, `/admin`, `/api/health`, `/embed` and every security control keep
working.

Do **not** set `OLLAMA_BASE_URL`, `OLLAMA_MODEL` or `ZERO_API_MODE` on a serverless host.

---

## Screenshots

None are committed to this repository. The **[live demo](https://aariz-ai-three.vercel.app)**
is the current interface.

---

## Cost

No per-question AI API cost in local mode: inference runs on hardware you control. That is not
unlimited capacity — throughput is bounded by CPU, RAM and uptime, and the reference hardware
serves one request at a time, which is why the concurrency cap exists. In Gemini mode, cost is
bounded by `GEMINI_REQUESTS_PER_HOUR` and `_PER_DAY` on top of the per-caller limits.

---

## Project documents

- [`ROADMAP.md`](./ROADMAP.md) — the build order this project followed, and the rules it held to
- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — deployment modes, privacy trades, serverless caveats
- [`evals/`](./evals) — question set, corpus and committed metric reports

---

## License

Not yet specified.
