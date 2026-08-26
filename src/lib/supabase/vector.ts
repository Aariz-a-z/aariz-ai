/**
 * pgvector wire-format boundary.
 *
 * PostgREST does not carry `vector` columns as JSON arrays. It sends and
 * receives them as a bracketed string, `"[0.123,0.456,…]"`. Level 5 discovered
 * this the hard way — the verification code needed `as unknown as number[]`
 * casts in both directions, which is a smell pointing straight at a wrong type.
 *
 * So the boundary is made explicit here instead:
 *
 *     application            number[]
 *          │  toPgVector(…)
 *          ▼
 *     PostgREST / pgvector   "[0.123,0.456,…]"
 *          │  fromPgVector(…)
 *          ▼
 *     application            number[]
 *
 * `ChunkRow.embedding` is typed `string | null` because that is genuinely what
 * crosses the wire. Application code never handles that string directly; it
 * calls these two functions and works in `number[]` throughout.
 *
 * Validation here is not a duplicate of `embeddings.ts`. That module checks
 * vectors as the *model produces* them; this one checks values as they *enter
 * and leave the database*, which is where a corrupt or truncated value would
 * otherwise be stored silently and poison retrieval later.
 */

import { EMBEDDING_DIMENSION } from '../../types/database.ts';

export type PgVectorErrorCode =
  | 'not_an_array'
  | 'not_a_string'
  | 'empty_vector'
  | 'dimension_mismatch'
  | 'non_finite_value'
  | 'malformed_literal';

export class PgVectorError extends Error {
  readonly code: PgVectorErrorCode;

  constructor(code: PgVectorErrorCode, message: string) {
    super(message);
    this.name = 'PgVectorError';
    this.code = code;
  }
}

/**
 * Serialise an embedding for storage in a `vector(768)` column.
 *
 * Rejects anything the column could not faithfully hold: a wrong width, a
 * non-finite value, or an empty vector.
 */
export function toPgVector(values: number[]): string {
  if (!Array.isArray(values)) {
    throw new PgVectorError('not_an_array', 'Expected an array of numbers.');
  }
  if (values.length === 0) {
    throw new PgVectorError(
      'empty_vector',
      `Refusing to store an empty vector: the column is vector(${EMBEDDING_DIMENSION}).`,
    );
  }
  if (values.length !== EMBEDDING_DIMENSION) {
    throw new PgVectorError(
      'dimension_mismatch',
      `Expected ${EMBEDDING_DIMENSION} dimensions, received ${values.length}.`,
    );
  }

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new PgVectorError(
        'non_finite_value',
        `Value at index ${i} is ${String(value)}; pgvector accepts only finite numbers.`,
      );
    }
  }

  return `[${values.join(',')}]`;
}

/**
 * Parse a pgvector literal returned by PostgREST.
 *
 * Deliberately strict. A lenient parser that shrugged at a malformed literal
 * would hand back a short or partly-garbage vector, and the failure would only
 * appear much later as quietly poor retrieval.
 */
export function fromPgVector(value: string): number[] {
  if (typeof value !== 'string') {
    throw new PgVectorError(
      'not_a_string',
      `Expected a pgvector string literal, received ${typeof value}.`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new PgVectorError(
      'malformed_literal',
      'Expected a bracketed pgvector literal such as "[0.1,0.2]".',
    );
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    throw new PgVectorError('empty_vector', 'Vector literal contains no values.');
  }

  const parts = inner.split(',');
  const values: number[] = new Array<number>(parts.length);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim();
    if (part.length === 0) {
      throw new PgVectorError('malformed_literal', `Empty value at index ${i}.`);
    }
    // Number('') is 0 and Number('  ') is 0, so the emptiness check above
    // matters; Number('abc') is NaN, which the finiteness check catches.
    const parsed = Number(part);
    if (!Number.isFinite(parsed)) {
      throw new PgVectorError(
        'non_finite_value',
        `Value "${part}" at index ${i} is not a finite number.`,
      );
    }
    values[i] = parsed;
  }

  if (values.length !== EMBEDDING_DIMENSION) {
    throw new PgVectorError(
      'dimension_mismatch',
      `Stored vector has ${values.length} dimensions, expected ${EMBEDDING_DIMENSION}.`,
    );
  }

  return values;
}
