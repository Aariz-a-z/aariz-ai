interface ErrorBannerProps {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Surfaces a failed generation instead of silently dropping it — Roadmap
 * Rule 5. The original error text is shown verbatim rather than replaced by a
 * generic apology, so the actual fault is visible.
 */
export function ErrorBanner({ message, onRetry, onDismiss }: ErrorBannerProps) {
  return (
    <div className="border-t border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40">
      <div
        role="alert"
        className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2"
      >
        <p className="flex-1 text-sm text-red-800 dark:text-red-200">
          <span className="font-semibold">Could not generate a reply. </span>
          {message}
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/40"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500/30 dark:text-red-300 dark:hover:bg-red-900/40"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
