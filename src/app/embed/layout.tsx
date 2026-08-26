/**
 * Level 17 — layout for the embeddable widget frame.
 *
 * `/embed` is the only route in this application that may be framed, and this
 * layout is what keeps it looking like a widget rather than the site: no
 * conversation sidebar, no authentication panel, no document library. Those
 * belong to the first-party application at `/` and would be meaningless here,
 * because a third-party iframe receives none of this application's cookies and
 * therefore has no account and no saved conversations to show.
 *
 * `noindex` because a search result pointing at a bare chat frame helps nobody
 * and would present the widget shell as if it were the product.
 */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AARIZ AI',
  robots: { index: false, follow: false },
};

export default function EmbedLayout({ children }: LayoutProps<'/embed'>) {
  return <div className="flex h-full min-h-0 flex-col bg-white dark:bg-zinc-950">{children}</div>;
}
