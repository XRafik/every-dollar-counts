import { describe, it, expect, afterEach, vi } from 'vitest'
import { useLayoutEffect, type ReactNode } from 'react'
import { render, cleanup } from '@testing-library/react'
import { ScrollToSection } from '@/components/ScrollToSection'
import { CATEGORY_RULES_HREF } from '@/lib/settings-links'

// components/ScrollToSection.tsx: a link to /settings?section=category-rules opens Settings on the
// Category rules card, from a tap in the app or a full page load (#156).

const ownScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  if (ownScrollY) Object.defineProperty(window, 'scrollY', ownScrollY)
  else delete (window as { scrollY?: number }).scrollY
  delete (Element.prototype as Partial<Element>).scrollIntoView
})

function spyOnScroll() {
  const scrolled = vi.fn<(this: Element, arg?: boolean | ScrollIntoViewOptions) => void>()
  Element.prototype.scrollIntoView = scrolled
  return scrolled
}

// Settings as the component meets it, at `address`: the card (unless `card` is false) and the
// component.
function settingsAt(address: string, { card = true } = {}) {
  window.history.replaceState(null, '', address)
  const page = () => (
    <div>
      {card && <div id="category-rules">Category rules</div>}
      <ScrollToSection id="category-rules" />
    </div>
  )
  const view = render(page())
  return { rerender: () => view.rerender(page()) }
}

describe('ScrollToSection', () => {
  it.each([CATEGORY_RULES_HREF, '/settings?from=transactions&section=category-rules'])(
    'scrolls to the card at %s',
    (address) => {
      const scrolled = spyOnScroll()
      settingsAt(address)
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(scrolled.mock.contexts[0]).toBe(document.getElementById('category-rules'))
    }
  )

  it('scrolls once, and not again when the page renders again', () => {
    const scrolled = spyOnScroll()
    const { rerender } = settingsAt(CATEGORY_RULES_HREF)
    rerender()
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  // The links pass scroll={false}, so after a tap the window may still have the last page's offset,
  // and the router does not scroll. The card is this component's to bring into view wherever the
  // page is.
  it('scrolls wherever the page was left', () => {
    const scrolled = spyOnScroll()
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 900 })
    settingsAt(CATEGORY_RULES_HREF)
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  // In a layout effect, so after a tap in the app the page is first painted on the card rather than
  // jumping to it. (After a full page load the server's HTML is painted first, and this runs at
  // hydration.) A parent's layout effects run after its children's, and all of them before the
  // paint.
  it('scrolls as the card mounts, before the page is painted', () => {
    const scrolled = spyOnScroll()
    window.history.replaceState(null, '', CATEGORY_RULES_HREF)
    let scrolledBeforePaint = false
    function Page({ children }: { children: ReactNode }) {
      useLayoutEffect(() => {
        scrolledBeforePaint = scrolled.mock.calls.length === 1
      }, [])
      return children
    }
    render(
      <Page>
        <div id="category-rules">Category rules</div>
        <ScrollToSection id="category-rules" />
      </Page>
    )
    expect(scrolledBeforePaint).toBe(true)
  })

  // An old /settings#category-rules address is left to the browser's own fragment scroll, which can
  // run before the card has streamed in.
  it.each([
    '/settings',
    '/settings?section=categories',
    '/settings?section=category-rules-2',
    '/settings?section=Category-Rules',
    '/settings?tab=category-rules',
    '/settings#category-rules',
  ])('does nothing at %s', (address) => {
    const scrolled = spyOnScroll()
    settingsAt(address)
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('does nothing, and throws nothing, when the page has no such card', () => {
    const scrolled = spyOnScroll()
    expect(() => settingsAt(CATEGORY_RULES_HREF, { card: false })).not.toThrow()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('draws nothing', () => {
    spyOnScroll()
    const { container } = render(<ScrollToSection id="category-rules" />)
    expect(container.innerHTML).toBe('')
  })
})
