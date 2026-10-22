'use client'

import { useLayoutEffect } from 'react'

// Opens the page on the part a link names with ?section=<id> (#156): once, as it mounts, it scrolls
// the element with that id into view. TransactionCard's "Manage in Settings" and LearnedMarker link
// to Category rules this way (lib/settings-links.ts), after a tap in the app and after a full page
// load alike.
//
// The links pass scroll={false}: the router would otherwise scroll the new page to its top after
// this, as it commits. So nothing else scrolls, and the window may still have the last page's offset,
// which is why this scrolls wherever the page is. A layout effect, so the page is first painted on
// the card rather than jumping to it. The search is read here, in the browser, rather than with
// useSearchParams, which would need a <Suspense> around the page.
export function ScrollToSection({ id }: { id: string }) {
  useLayoutEffect(() => {
    if (new URLSearchParams(window.location.search).get('section') !== id) return
    document.getElementById(id)?.scrollIntoView()
  }, [id])
  return null
}
