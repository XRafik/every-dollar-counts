import Link from 'next/link'
import { LearnedIcon } from './ui/icons'
import { CATEGORY_RULES_HREF } from '@/lib/settings-links'

// The words for a row a merchant rule relabelled (#28 spec §8.1). One string, so the desktop link
// and the phone card cannot describe the same thing differently.
export function learnedText(category: string, merchant: string | null): string {
  return `${category}, learned from ${merchant?.trim() || 'this merchant'}. Manage in Settings → Category rules.`
}

// Beside the desktop picker. shrink-0, and the same height as the desktop select (py-1.5 + a 20px
// line + a 2px border = 34px) so the icon centres on it, while the cell's items-start keeps it at
// the top when a save error grows the picker's column. Below md it has a 44px floor each way (#122):
// it is shown only in the desktop table today, but a phone that ever gets it gets a 44x44 tap
// target, not one as narrow as its 14px icon. Both floors are released at md.
export function LearnedMarker({ category, merchant }: { category: string; merchant: string | null }) {
  const text = learnedText(category, merchant)
  return (
    <Link
      href={CATEGORY_RULES_HREF}
      // The router's own scroll would run after ScrollToSection's and take Settings back to its top.
      scroll={false}
      title={text}
      aria-label={text}
      className="flex h-[34px] min-h-[44px] min-w-[44px] shrink-0 items-center rounded text-faint transition-colors hover:text-emerald focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/40 md:min-h-0 md:min-w-0"
    >
      <LearnedIcon className="h-3.5 w-3.5" />
    </Link>
  )
}
