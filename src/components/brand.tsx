/**
 * AARIZ AI brand elements.
 *
 * Built from CSS gradients and one inline SVG path — no icon library, no font
 * package, no extra dependency.
 */

interface BrandMarkProps {
  /** Sizing utilities, e.g. "h-8 w-8". */
  className?: string;
}

/** The logo mark: a gradient tile with a spark glyph. */
export function BrandMark({ className = 'h-8 w-8' }: BrandMarkProps) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white shadow-sm ${className}`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-[58%] w-[58%]">
        <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" />
      </svg>
    </span>
  );
}

interface WordmarkProps {
  className?: string;
}

/**
 * The "AARIZ AI" wordmark. Rendered as real text so it is selectable and
 * announced correctly by screen readers.
 */
export function Wordmark({ className = '' }: WordmarkProps) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      AARIZ<span className="text-indigo-600 dark:text-indigo-400"> AI</span>
    </span>
  );
}
