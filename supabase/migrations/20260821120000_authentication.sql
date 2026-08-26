-- =============================================================================
-- Level 13 — authentication and user isolation
--
-- ROADMAP.md Level 13 requires Supabase Auth, support for both anonymous and
-- authenticated users, and REAL Row Level Security — "User A cannot access
-- User B's conversations" must be enforced by the database, not by application
-- filtering that a bug could skip.
--
-- Additive and backward compatible. It does not drop, rename or rewrite
-- anything from Levels 4-12, and it does not touch existing rows: `user_id` is
-- added nullable, so every conversation created before this migration stays
-- exactly as it was — anonymous, owned by its session.
--
-- Idempotent: safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Authenticated ownership, beside the anonymous session ownership
--
-- NULLABLE on purpose, and `session_id` is deliberately NOT removed. The two
-- ownership models coexist:
--
--   anonymous conversation      session_id = <server session>, user_id IS NULL
--   authenticated conversation  user_id    = <auth.users.id>
--
-- ON DELETE CASCADE: deleting the auth user removes their conversations, and
-- the existing messages FK cascades from there.
-- -----------------------------------------------------------------------------
alter table public.conversations
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

comment on column public.conversations.user_id is
  'Level 13 authenticated owner. NULL for anonymous conversations, which remain scoped to session_id. Never supplied by the client: it is written from the server-verified Supabase Auth session only.';

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- -----------------------------------------------------------------------------
-- Table privileges
--
-- RLS decides WHICH ROWS a role may touch; these grants decide whether the role
-- may touch the table at all. Both are needed: a grant without a policy still
-- yields nothing, which is the Level 12 posture these policies now replace for
-- authenticated users.
--
-- `anon` is granted nothing here and has no policy, so an unauthenticated
-- caller using the anon key reads nothing. Anonymous CHAT still works, because
-- it goes through the server's service-role client with session scoping — the
-- browser never talks to these tables directly.
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages      to authenticated;

grant all privileges on public.conversations to service_role;
grant all privileges on public.messages      to service_role;

revoke all on public.conversations from anon;
revoke all on public.messages      from anon;

-- -----------------------------------------------------------------------------
-- RLS — conversations
--
-- `(select auth.uid())` rather than a bare `auth.uid()`: wrapping it lets
-- PostgreSQL evaluate the call once per statement as an InitPlan instead of
-- once per row.
--
-- Note what happens to an ANONYMOUS row under these policies. Its `user_id` is
-- NULL, so `user_id = auth.uid()` evaluates to NULL — not true — and the row is
-- denied. Anonymous conversations are therefore invisible to every
-- authenticated user, which is the behaviour we want and is easy to get wrong
-- by writing `user_id IS NOT DISTINCT FROM auth.uid()`.
-- -----------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

drop policy if exists conversations_select_own on public.conversations;
create policy conversations_select_own on public.conversations
  for select to authenticated
  using (user_id = (select auth.uid()));

-- WITH CHECK on INSERT is what stops a user creating a row already owned by
-- someone else. Without it, an authenticated caller could insert a conversation
-- with another user's id and hand it to them.
drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own on public.conversations
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- USING controls which rows may be updated; WITH CHECK controls what they may
-- become. Both are required: USING alone would let a user take a row they own
-- and reassign its user_id to somebody else.
drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists conversations_delete_own on public.conversations;
create policy conversations_delete_own on public.conversations
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- RLS — messages
--
-- Ownership is inherited from the parent conversation rather than duplicated
-- onto every message. Duplicating it would create a second source of truth that
-- could drift; deriving it means a message is reachable exactly when its
-- conversation is.
--
-- The EXISTS subquery reads `conversations`, which is itself under RLS, so a
-- conversation the caller cannot see yields no row and the message is denied.
-- The two policies reinforce each other rather than relying on one.
-- -----------------------------------------------------------------------------
drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = (select auth.uid())
    )
  );

-- The requirement called out explicitly in the Level 13 brief: a user must not
-- be able to write a message into somebody else's conversation.
drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own on public.messages
  for insert to authenticated
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = (select auth.uid())
    )
  );

drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = (select auth.uid())
    )
  );

drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = (select auth.uid())
    )
  );

notify pgrst, 'reload schema';
