/**
 * Minimal .env.local loader for standalone scripts.
 *
 * Next.js loads .env.local automatically; `node --experimental-strip-types`
 * does not. Shared by every script here so the parser exists once rather than
 * being copied per file. Values are never logged.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvLocal(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Real environment variables win over the file.
    if (value.length > 0 && !process.env[key]) process.env[key] = value;
  }
}
