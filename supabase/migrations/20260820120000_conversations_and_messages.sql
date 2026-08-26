-- =============================================================================
-- Level 12 — conversation memory
--
-- ROADMAP.md Level 12 asks for two tables, `conversations` and `messages`, so
-- that refreshing the page does not lose the conversation. The roadmap names
-- both tables explicitly and those names are used verbatim.
--
-- Purely additive. `documents`, `chunks`, `match_chunks` and
-- `hybrid_match_chunks` are not referenced, altered or dropped here, so every
-- Level 4–11 behaviour is unaffected by applying this file.
--
-- Idempotent: safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- conversations
--
-- `session_id` is the OWNER, and it is deliberately not a foreign key to any
-- user table, because there is no authentication yet — that is Level 13. The
-- value is generated server-side and handed to the browser in an httpOnly
-- cookie, so the client can neither read nor choose it. Nothing identifying
-- ever arrives from the client, which is what lets Level 13 add `user_id`
-- alongside this column and claim existing rows rather than redesign.
--
-- Known and accepted for this level: possession of the cookie is possession of
-- the conversations. Real identity arrives at Level 13.
-- -----------------------------------------------------------------------------
create table if not exists public.conversations (
  id          uuid        primary key default gen_random_uuid(),
  session_id  text        not null,
  title       text        not null default 'New chat',

  -- Level 12 context strategy: older turns are compressed into `summary`, and
  -- `summarised_through` is the watermark saying how far that summary reaches.
  -- Storing the watermark rather than a message count means the summary stays
  -- correct even if messages are added concurrently.
  summary             text,
  summarised_through  timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint conversations_title_not_blank check (length(btrim(title)) > 0),
  constraint conversations_title_length    check (length(title) <= 200)
);

comment on table public.conversations is
  'Level 12 conversation memory. Owned by session_id, an opaque server-generated anonymous session identifier delivered in an httpOnly cookie. Level 13 adds authenticated ownership alongside it.';

comment on column public.conversations.summarised_through is
  'Watermark: messages created at or before this instant are represented by summary. Null means nothing has been summarised yet.';

-- Listing a session's chats, newest activity first — the query behind the
-- sidebar, and the only query that reads conversations without an id.
create index if not exists conversations_session_updated_idx
  on public.conversations (session_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- messages
--
-- `role` is constrained to the two roles a stored turn can legitimately have.
-- 'system' is deliberately NOT permitted: the system prompt is assembled
-- server-side on every request and must never be readable or writable as
-- conversation data. That is the same boundary the /api/chat validator enforces
-- on the way in, restated here so the database cannot hold a turn the API
-- would have rejected.
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id               uuid        primary key default gen_random_uuid(),
  conversation_id  uuid        not null
                     references public.conversations (id) on delete cascade,
  role             text        not null,
  content          text        not null,

  -- Level 8 citations, stored so that a refreshed page can render the same
  -- sources beneath the same answer. Null for user turns.
  sources          jsonb,

  created_at       timestamptz not null default now(),

  constraint messages_role_valid   check (role in ('user', 'assistant')),
  constraint messages_content_len  check (length(content) <= 20000)
);

comment on table public.messages is
  'Level 12 conversation turns. Cascade-deleted with their conversation. role is restricted to user/assistant: the system prompt is never stored as data.';

comment on column public.messages.sources is
  'Level 8 AnswerSource[] for an assistant turn, so citations survive a page refresh. Null on user turns.';

-- History is always read as "this conversation, in order".
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
--
-- Reuses the trigger function created by the Level 4 migration rather than
-- defining a second copy. `create or replace` there means it already exists;
-- this file only attaches it.
-- -----------------------------------------------------------------------------
drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- Enabled with NO policies, exactly as `documents` and `chunks` are at Level 4.
-- With RLS on and no policy present, PostgreSQL denies every row to every role
-- that is subject to RLS — anon and authenticated get nothing. Only the
-- service-role key, which bypasses RLS and is held server-side, can read or
-- write. The browser never talks to these tables directly; it goes through
-- /api/chat and /api/conversations, which scope every query by session.
--
-- Level 13 replaces this deny-all posture with real per-user policies. Until
-- then, deny-all is the correct default and must not be relaxed to make
-- anything easier to test.
-- -----------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

notify pgrst, 'reload schema';
