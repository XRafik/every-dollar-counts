// What every tab shows from the tap until its page has been read (#156). Every page under app/(app)
// is dynamic, and without a loading boundary Next prefetched none of them: a tap left the old page
// up, unchanged, until the new one was ready. This one boundary covers every tab, as
// app/(app)/error.tsx does. The tab bar's links prefetch the layout down to it, so a tap shows it at
// once.
//
// Plain shapes, since it stands in for every page: a figure here would be one with no "isn't
// syncing" banner beside it (#135), and a word or link one that no page asked for. The title bar has
// PageHeader's title's size and place, so the title does not move when the page arrives.
//
// Keep loading boundaries a level above the route folders, as this one is. Next's router scrolls to
// a link's #target from the page's own segment, which here mounts with the page, so
// /settings#category-rules lands on its card. Beside a page.tsx, a loading.tsx makes the router try
// that scroll while the placeholder is up, find no target and drop it, and the links to Category
// rules land at the top of Settings (tests/unit/app-loading.test.tsx).
export default function Loading() {
  return (
    <div role="status" className="space-y-6">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
        <div className="space-y-2">
          <div className="h-8 w-40 max-w-full rounded-lg bg-line" />
          <div className="h-4 w-56 max-w-full rounded-md bg-line/60" />
        </div>
        <div className="h-40 rounded-card border border-line bg-surface" />
      </div>
    </div>
  )
}
