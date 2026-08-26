#!/usr/bin/env node
/**
 * Level 17 — the "separate demo website".
 *
 * ROADMAP.md Level 17's Done-when is "A separate demo website can embed the
 * chatbot", and separate means a different ORIGIN, not a different route on
 * this application. A page served from `/demo` on the Next server would be
 * same-origin and would prove nothing: `frame-ancestors`, the
 * `Cross-Origin-Resource-Policy` relaxation and the `postMessage` origin
 * checks are all no-ops within one origin. So this serves the demo page from
 * its own port, from a server that shares no code with the application.
 *
 * Twenty-odd lines of `node:http` rather than a static-file dependency: Roadmap
 * Rule 9 keeps the dependency list small, and a fixture web server is not
 * something to take a package for.
 *
 * Run:
 *   node --experimental-strip-types scripts/demo-server.ts
 *   node --experimental-strip-types scripts/demo-server.ts 5100
 *
 * Then open http://localhost:5100 — that exact origin, since
 * http://127.0.0.1:5100 is a different one and the allowlist will refuse it.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the demo page lives. Nothing outside this directory is served. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo');

export const DEFAULT_DEMO_PORT = 5100;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function contentType(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : TYPES[path.slice(dot)]) ?? 'application/octet-stream';
}

export function createDemoServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;

    // Path traversal check. This directory holds one harmless HTML file, but a
    // fixture server that will happily read `../../.env.local` is a bad habit
    // to leave lying in a repository.
    const target = normalize(join(ROOT, decodeURIComponent(requested)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    readFile(target)
      .then((body) => {
        response.writeHead(200, {
          'content-type': contentType(target),
          // No caching: the point of this server is to re-serve a page that is
          // being edited between test runs.
          'cache-control': 'no-store',
        });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      });
  });
}

// Only when run directly, so `scripts/verify-widget.ts` can import
// `createDemoServer` and manage the lifetime itself. Compared as resolved
// paths rather than as URL strings, because on Windows the two differ in
// separator and drive-letter case.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  const port = Number(process.argv[2] ?? DEFAULT_DEMO_PORT);
  createDemoServer().listen(port, () => {
    console.log(`Demo host site: http://localhost:${port}`);
    console.log(`Serving ${ROOT}`);
  });
}
