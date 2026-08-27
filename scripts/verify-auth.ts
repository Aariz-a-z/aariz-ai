#!/usr/bin/env node
/**
 * Level 13 — authentication and user isolation verification.
 *
 * Real Supabase Auth, real users, real API over real cookies, and — the part
 * that matters most — real RLS.
 *
 * WHY THERE ARE TWO KINDS OF ISOLATION TEST
 * -----------------------------------------
 * Checking that `/api/conversations/:id` returns 404 for the wrong user proves
 * the ROUTE is careful. It does not prove the DATABASE is, and a route is one
 * refactor away from forgetting. So every cross-user operation is tested twice:
 *
 *   through the API      does the application refuse?
 *   through a raw client does PostgreSQL refuse, with the application removed
 *                        from the picture entirely?
 *
 * The second set uses clients built from each user's own verified JWT. The
 * service-role key is never used for them, because it BYPASSES RLS and would
 * make the policies look like they work no matter what they say.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-auth.ts
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signIn } from '../src/lib/auth.ts';
import { buildConversationContext } from '../src/lib/conversation-context.ts';
import type { StoredMessage } from '../src/lib/conversations.ts';
import { ingestFile } from '../src/lib/ingest/pipeline.ts';
import { createAuthedClient, isAuthConfigured } from '../src/lib/supabase/authed.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function block(label: string, detail = ''): void {
  console.log(`  [BLOCKED] ${label}${detail ? `  — ${detail}` : ''}`);
  blocked++;
}

function summary(): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed · ${blocked} blocked`);
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** A browser-like cookie jar. Two of these are as separate as two browsers. */
class Client {
  private cookies = new Map<string, string>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get hasAuthCookie(): boolean {
    return this.cookies.has('aariz_access');
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set('cookie', this.cookieHeader);

    const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });

    // getSetCookie() returns every Set-Cookie separately, which matters here:
    // sign-in sets two auth cookies plus possibly a session cookie, and a
    // naive header read would see only the first.
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator === -1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value.length === 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }

    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await this.request(path, init);
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      body = {} as T;
    }
    return { status: response.status, body };
  }

  /** POST a turn to /api/chat and drain the NDJSON stream. */
  async ask(
    prompt: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ status: number; conversationId: string | null; answer: string; sources: unknown[] }> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], ...extra }),
    });

    if (!response.ok || response.body === null) {
      return { status: response.status, conversationId: null, answer: '', sources: [] };
    }

    let conversationId: string | null = null;
    let answer = '';
    let sources: unknown[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw.length === 0) continue;
        const event = JSON.parse(raw) as { type: string; id?: string; text?: string; sources?: unknown[] };
        if (event.type === 'conversation' && typeof event.id === 'string') conversationId = event.id;
        else if (event.type === 'delta' && typeof event.text === 'string') answer += event.text;
        else if (event.type === 'sources' && Array.isArray(event.sources)) sources = event.sources;
      }
    }

    return { status: response.status, conversationId, answer, sources };
  }
}

/** Synthetic history for the context-strategy regression. */
function makeHistory(count: number): StoredMessage[] {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn ${i} `.padEnd(40, 'x'),
    sources: null,
    createdAt: new Date(base + i * 1000).toISOString(),
  }));
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('\n=== Level 13 — authentication and user isolation ===\n');

  if (!isSupabaseConfigured()) {
    block('Supabase is not configured');
    summary();
    return;
  }
  if (!isAuthConfigured()) {
    block(
      'SUPABASE_ANON_KEY is not set',
      'authentication cannot run without it — add it to .env.local (Dashboard -> Project Settings -> API Keys -> anon)',
    );
    summary();
    return;
  }

  const admin = getSupabaseAdminClient();

  // --- The Level 13 migration must actually be applied ---------------------
  // A real select, not a head/count request: a head request against a missing
  // table resolves without an error on this instance, which would let a missing
  // migration through the guard.
  const columnProbe = await admin.from('conversations').select('id, user_id').limit(1);
  if (columnProbe.error) {
    block(
      'the Level 13 migration has not been applied',
      `${columnProbe.error.message} — run supabase/migrations/20260821120000_authentication.sql in the Supabase SQL Editor`,
    );
    summary();
    return;
  }

  try {
    const ping = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(5_000) });
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    block('the application is not running', `${BASE_URL} — start it with "npm run dev"`);
    summary();
    return;
  }

  /**
   * Checked against the provider actually configured.
   *
   * This pinged Ollama unconditionally, which was right when Ollama was the
   * only provider and became wrong once Gemini existed: a healthy Gemini stack
   * reported `0 passed · 1 blocked` because a service it does not use was not
   * running. The application's own health endpoint answers the real question —
   * "can this server embed and generate?" — for whichever provider is in use.
   */
  if ((process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase() === 'ollama') {
    const ollamaUrl = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
    try {
      const ping = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(5_000) });
      if (!ping.ok) throw new Error(String(ping.status));
    } catch {
      block('Ollama is not reachable', ollamaUrl);
      summary();
      return;
    }
  }

  try {
    const health = (await (await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    })).json()) as { llm?: string; database?: string };
    if (health.llm !== 'available' || health.database !== 'available') {
      block('the server reports a dependency down', `llm=${health.llm} database=${health.database}`);
      summary();
      return;
    }
  } catch {
    block('the health endpoint did not answer', `${BASE_URL}/api/health`);
    summary();
    return;
  }

  // Everything created by this run, tracked precisely so cleanup can never
  // reach anything else. Level 12 shipped a blanket delete that would have
  // destroyed real user data; that mistake is not repeated here.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const testUserIds: string[] = [];
  const testDocumentIds: string[] = [];
  const anonymousClients: Client[] = [];

  const dir = await mkdtemp(join(tmpdir(), 'level13-'));
  const password = `Test-${runId}-Aa1!`;
  const emailA = `l13-a-${runId}@example.test`;
  const emailB = `l13-b-${runId}@example.test`;

  try {
    // --- B. Signup ----------------------------------------------------------
    console.log('\n-- Accounts ------------------------------------------------------');
    // Created with email_confirm so the run does not depend on the project's
    // confirmation setting. This is TEST SETUP through the admin API; every
    // isolation assertion below runs as a real authenticated user.
    for (const email of [emailA, emailB]) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
      testUserIds.push(data.user.id);
    }
    check(testUserIds.length === 2, 'two independent test accounts created', `${testUserIds.length}`);

    const [userAId, userBId] = testUserIds as [string, string];

    // --- Corpus, OWNED BY USER A ------------------------------------------
    // Deliberately owned rather than anonymous. Per-user documents scope an
    // authenticated user's retrieval to their own uploads, so a shared, unowned
    // corpus is no longer reachable from a signed-in session - which is the
    // point of that level. This fixture therefore has to belong to A for the
    // citation assertions below to have anything to cite.
    //
    // Only the OWNERSHIP of the fixture changed; the assertions are unchanged.
    console.log('-- Corpus --------------------------------------------------------');
    const file = join(dir, 'harrier.md');
    await writeFile(
      file,
      '# Harrier Gateway Notes\n\nThe Harrier gateway raises fault HG-3390 when its certificate chain expires. ' +
        'The remedy is to rotate the intermediate certificate and restart the listener. ' +
        'The gateway keeps a forty-minute grace period before refusing new connections.\n',
      'utf8',
    );
    const ingested = await ingestFile(file, { ownerId: userAId });
    if (ingested.outcome !== 'ingested' || !ingested.documentId) {
      throw new Error(`corpus ingestion failed: ${ingested.detail ?? ingested.outcome}`);
    }
    testDocumentIds.push(ingested.documentId);
    check(true, 'corpus document ingested and owned by A', ingested.title);


    // --- C. Login -----------------------------------------------------------
    const alice = new Client('A');
    const bob = new Client('B');

    const signinA = await alice.json<{ authenticated?: boolean }>('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password }),
    });
    check(signinA.status === 200 && signinA.body.authenticated === true, 'user A signs in', `HTTP ${signinA.status}`);
    check(alice.hasAuthCookie, 'an httpOnly auth cookie was issued to A');

    const signinB = await bob.json<{ authenticated?: boolean }>('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailB, password }),
    });
    check(signinB.status === 200 && signinB.body.authenticated === true, 'user B signs in', `HTTP ${signinB.status}`);

    const sessionA = await alice.json<{ authenticated?: boolean; email?: string }>('/api/auth/session');
    check(
      sessionA.body.authenticated === true && sessionA.body.email === emailA,
      'the session endpoint reports A as authenticated',
      sessionA.body.email ?? '',
    );

    const badLogin = await new Client('x').json<{ error?: string }>('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, password: 'wrong-password-entirely' }),
    });
    check(badLogin.status === 401, 'a wrong password is rejected', `HTTP ${badLogin.status}`);

    // --- D/E. Authenticated persistence ------------------------------------
    console.log('\n-- Authenticated conversations -----------------------------------');
    const created = await alice.ask('What is fault HG-3390?', { startConversation: true });
    check(created.status === 200, "A's conversation answers", `HTTP ${created.status}`);
    check(created.conversationId !== null, 'a conversation id was returned', created.conversationId ?? '');
    check(created.sources.length > 0, 'the answer carried citations', `${created.sources.length}`);

    const conversationA = created.conversationId!;

    const owned = await admin.from('conversations').select('user_id').eq('id', conversationA).single();
    check(
      owned.data?.user_id === userAId,
      'the conversation is owned by the authenticated user, not by a session alone',
      owned.data?.user_id === userAId ? 'user_id = A' : `user_id = ${owned.data?.user_id ?? 'null'}`,
    );

    const continued = await alice.ask('How long is the grace period?', { conversationId: conversationA });
    check(continued.status === 200, 'A can continue their conversation');

    const listA = await alice.json<{ conversations: { id: string }[] }>('/api/conversations');
    check(
      listA.body.conversations.some((c) => c.id === conversationA),
      'A sees their conversation in the list',
      `${listA.body.conversations.length} chat(s)`,
    );

    const readA = await alice.json<{ messages: { role: string; sources: unknown[] | null }[] }>(
      `/api/conversations/${conversationA}`,
    );
    check(readA.status === 200 && readA.body.messages.length === 4, 'A can read the full history', `${readA.body.messages.length} turns`);
    check(
      Array.isArray(readA.body.messages[1]?.sources) && (readA.body.messages[1]?.sources?.length ?? 0) > 0,
      'citations survive for an authenticated conversation',
    );

    const renameA = await alice.json<{ conversation?: { title: string } }>(`/api/conversations/${conversationA}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Harrier certificate incident' }),
    });
    check(renameA.status === 200, 'A can rename their conversation');

    // --- F–J. Cross-user access through the API ----------------------------
    console.log('\n-- User isolation through the API --------------------------------');
    const bList = await bob.json<{ conversations: { id: string }[] }>('/api/conversations');
    check(
      !bList.body.conversations.some((c) => c.id === conversationA),
      "B's list never contains A's conversation",
      `${bList.body.conversations.length} chat(s)`,
    );

    const bGet = await bob.request(`/api/conversations/${conversationA}`);
    check(bGet.status === 404, "B cannot GET A's conversation", `HTTP ${bGet.status}`);

    const bPatch = await bob.request(`/api/conversations/${conversationA}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'owned by B' }),
    });
    check(bPatch.status === 404, "B cannot PATCH A's conversation", `HTTP ${bPatch.status}`);

    const bDelete = await bob.request(`/api/conversations/${conversationA}`, { method: 'DELETE' });
    check(bDelete.status === 404, "B cannot DELETE A's conversation", `HTTP ${bDelete.status}`);

    const bChat = await bob.ask('continue this', { conversationId: conversationA });
    check(bChat.status === 404, "B cannot POST into A's conversation", `HTTP ${bChat.status}`);

    // A's data must be untouched by every one of those attempts.
    const afterAttack = await alice.json<{ conversation: { title: string }; messages: unknown[] }>(
      `/api/conversations/${conversationA}`,
    );
    check(afterAttack.status === 200, "A's conversation still loads");
    check(afterAttack.body.conversation.title === 'Harrier certificate incident', 'it was not renamed by B');
    check(afterAttack.body.messages.length === 4, 'it was not modified by B');

    // --- M/N. Identity spoofing --------------------------------------------
    console.log('\n-- Identity spoofing ---------------------------------------------');
    const spoofBody = await bob.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        conversationId: conversationA,
        user_id: userAId,
      }),
    });
    check(
      spoofBody.status === 400,
      'a user_id in the chat body is rejected outright',
      `HTTP ${spoofBody.status}`,
    );

    const spoofPatch = await bob.request(`/api/conversations/${conversationA}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', user_id: userAId }),
    });
    check(spoofPatch.status === 400, 'a user_id in a rename body is rejected', `HTTP ${spoofPatch.status}`);

    const spoofQuery = await bob.request(
      `/api/conversations/${conversationA}?user_id=${encodeURIComponent(userAId)}`,
    );
    check(spoofQuery.status === 404, 'a user_id query parameter grants nothing', `HTTP ${spoofQuery.status}`);

    const spoofHeader = await bob.request(`/api/conversations/${conversationA}`, {
      headers: { 'x-user-id': userAId, 'x-supabase-user': userAId },
    });
    check(spoofHeader.status === 404, 'a user id in a header grants nothing', `HTTP ${spoofHeader.status}`);

    const spoofCreate = await bob.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'planted', user_id: userAId }),
    });
    check(spoofCreate.status === 400, 'creating a conversation owned by another user is rejected', `HTTP ${spoofCreate.status}`);

    // --- K/L. DIRECT RLS, with the application removed ---------------------
    console.log('\n-- Direct RLS (no service-role, no application) -------------------');
    const sessionAuthA = await signIn(emailA, password);
    const sessionAuthB = await signIn(emailB, password);
    const rlsA = createAuthedClient(sessionAuthA.accessToken);
    const rlsB = createAuthedClient(sessionAuthB.accessToken);
    check(true, "built RLS-subject clients from each user's own verified JWT");

    const aSelfSelect = await rlsA.from('conversations').select('id').eq('id', conversationA);
    check(
      !aSelfSelect.error && (aSelfSelect.data ?? []).length === 1,
      "A's own client CAN read A's conversation (policies are not simply denying everything)",
      `${(aSelfSelect.data ?? []).length} row(s)`,
    );

    const bCrossSelect = await rlsB.from('conversations').select('id').eq('id', conversationA);
    check(
      !bCrossSelect.error && (bCrossSelect.data ?? []).length === 0,
      "RLS: B's client reads ZERO rows of A's conversation",
      `${(bCrossSelect.data ?? []).length} row(s)`,
    );

    const bListAll = await rlsB.from('conversations').select('id');
    check(
      !(bListAll.data ?? []).some((r) => r.id === conversationA),
      "RLS: an unfiltered select by B never returns A's conversation",
      `${(bListAll.data ?? []).length} row(s) visible to B`,
    );

    const aMessages = await rlsA.from('messages').select('id').eq('conversation_id', conversationA);
    check(
      !aMessages.error && (aMessages.data ?? []).length > 0,
      "A's client CAN read A's messages",
      `${(aMessages.data ?? []).length} row(s)`,
    );

    const bMessages = await rlsB.from('messages').select('id').eq('conversation_id', conversationA);
    check(
      !bMessages.error && (bMessages.data ?? []).length === 0,
      "RLS: B's client reads ZERO of A's messages",
      `${(bMessages.data ?? []).length} row(s)`,
    );

    const bInsert = await rlsB
      .from('messages')
      .insert({ conversation_id: conversationA, role: 'user', content: 'injected by B' })
      .select('id');
    check(
      bInsert.error !== null,
      "RLS: B cannot INSERT a message into A's conversation",
      bInsert.error?.code ?? 'NO ERROR — insert succeeded',
    );

    const bUpdate = await rlsB
      .from('conversations')
      .update({ title: 'stolen' })
      .eq('id', conversationA)
      .select('id');
    check(
      !bUpdate.error && (bUpdate.data ?? []).length === 0,
      "RLS: B's UPDATE of A's conversation affects no rows",
      `${(bUpdate.data ?? []).length} row(s)`,
    );

    const bDeleteDirect = await rlsB.from('conversations').delete().eq('id', conversationA).select('id');
    check(
      !bDeleteDirect.error && (bDeleteDirect.data ?? []).length === 0,
      "RLS: B's DELETE of A's conversation affects no rows",
      `${(bDeleteDirect.data ?? []).length} row(s)`,
    );

    const bTakeover = await rlsB
      .from('conversations')
      .update({ user_id: userBId })
      .eq('id', conversationA)
      .select('id');
    check(
      !bTakeover.error && (bTakeover.data ?? []).length === 0,
      'RLS: B cannot reassign ownership of A’s conversation to themselves',
      `${(bTakeover.data ?? []).length} row(s)`,
    );

    const bPlant = await rlsB
      .from('conversations')
      .insert({ session_id: 'planted', title: 'planted', user_id: userAId })
      .select('id');
    check(
      bPlant.error !== null,
      'RLS: B cannot INSERT a conversation owned by A',
      bPlant.error?.code ?? 'NO ERROR — insert succeeded',
    );

    // Confirm nothing above actually landed.
    const stillIntact = await admin
      .from('conversations')
      .select('title, user_id')
      .eq('id', conversationA)
      .single();
    check(
      stillIntact.data?.title === 'Harrier certificate incident' && stillIntact.data.user_id === userAId,
      'after every attack, the row is unchanged and still owned by A',
      `title="${stillIntact.data?.title}"`,
    );

    // --- A/O. Anonymous behaviour, unchanged from Level 12 -----------------
    console.log('\n-- Anonymous users still work, and stay isolated ------------------');
    const anon1 = new Client('anon1');
    const anon2 = new Client('anon2');
    anonymousClients.push(anon1, anon2);

    const anonCreated = await anon1.ask('What is fault HG-3390?', { startConversation: true });
    check(anonCreated.status === 200 && anonCreated.conversationId !== null, 'an anonymous user can still create a chat');

    const anonId = anonCreated.conversationId!;
    const anonRead = await anon1.json<{ messages: unknown[] }>(`/api/conversations/${anonId}`);
    check(anonRead.status === 200 && anonRead.body.messages.length === 2, 'anonymous refresh reconstruction still works', `${anonRead.body.messages.length} turns`);

    const anonCross = await anon2.request(`/api/conversations/${anonId}`);
    check(anonCross.status === 404, "a second anonymous session cannot read the first's chat", `HTTP ${anonCross.status}`);

    const bReadsAnon = await bob.request(`/api/conversations/${anonId}`);
    check(bReadsAnon.status === 404, 'an authenticated user cannot read an anonymous conversation', `HTTP ${bReadsAnon.status}`);

    const rlsBAnon = await rlsB.from('conversations').select('id').eq('id', anonId);
    check(
      (rlsBAnon.data ?? []).length === 0,
      'RLS: anonymous conversations are invisible to authenticated clients',
      `${(rlsBAnon.data ?? []).length} row(s)`,
    );

    // --- Sign-out --------------------------------------------------------
    console.log('\n-- Sign out ------------------------------------------------------');
    const signout = await alice.request('/api/auth/signout', { method: 'POST' });
    check(signout.status === 200, 'A can sign out', `HTTP ${signout.status}`);
    check(!alice.hasAuthCookie, 'the auth cookie was cleared');

    const afterSignout = await alice.json<{ authenticated?: boolean }>('/api/auth/session');
    check(afterSignout.body.authenticated === false, 'the session endpoint reports signed out');

    const listAfterSignout = await alice.json<{ conversations: { id: string }[] }>('/api/conversations');
    check(
      !listAfterSignout.body.conversations.some((c) => c.id === conversationA),
      "after sign-out the browser no longer sees the account's conversations",
      `${listAfterSignout.body.conversations.length} chat(s)`,
    );

    const readAfterSignout = await alice.request(`/api/conversations/${conversationA}`);
    check(readAfterSignout.status === 404, 'and cannot read them by id either', `HTTP ${readAfterSignout.status}`);

    // --- R. Level 12 context strategy still intact -------------------------
    console.log('\n-- Level 12 behaviour preserved ----------------------------------');
    let summariserCalls = 0;
    const context = await buildConversationContext(
      { summary: null, summarised_through: null },
      makeHistory(60),
      {
        summariser: async () => {
          summariserCalls++;
          return 'Earlier turns, summarised.';
        },
      },
    );
    check(context.messages.length < 60, 'bounded conversation context still applies', `${context.messages.length} messages for 60 turns`);
    check(context.summarisedTurns > 0 && summariserCalls === 1, 'older history is still summarised', `${context.summarisedTurns} turns`);
    check(context.summaryToStore !== null, 'the watermark is still produced');

    const stateless = new Client('stateless');
    const bare = await stateless.ask('What is fault HG-3390?');
    check(bare.status === 200 && bare.conversationId === null, 'the bare {messages} path is still stateless and unauthenticated');
  } finally {
    // --- S. Cleanup, scoped to exactly what this run created --------------
    console.log('\n-- Cleanup ---------------------------------------------------------');

    // Deleting the auth user cascades to their conversations (user_id FK) and
    // from there to their messages. No global delete of any kind.
    let usersRemoved = 0;
    for (const id of testUserIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`   could not delete test user ${id}: ${error.message}`);
      else usersRemoved++;
    }

    // Anonymous conversations this run created, addressed by the session ids
    // in the test clients' own cookie jars.
    let anonRemoved = 0;
    for (const client of anonymousClients) {
      const sessionId = client.cookieHeader
        .split('; ')
        .find((c) => c.startsWith('aariz_session='))
        ?.slice('aariz_session='.length);
      if (!sessionId) continue;
      const { data } = await admin
        .from('conversations')
        .delete()
        .eq('session_id', decodeURIComponent(sessionId))
        .select('id');
      anonRemoved += (data ?? []).length;
    }

    for (const id of testDocumentIds) {
      await admin.from('documents').delete().eq('id', id);
    }
    await rm(dir, { recursive: true, force: true });

    check(usersRemoved === testUserIds.length, 'test accounts removed', `${usersRemoved}/${testUserIds.length}`);
    console.log(`     anonymous test conversations removed: ${anonRemoved}`);

    /**
     * Scoped to the ids THIS RUN created, not to the whole table.
     *
     * It used to assert `count === 0` across `documents` entirely, which only
     * holds on an empty database. The moment the owner of the project uploaded
     * a real document of their own, a correct cleanup started reporting a
     * failure — and the obvious way to make it green again would have been to
     * delete somebody's actual file.
     *
     * Tracking ids is also a stronger check than counting: a global count of
     * zero would be satisfied by a run that created nothing at all, whereas
     * this fails if any specific document this run made survives.
     */
    let survivors = 0;
    for (const id of testDocumentIds) {
      const { count } = await admin
        .from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('id', id);
      survivors += count ?? 0;
    }
    check(
      survivors === 0,
      'every document this run created was removed',
      `${survivors} of ${testDocumentIds.length} still present`,
    );

    // Confirm nothing owned by a test user survived the cascade.
    let orphaned = 0;
    for (const id of testUserIds) {
      const { count } = await admin
        .from('conversations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', id);
      orphaned += count ?? 0;
    }
    check(orphaned === 0, 'no conversations remain for the test accounts', `${orphaned}`);

    const { count: globalConvos } = await admin
      .from('conversations')
      .select('*', { count: 'exact', head: true });
    console.log(
      `     database holds ${globalConvos} conversation(s) not created by this run (untouched)`,
    );
  }

  verifyConfirmationDialog();

  summary();
}

/**
 * The sign-up confirmation dialog, and the bypass it must never grow.
 *
 * Two separate things are guarded here. The first is reachability: an
 * unconfirmed account fails sign-in with wording indistinguishable from a wrong
 * password, so the confirmation step has to be impossible to miss. It was a
 * quiet line under the form, people read past it, and they burned attempts
 * retyping a password that had always been correct.
 *
 * The second matters far more. Supabase's mail quota runs out, and the obvious
 * "fix" is to confirm the account automatically when it does. That would let
 * anyone register an address they do not own by exhausting the quota first —
 * converting a rate limit into an authentication bypass. This asserts the
 * quota branch only ever changes what the user is TOLD.
 *
 * These are source assertions, and the limit is worth stating: they prove the
 * wiring exists, not that it renders. The rendering was checked separately in a
 * real browser against the live production build — portalled to `document.body`,
 * overlay covering the full 1280x720 viewport, dialog centred at 384px, focus
 * on its button, and closing on Escape, backdrop and button alike.
 */
function verifyConfirmationDialog(): void {
  console.log('\n-- The confirmation dialog after sign-up ---------------------------');

  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const panel = readFileSync(join(ROOT, 'src', 'components', 'auth-panel.tsx'), 'utf8');
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  check(/role="dialog"/.test(code), 'sign-up surfaces a dialog, not only an inline note');
  check(/aria-modal="true"/.test(code), '  announced to assistive tech as modal');
  check(/aria-labelledby=/.test(code), '  and given an accessible name');
  check(
    /createPortal\(/.test(code) && /from 'react-dom'/.test(panel),
    '  portalled out of the sidebar, which is an off-canvas drawer at narrow widths',
  );
  check(/autoFocus/.test(code), '  with focus moved into it');
  check(/'Escape'/.test(code), '  dismissible with Escape');
  check(/setConfirmEmail\(null\)/.test(code), '  and by its own control');
  check(
    /stopPropagation/.test(code),
    '  while a click on the text being read does not dismiss it',
  );
  check(
    /setNotice\(message\)/.test(code),
    'the inline reminder survives the dialog being dismissed',
  );

  console.log('\n-- The mail quota is reported, never worked around -----------------');

  check(
    /rate limit\|too many requests/.test(code),
    'an exhausted mail quota is recognised rather than shown raw',
  );
  check(
    /limit on the email service, not on your details/.test(code),
    "  and named as the provider's limit, not the user's mistake",
  );
  /**
   * The bypass assertion. `email_confirm` / `confirmUser` are the service-role
   * calls that would mark an address verified without the user proving they
   * own it; none of them belongs anywhere near a browser bundle.
   */
  for (const forbidden of ['email_confirm', 'confirmUser', 'updateUserById', 'SERVICE_ROLE']) {
    check(
      !panel.includes(forbidden),
      `  the quota path never self-confirms an account (no ${forbidden})`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
