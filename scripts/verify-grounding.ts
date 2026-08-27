#!/usr/bin/env node
/**
 * Grounding — does the assistant refuse what its documents do not support?
 *
 * WHY THIS IS A SEPARATE SUITE
 * ----------------------------
 * `verify-rag.ts` proves the retrieval machinery works: that a question finds
 * the right chunk, that citations point somewhere real, that an injected
 * instruction inside a document is ignored. This suite asks a different and
 * narrower question — when the evidence is NOT there, does the model say so?
 *
 * That failure mode is the one users cannot detect. A wrong citation is
 * visible; a fluent, correct-sounding answer assembled from the model's
 * training data looks exactly like a well-grounded one. It was real here:
 * against a corpus about a logistics company, "What is the capital of
 * Mongolia?" returned "The capital city of Mongolia is Ulaanbaatar." — with
 * retrieval having correctly returned nothing at all.
 *
 * WHAT MAKES THESE DETERMINISTIC
 * ------------------------------
 * Temperature 0, and fixtures full of invented identifiers — "TL-4402",
 * "QN-8817" — that exist in no training corpus. A model cannot accidentally
 * produce them from memory, so a hit proves retrieval, and their absence in a
 * refusal proves the refusal is real rather than evasive phrasing.
 *
 * The judgement of "did it refuse?" is a phrase match rather than a second
 * model call, so the result does not depend on a grader's mood. The pattern is
 * deliberately broad on wording and strict on substance: it accepts any way of
 * saying "not in the documents" and is checked ALONGSIDE the absence of the
 * invented fact, so a refusal that nonetheless leaks the answer still fails.
 *
 * Run:
 *   LLM_PROVIDER=gemini node --experimental-strip-types scripts/verify-grounding.ts
 */

import { prepareGroundedTurn } from '../src/lib/rag.ts';
import { ingestBuffer } from '../src/lib/ingest/pipeline.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import type { LlmProvider } from '../src/lib/llm/types.ts';
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

/**
 * Ways of saying "that is not in the documents".
 *
 * Broad on purpose. Pinning the exact sentence would test the model's phrasing
 * rather than its behaviour, and would fail the moment a model reworded a
 * perfectly correct refusal. Substance is enforced separately by requiring that
 * the withheld fact does not appear.
 */
const REFUSAL =
  /do(?:es)? not (?:cover|contain|include|have|provide|mention|specify)|not (?:covered|contained|mentioned|specified|available|present|included|found) (?:in|within)|no (?:relevant |such )?(?:information|documents|details|data)|cannot (?:answer|determine|find)|unable to (?:answer|determine)|don't (?:have|contain)|insufficient (?:information|context)|nothing (?:in|about)/i;

interface Scenario {
  name: string;
  question: string;
  /** Must appear in a correct answer. */
  mustContain?: RegExp;
  /** Must NOT appear — the fact the model should be withholding. */
  mustNotContain?: RegExp;
  expectRefusal: boolean;
  /** Sources are expected to be empty (nothing retrieved). */
  expectNoSources?: boolean;
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Grounding — refusing what the documents do not support ===\n');

  if (!isSupabaseConfigured()) {
    block('Supabase is not configured');
    summary();
    return;
  }

  const providerId = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  let provider: LlmProvider;
  // Imported inside the branch rather than at the top: `llm/ollama.ts` resolves
  // its imports through the `@/` alias, which Next understands and plain Node
  // does not, so loading it unconditionally breaks this suite under Gemini.
  if (providerId === 'gemini') {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) {
      block('GEMINI_API_KEY is not set', 'this suite needs a real provider');
      summary();
      return;
    }
    const { createGeminiProvider, getGeminiModel } = await import('../src/lib/llm/gemini.ts');
    provider = createGeminiProvider({ apiKey: key, model: getGeminiModel() });
  } else {
    const model = process.env.OLLAMA_MODEL?.trim();
    if (!model) {
      block('OLLAMA_MODEL is not set');
      summary();
      return;
    }
    const { createOllamaProvider } = await import('../src/lib/llm/ollama.ts');
    provider = createOllamaProvider({
      baseUrl: process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434',
      model,
    });
  }
  console.log(`   provider=${providerId} model=${provider.model}\n`);

  const admin = getSupabaseAdminClient();

  /**
   * Everything this run creates, tracked by id.
   *
   * Cleanup deletes exactly these and nothing else. The project owner has real
   * documents in this database, and a suite that tidied up by emptying a table
   * would destroy them — so the cleanup can only ever reach rows it made.
   */
  const createdDocuments: string[] = [];
  const createdUsers: string[] = [];

  /** Ask one question and return the model's answer plus what was retrieved. */
  async function ask(
    question: string,
    ownerId: string | null,
  ): Promise<{ answer: string; sourceCount: number; sourceIds: string[] }> {
    const turn = await prepareGroundedTurn(question, { ownerId });
    const answer = await provider.generate({
      messages: turn.messages,
      // Deterministic as far as the provider allows.
      temperature: 0,
      maxTokens: 400,
    });
    return {
      answer,
      sourceCount: turn.sources.length,
      sourceIds: turn.sources.map((source) => source.documentId),
    };
  }

  try {
    // =======================================================================
    console.log('-- Fixtures -------------------------------------------------------');

    const handbook =
      'Thornbury Logistics Handbook\n\n' +
      'Thornbury Logistics operates a depot network across the northern corridor.\n' +
      'The depot at Ashfield runs on shift pattern TL-4402 during the winter months.\n' +
      'Fuel reconciliation is performed weekly using form TL-9911.\n';

    const ingested = await ingestBuffer(Buffer.from(handbook, 'utf8'), 'thornbury-handbook.txt', {
      ownerId: null,
      byteSize: handbook.length,
    });
    if (ingested.documentId === null) {
      block('the fixture document could not be ingested', ingested.detail ?? '');
      summary();
      return;
    }
    createdDocuments.push(ingested.documentId);
    check(true, 'fixture corpus ingested', `${ingested.chunkCount} chunk(s)`);

    // =======================================================================
    console.log('\n-- The six grounding cases ----------------------------------------');

    const scenarios: Scenario[] = [
      {
        name: 'answer IS in the document',
        question: 'What shift pattern does the Ashfield depot run during winter?',
        mustContain: /TL-4402/i,
        expectRefusal: false,
      },
      {
        name: 'answer is PARTIALLY supported',
        question: 'What shift pattern does Ashfield run in winter, and who signs it off?',
        // The supported half must still be answered rather than the whole
        // question refused, and the unsupported half must be declined. A model
        // that refuses everything is as wrong as one that invents a name.
        mustContain: /TL-4402/i,
        expectRefusal: true,
      },
      {
        name: 'answer is ABSENT but the topic is related',
        question: 'What is the name of the depot manager at Ashfield?',
        expectRefusal: true,
      },
      {
        name: 'unrelated general-knowledge question',
        question: 'What is the capital of Mongolia?',
        mustNotContain: /Ulaanbaatar/i,
        expectRefusal: true,
        expectNoSources: true,
      },
      {
        name: 'unrelated general-knowledge question (second)',
        question: 'Who wrote the novel Pride and Prejudice?',
        mustNotContain: /Austen/i,
        expectRefusal: true,
        expectNoSources: true,
      },
    ];

    for (const scenario of scenarios) {
      const result = await ask(scenario.question, null);
      const refused = REFUSAL.test(result.answer);
      const preview = JSON.stringify(result.answer.slice(0, 110));

      check(
        refused === scenario.expectRefusal,
        `${scenario.name}: ${scenario.expectRefusal ? 'refuses' : 'answers'}`,
        preview,
      );

      if (scenario.mustContain) {
        check(
          scenario.mustContain.test(result.answer),
          `  and states the supported fact`,
          scenario.mustContain.source,
        );
      }
      if (scenario.mustNotContain) {
        check(
          !scenario.mustNotContain.test(result.answer),
          `  and does NOT leak the answer from training data`,
          scenario.mustNotContain.source,
        );
      }
      if (scenario.expectNoSources) {
        check(
          result.sourceCount === 0,
          `  with nothing retrieved, so there is nothing to cite`,
          `${result.sourceCount} source(s)`,
        );
        // The strongest citation check available: with zero sources, any
        // bracketed citation in the answer is fabricated by definition.
        check(
          !/\[\d+\]/.test(result.answer),
          `  and fabricates no citation marker`,
          preview,
        );
      }
    }

    // =======================================================================
    console.log('\n-- No documents uploaded at all ------------------------------------');

    /**
     * A user who owns nothing.
     *
     * Scoping retrieval to their id searches an empty corpus without deleting
     * anything, which is both safer and a truer model of a new account than
     * emptying the shared corpus would be.
     */
    const emptyUserEmail = `grounding-empty-${Date.now()}@example.test`;
    const { data: emptyUser, error: emptyError } = await admin.auth.admin.createUser({
      email: emptyUserEmail,
      password: `Gr-${Date.now()}-Aa1!`,
      email_confirm: true,
    });
    if (emptyError || !emptyUser.user) {
      block('could not create the empty-corpus user', emptyError?.message ?? '');
    } else {
      createdUsers.push(emptyUser.user.id);
      const result = await ask(
        'What shift pattern does the Ashfield depot run during winter?',
        emptyUser.user.id,
      );
      check(result.sourceCount === 0, 'a user with no documents retrieves nothing', `${result.sourceCount}`);
      check(
        REFUSAL.test(result.answer),
        '  and is told the documents do not contain the answer',
        JSON.stringify(result.answer.slice(0, 110)),
      );
      check(
        !/TL-4402/i.test(result.answer),
        '  and is NOT given content from another corpus',
        JSON.stringify(result.answer.slice(0, 90)),
      );
    }

    // =======================================================================
    console.log('\n-- Two users, two corpora ------------------------------------------');

    const stamp = Date.now();
    const owners: { id: string; email: string; fact: string; documentId: string }[] = [];

    for (const [index, spec] of [
      { fact: 'QN-8817', body: 'Quarry Notes\n\nThe Tamsin quarry operates under permit QN-8817.\n' },
      { fact: 'RV-2244', body: 'Riverside Notes\n\nThe Riverside site operates under permit RV-2244.\n' },
    ].entries()) {
      const email = `grounding-owner-${index}-${stamp}@example.test`;
      const { data: user, error } = await admin.auth.admin.createUser({
        email,
        password: `Gr-${stamp}-Aa1!`,
        email_confirm: true,
      });
      if (error || !user.user) {
        block(`could not create owner ${index}`, error?.message ?? '');
        continue;
      }
      createdUsers.push(user.user.id);

      const result = await ingestBuffer(Buffer.from(spec.body, 'utf8'), `owner-${index}-${stamp}.txt`, {
        ownerId: user.user.id,
        byteSize: spec.body.length,
      });
      if (result.documentId === null) {
        block(`could not ingest owner ${index}'s document`, result.detail ?? '');
        continue;
      }
      createdDocuments.push(result.documentId);
      owners.push({ id: user.user.id, email, fact: spec.fact, documentId: result.documentId });
    }

    if (owners.length === 2) {
      const [alice, bob] = owners;

      const aliceOwn = await ask('What permit does the Tamsin quarry operate under?', alice.id);
      check(
        new RegExp(alice.fact, 'i').test(aliceOwn.answer),
        "user A can retrieve user A's own document",
        JSON.stringify(aliceOwn.answer.slice(0, 90)),
      );
      check(
        aliceOwn.sourceIds.every((id) => id !== bob.documentId),
        "  and never cites user B's document",
        `${aliceOwn.sourceIds.length} source(s)`,
      );

      // The isolation claim that matters: B asks for A's fact by name.
      const bobProbing = await ask('What permit does the Tamsin quarry operate under?', bob.id);
      check(
        !new RegExp(alice.fact, 'i').test(bobProbing.answer),
        "user B cannot retrieve user A's document content",
        JSON.stringify(bobProbing.answer.slice(0, 90)),
      );
      check(
        bobProbing.sourceIds.every((id) => id !== alice.documentId),
        "  and no citation points at user A's document",
        `${bobProbing.sourceIds.length} source(s)`,
      );
      check(
        REFUSAL.test(bobProbing.answer),
        '  and B is told the answer is not in their documents',
        JSON.stringify(bobProbing.answer.slice(0, 110)),
      );
    }
  } finally {
    // =======================================================================
    console.log('\n-- Cleanup ---------------------------------------------------------');

    let documentsRemoved = 0;
    for (const id of createdDocuments) {
      const { error } = await admin.from('documents').delete().eq('id', id);
      if (!error) documentsRemoved++;
    }
    let usersRemoved = 0;
    for (const id of createdUsers) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error) usersRemoved++;
    }

    check(
      documentsRemoved === createdDocuments.length,
      'every document this run created was removed',
      `${documentsRemoved}/${createdDocuments.length}`,
    );
    check(
      usersRemoved === createdUsers.length,
      'every account this run created was removed',
      `${usersRemoved}/${createdUsers.length}`,
    );

    // Proof that cleanup was surgical rather than broad. Anything else in the
    // database — the project owner's own documents — must be untouched.
    const { count } = await admin.from('documents').select('*', { count: 'exact', head: true });
    console.log(`     ${count} document(s) belonging to someone else were left alone`);
  }

  summary();
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
