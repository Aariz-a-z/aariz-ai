'use client';

/**
 * The signed-in user's document library.
 *
 * Upload, list, delete. Only the caller's own documents can appear — the API
 * lists through the user's RLS-subject client, so this component could not
 * display somebody else's even if it tried.
 *
 * The empty state is load-bearing rather than decorative: this is a
 * document-grounded assistant, so a user with no documents has nothing to ask
 * about, and saying so plainly is better than letting them wonder why every
 * answer is "the provided documents do not cover that".
 */

import { useRef, useState } from 'react';

import {
  deleteDocument,
  formatBytes,
  uploadDocument,
  type UserDocument,
} from '@/lib/documents-client';

export interface DocumentPanelProps {
  documents: UserDocument[];
  /** Called after any change, so the owner can reload the list. */
  onChanged: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Queued',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_CLASS: Record<string, string> = {
  ready: 'text-emerald-700 dark:text-emerald-400',
  failed: 'text-red-600 dark:text-red-400',
  processing: 'text-amber-700 dark:text-amber-400',
  pending: 'text-zinc-500 dark:text-zinc-400',
};

export function DocumentPanel({ documents, onChanged }: DocumentPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File | undefined): void => {
    if (!file) return;
    setBusy(true);
    setError(null);

    void uploadDocument(file)
      .then(() => onChanged())
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not upload that file.'),
      )
      .finally(() => {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = '';
      });
  };

  return (
    <section aria-label="Your documents" className="border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-zinc-600 uppercase dark:text-zinc-300">
          Documents
        </h2>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{documents.length}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt"
        disabled={busy}
        onChange={(event) => handleFile(event.target.files?.[0])}
        aria-label="Upload a document"
        className="block w-full text-xs text-zinc-600 file:mr-2 file:rounded-lg file:border file:border-zinc-300 file:bg-white file:px-2.5 file:py-1 file:text-xs file:text-zinc-800 hover:file:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-800 dark:file:text-zinc-100"
      />

      {busy && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          Uploading and processing — extracting text, chunking and embedding. This can take a
          moment on a local model.
        </p>
      )}
      {error !== null && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      {documents.length === 0 && !busy ? (
        <p className="mt-3 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          No documents yet. This assistant answers only from documents you upload, so add a PDF,
          DOCX or TXT file before asking questions.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {documents.map((document) => (
            <li
              key={document.id}
              className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-zinc-800 dark:text-zinc-100" title={document.filename}>
                  {document.filename}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  <span className={STATUS_CLASS[document.status] ?? ''}>
                    {STATUS_LABEL[document.status] ?? document.status}
                  </span>
                  {' · '}
                  {formatBytes(document.byteSize)}
                  {document.pageCount !== null && ` · ${document.pageCount} pages`}
                  {document.status === 'ready' && ` · ${document.chunkCount} chunks`}
                  {' · '}
                  {new Date(document.createdAt).toLocaleDateString()}
                </p>
                {document.status === 'failed' && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Not searchable — processing failed.
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  void deleteDocument(document.id)
                    .then(onChanged)
                    .catch((caught: unknown) =>
                      setError(caught instanceof Error ? caught.message : 'Could not delete.'),
                    );
                }}
                aria-label={`Delete ${document.filename}`}
                className="rounded p-1 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
