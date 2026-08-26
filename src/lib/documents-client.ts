/**
 * Browser-side document calls.
 *
 * No identity is sent. Ownership travels in the httpOnly auth cookie the
 * browser attaches automatically and no page script can read, so there is
 * deliberately no `userId` parameter anywhere in this file.
 */

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface UserDocument {
  id: string;
  title: string;
  filename: string;
  sourceType: string;
  status: DocumentStatus;
  byteSize: number | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    if (typeof data.error === 'string' && data.error.length > 0) return data.error;
  } catch {
    /* fall through */
  }
  return fallback;
}

/** Returns null when the caller is not signed in, so the UI can hide the panel. */
export async function listDocuments(signal?: AbortSignal): Promise<UserDocument[] | null> {
  const response = await fetch('/api/documents', { credentials: 'same-origin', signal });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await readError(response, 'Could not load your documents.'));

  const data = (await response.json()) as { documents?: UserDocument[] };
  return data.documents ?? [];
}

export async function uploadDocument(file: File, signal?: AbortSignal): Promise<UserDocument> {
  const form = new FormData();
  form.append('file', file);

  const response = await fetch('/api/documents', {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
    signal,
  });
  if (!response.ok) throw new Error(await readError(response, 'Could not upload that file.'));

  const data = (await response.json()) as { document: UserDocument };
  return data.document;
}

export async function deleteDocument(id: string): Promise<void> {
  const response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  });
  // 404 means it is already gone, which is the state the caller wanted.
  if (!response.ok && response.status !== 404) {
    throw new Error(await readError(response, 'Could not delete that document.'));
  }
}

/** Human-readable size. Null for CLI-ingested documents, which record none. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
