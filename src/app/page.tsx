import { Chat } from '@/components/chat';
import { getMaxUploadBytes } from '@/lib/documents';
import { isInferenceDisabled } from '@/lib/inference-mode';

/**
 * A server component, so the deployment's inference state is read on the
 * server and handed to the client as a single boolean.
 *
 * Deliberately NOT a `NEXT_PUBLIC_` variable. The browser needs to know one
 * thing — whether chat can work — and a boolean prop says exactly that without
 * publishing configuration, which is how an environment variable intended as a
 * feature flag ends up disclosing a provider or an address.
 */
/**
 * Rendered per request, not prerendered.
 *
 * Without this the inference flag is baked at BUILD time, and a deployment
 * whose `LLM_PROVIDER` changes afterwards serves a page inviting people to
 * chat while the API correctly refuses them — the same half-open state Level
 * 17 hit when `frame-ancestors` was baked into the routes manifest. Reading it
 * per request keeps the page and the API telling the same story.
 *
 * The cost is one server render per visit instead of a CDN hit. On a portfolio
 * demo that is negligible, and it is the right side of the trade: a page that
 * lies about what it can do is worse than a page that renders a few
 * milliseconds slower.
 */
export const dynamic = 'force-dynamic';

export default function Home() {
  /**
   * The upload ceiling is resolved HERE and handed down, for the same reason
   * `inferenceDisabled` is: a client component cannot read server-only
   * configuration, and the alternative — a `NEXT_PUBLIC_MAX_DOCUMENT_SIZE_MB` —
   * would publish configuration to every visitor to save passing one number.
   *
   * Without this the browser would keep refusing at its compiled-in default
   * while the server happily accepted larger files, which is the confusing
   * half of a drifted limit rather than the dangerous half.
   */
  return (
    <Chat inferenceDisabled={isInferenceDisabled()} maxUploadBytes={getMaxUploadBytes()} />
  );
}
