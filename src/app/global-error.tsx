'use client';

/**
 * Level 16 — root error boundary.
 *
 * The last line of defence: this catches a failure in the root layout itself,
 * which `error.tsx` cannot, because at that point the layout that would wrap it
 * is the thing that broke.
 *
 * It must therefore render its own `<html>` and `<body>` — nothing above it
 * survives to provide them. That also means no shared styling is available, so
 * the few styles here are inline by necessity rather than by preference.
 *
 * As with the route boundary, no message and no stack: only the digest.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#fff',
          color: '#18181b',
          padding: '1.5rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '1.125rem', fontWeight: 500, margin: 0 }}>
          AARIZ AI could not start
        </h1>

        <p style={{ fontSize: '0.875rem', color: '#52525b', maxWidth: '28rem', margin: 0 }}>
          The application failed to load. Your conversations and documents are unaffected.
        </p>

        <button
          type="button"
          onClick={reset}
          style={{
            border: 'none',
            borderRadius: '0.5rem',
            background: '#059669',
            color: '#fff',
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>

        {error.digest !== undefined && (
          <p style={{ fontSize: '0.75rem', color: '#a1a1aa', margin: 0 }}>
            Reference: <code>{error.digest}</code>
          </p>
        )}
      </body>
    </html>
  );
}
