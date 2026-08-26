import type { AnswerSource } from '@/types/chat';

interface MessageSourcesProps {
  sources: AnswerSource[];
}

/**
 * The documents an answer was grounded in, shown beneath it
 * (ROADMAP.md line 630: "Show sources underneath each answer").
 *
 * The numbers match the `[1]` `[2]` citations the model is asked to place in
 * its text, so a reader can trace any claim back to its document.
 */
export function MessageSources({ sources }: MessageSourcesProps) {
  if (sources.length === 0) return null;

  return (
    <div className="flex w-full justify-start">
      <div className="max-w-[85%] sm:max-w-[75%]">
        <h3 className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {sources.length === 1 ? 'Source' : 'Sources'}
        </h3>
        <ul className="flex flex-col gap-1">
          {sources.map((source) => (
            <li key={source.chunkId}>
              <div className="flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
                <span className="mt-px shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                  {source.index}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-zinc-700 dark:text-zinc-300">
                    {source.sourceUrl ? (
                      <a
                        href={source.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline decoration-zinc-400 underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        {source.documentTitle}
                      </a>
                    ) : (
                      source.documentTitle
                    )}
                  </span>
                  <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                    section {source.chunkIndex + 1} · {(source.similarity * 100).toFixed(0)}% match
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
