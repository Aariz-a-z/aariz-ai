# AARIZ AI

**Your intelligent assistant for exploring your documents.**

A retrieval-augmented chatbot that answers questions from your own documents, using a
self-hosted open-source model instead of a paid AI API.

> **Status: Level 3 of 25 — connected to a local model.**
> The chat is answered by an open-source model running on your own machine via Ollama.
> Nothing is sent to a cloud AI service, and there is no per-question API cost.
> Retrieval over your documents does not exist yet — the model answers from its own
> training, not from your files.

Build order and requirements are defined in [`ROADMAP.md`](./ROADMAP.md).

---

## What works right now

| Capability | Status |
|---|---|
| AARIZ AI branding — header, welcome screen, page title | ✅ |
| Chat UI: streaming, Stop, loading, error, auto-scroll | ✅ |
| Enter to send, Shift+Enter for a newline | ✅ |
| Responsive layout, dark mode, reduced-motion support | ✅ |
| **Local LLM via Ollama, streamed through `/api/chat`** | ✅ |
| **Provider abstraction — model swappable by env var** | ✅ |
| Document ingestion, embeddings, retrieval (RAG) | ⛔ Level 4–8 |
| Authentication, rate limiting, deployment | ⛔ Level 13–16, 23 |

---

## Requirements

| Tool | Minimum | Verified on this machine |
|---|---|---|
| Node.js | 20.x | 22.15.0 |
| npm | 10.x | 10.9.2 |
| Git | 2.x | 2.52.0 |
| **Ollama** | 0.30.x | 0.30.11 |

`pnpm` is not installed, so `npm` is used throughout (`ROADMAP.md` line 261 allows either).

---

## Getting started

```bash
npm install
cp .env.example .env.local
```

Start the model server and pull the model (once):

```bash
ollama serve
```

```bash
ollama pull llama3.2:3b
```

Then run the app:

```bash
npm run dev
```

Open <http://localhost:3000>. If Ollama is not running, the interface says so and offers a
retry rather than failing silently.

### Performance expectation

This is CPU-only inference on a 2-core laptop. Measured at Level 2 with `llama3.2:3b`:
roughly **9 tok/s generation** on short prompts, falling to **5.6 tok/s** once the prompt
reaches ~1000 tokens, with prompt processing dropping from 115 to **38 tok/s** over the same
range. Expect several seconds before the first word. That is the hardware, not a bug —
`npm run bench` reproduces the numbers.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | Route typegen, then TypeScript with no emit |
| `npm run system-info` | Hardware report used to choose a model (Level 0) |
| `npm run bench` | Benchmark local models on this machine (Level 2) |

---

## Project structure

```
.
├── ROADMAP.md
├── scripts/
│   ├── system-info.ts       Level 0 hardware detection
│   └── bench-ollama.ts      Level 2 model benchmark
├── src/
│   ├── app/
│   │   ├── api/chat/route.ts   POST /api/chat — validate, stream, report errors
│   │   ├── layout.tsx          Fonts, metadata ("AARIZ AI")
│   │   ├── page.tsx
│   │   └── globals.css
│   ├── components/             chat, composer, message list, bubble, error banner, brand
│   ├── lib/
│   │   ├── llm.ts              Provider selection (server-only)
│   │   ├── llm/types.ts        Provider-agnostic contract
│   │   ├── llm/ollama.ts       The only file that knows Ollama exists
│   │   └── chat-transport.ts   Browser → /api/chat (knows no provider)
│   └── types/chat.ts
```

---

## Architecture

```
Browser (React)
  └── src/lib/chat-transport.ts        knows only: POST /api/chat
        │  HTTP, NDJSON stream
        ▼
  src/app/api/chat/route.ts            validates, streams, maps errors
        │
        ▼
  src/lib/llm.ts                       picks a provider from LLM_PROVIDER
        │
        ▼
  src/lib/llm/ollama.ts                the only Ollama-aware module
        │  POST /api/chat (NDJSON)
        ▼
  Ollama  ──▶  llama3.2:3b
```

Two boundaries are load-bearing:

**The browser never learns which model answers.** `OLLAMA_BASE_URL` and `OLLAMA_MODEL` have
no `NEXT_PUBLIC_` prefix, so Next.js never inlines them into the client bundle, and no error
message echoes them back. `src/lib/llm.ts` throws if imported from a client component.

**Swapping providers touches one file.** Everything above `llm.ts` depends on the
`LlmProvider` interface, so Level 19's model switching is an environment-variable change.

### Response wire format

`/api/chat` streams NDJSON — one JSON object per line:

```
{"type":"delta","text":"…"}
{"type":"error","message":"…"}
{"type":"done"}
```

Plain text would be simpler, but a mid-stream failure would then be indistinguishable from a
finished answer: the user would see a truncated reply presented as complete. Framing makes
that failure visible.

---

## Verifying the interface

| To check | Do this | Expect |
|---|---|---|
| Streaming | Send any message | Text arrives progressively |
| Loading state | Send and watch immediately | Bouncing dots until the first word |
| Stop | Press **Stop** mid-stream | Output halts; partial text is kept |
| Error state | Quit Ollama, then send a message | Red banner: "The local model server is not running…" with **Retry** |
| Recovery | Restart Ollama, press **Retry** | Banner clears, answer streams |
| Scroll behaviour | Scroll up while streaming | View stays put; **Jump to latest** appears |

---

## Technology

- **Next.js 16.3.1** (App Router) · **React 19.2.8** · **TypeScript 5.9.3**
- **Tailwind CSS 4.3.3** — v4, configured in CSS via `@theme`; no `tailwind.config.js`
- **Ollama 0.30.11** running `llama3.2:3b` (Q4_K_M, 1.88 GB)

---

## Cost

No per-question AI API cost: inference runs on hardware you control. That is not unlimited
capacity — throughput is bounded by CPU, RAM, bandwidth and uptime, and this hardware serves
one request at a time. See `ROADMAP.md` lines 30–40.

---

## License

Not yet specified — added at Level 24.
