'use client'

import { useEffect } from 'react'

// Puts the element `id` in view once, after a full page load of an address ending #<id> that left
// the page at its top (#156). Under app/(app)/loading.tsx a full load streams the page in after the
// placeholder, and the browser's own scroll to the fragment can come before the element is there:
// 11 full loads of /settings#category-rules in 34 ended at the top of Settings. That is a link
// opened in a new tab, a reload, or an address typed or pasted.
//
// Rendered in the page, so it mounts only once the element is in place. It scrolls only if nothing
// has: not the router, which scrolls a tap in the app to the element as the page commits, not the
// browser, and not the person.
export function ScrollToHashTarget({ id }: { id: string }) {
  useEffect(() => {
    if (window.location.hash !== `#${id}` || window.scrollY !== 0) return
    document.getElementById(id)?.scrollIntoView()
  }, [id])
  return null
}
