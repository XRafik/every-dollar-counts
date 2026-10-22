'use client'

import { useLayoutEffect } from 'react'

// Opens the page on the part a link names with ?section=<id> (#156): once, as the page mounts, it
// scrolls the element with that id into view. TransactionCard's "Manage in Settings" and
// LearnedMarker link to Category rules this way (CATEGORY_RULES_HREF), after a tap in the app and
// after a full page load alike. Only as the page mounts: a link on the page itself that changed only
// the query would not scroll.
//
// The links pass scroll={false}. The router's own scroll for a new page runs after this one, as the
// page commits, and would take it back to its top. With it off nothing else scrolls, and the window
// may still have the last page's offset, which is why this scrolls wherever the page is.
//
// A layout effect, so after a tap in the app the page is first painted on the card rather than
// jumping to it. After a full page load the server's HTML is painted first, and this runs at
// hydration, a frame or more later. The search is read from window.location, which already holds
// the new address: the router writes it in an insertion effect (HistoryUpdater in
// next/dist/client/components/app-router.js), and those run before any layout effect.
export function ScrollToSection({ id }: { id: string }) {
  useLayoutEffect(() => {
    if (new URLSearchParams(window.location.search).get('section') !== id) return
    document.getElementById(id)?.scrollIntoView()
  }, [id])
  return null
}
