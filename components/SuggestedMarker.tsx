import { SuggestedIcon } from './ui/icons'

// The words for a row Jev's suggestion relabelled (#28 spec §14.6). One string, so the desktop
// marker and the phone card cannot describe the same thing differently.
export function suggestedText(category: string): string {
  return `${category}, suggested by Jev. Pick a category to change it.`
}

// Beside the desktop picker, in LearnedMarker's box (h-[34px], shrink-0) so the row's height does
// not change. Not a link: a suggestion has no settings of its own; picking a category overrides it.
export function SuggestedMarker({ category }: { category: string }) {
  const text = suggestedText(category)
  return (
    <span role="img" title={text} aria-label={text} className="flex h-[34px] shrink-0 items-center text-faint">
      <SuggestedIcon className="h-3.5 w-3.5" />
    </span>
  )
}
