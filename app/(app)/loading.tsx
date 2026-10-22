// What every tab shows from the tap until its page has been read (#156). Every page under app/(app)
// is dynamic, and without a loading boundary Next prefetched none of them: a tap left the old page
// up, unchanged, until the new one was ready. This one boundary covers every tab, as
// app/(app)/error.tsx does. The tab bar's links prefetch the layout down to it, so a tap shows it at
// once.
//
// Plain shapes, since it stands in for every page: a figure here would be one with no "isn't
// syncing" banner beside it (#135), and a word or link one that no page asked for. The title bar has
// PageHeader's title's size and place, so the title does not move when the page arrives. Every shape
// is filled, with no white card or border, so with Reduce Motion on, when the pulse stops, it still
// reads as a placeholder rather than a page that loaded empty.
//
// Keep it the only loading boundary under app/(app), and keep <Suspense> away from a card a link
// scrolls to. Next's router scrolls a tap in the app to a link's #target from the page's own
// segment, which here mounts with the page, so /settings#category-rules lands on its card. A
// loading.tsx in a folder below, or a <Suspense> around the card, has the router try that scroll
// while a placeholder is up, find no target and drop it (tests/unit/app-loading.test.tsx,
// tests/unit/settings-page.test.tsx).
//
// A full page load of that address, as from a new tab, is the browser's to scroll, not the
// router's, and it can do so before the page has streamed in behind this placeholder.
// ScrollToHashTarget, in the Settings page, puts the card in view then.
//
// Not covered: a tap in the app whose fetch of the page fails. The router falls back to loading the
// address in full, but that is the address it already showed with this placeholder, and with a
// #fragment the browser takes it as a jump within the page. Nothing loads, and the placeholder
// stays up until the person taps something else. A link with no #fragment loads in full.
export default function Loading() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
        <div className="space-y-2">
          <div className="h-8 w-40 max-w-full rounded-lg bg-line" />
          <div className="h-4 w-56 max-w-full rounded-md bg-line/60" />
        </div>
        <div className="h-40 rounded-card bg-line" />
      </div>
    </div>
  )
}
