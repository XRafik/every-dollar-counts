import { describe, it, expect, afterEach, vi } from 'vitest'
import { useLayoutEffect, type ReactNode } from 'react'
import { render, cleanup } from '@testing-library/react'
import { ScrollToHashTarget } from '@/components/ScrollToHashTarget'

// components/ScrollToHashTarget.tsx: a full page load of /settings#category-rules lands on the card,
// even when the browser's own scroll to it came before the card was there (#156).

// jsdom keeps the page at 0 and does not scroll it, so each test says how far it has scrolled.
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
// component, with the page already scrolled `scrolled` pixels.
function settingsAt(address: string, { scrolled = 0, card = true } = {}) {
  window.history.replaceState(null, '', address)
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scrolled })
  const page = () => (
    <div>
      {card && <div id="category-rules">Category rules</div>}
      <ScrollToHashTarget id="category-rules" />
    </div>
  )
  const view = render(page())
  return { rerender: () => view.rerender(page()) }
}

describe('ScrollToHashTarget', () => {
  it('scrolls to the element when the page loaded at its top with its #fragment', () => {
    const scrolled = spyOnScroll()
    settingsAt('/settings#category-rules')
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(document.getElementById('category-rules'))
  })

  it('scrolls once, and not again when the page renders again', () => {
    const scrolled = spyOnScroll()
    const { rerender } = settingsAt('/settings#category-rules')
    rerender()
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it.each(['/settings', '/settings#', '/settings#category', '/settings#category-rules-2', '/settings#Category-Rules'])(
    'does nothing at %s',
    (address) => {
      const scrolled = spyOnScroll()
      settingsAt(address)
      expect(scrolled).not.toHaveBeenCalled()
    }
  )

  // Something has scrolled the page already: Next's router, after a tap in the app; the browser, to
  // the fragment; or the person. Moving it again would yank them.
  it('does nothing once the page has scrolled at all', () => {
    const scrolled = spyOnScroll()
    settingsAt('/settings#category-rules', { scrolled: 1 })
    expect(scrolled).not.toHaveBeenCalled()
  })

  // After a tap in the app, Next's router scrolls to the card in a layout effect of the page's own
  // segment, which sits above the card, so it runs after the card's own layout effects. The
  // component waits until the router has scrolled, and leaves the page where the router put it.
  it('leaves a tap in the app to the router, which scrolls as the page commits', () => {
    const scrolled = spyOnScroll()
    window.history.replaceState(null, '', '/settings#category-rules')
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })
    function Router({ children }: { children: ReactNode }) {
      useLayoutEffect(() => {
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 1328 })
      }, [])
      return children
    }
    render(
      <Router>
        <div id="category-rules">Category rules</div>
        <ScrollToHashTarget id="category-rules" />
      </Router>
    )
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('does nothing, and throws nothing, when the page has no such element', () => {
    const scrolled = spyOnScroll()
    expect(() => settingsAt('/settings#category-rules', { card: false })).not.toThrow()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('draws nothing', () => {
    spyOnScroll()
    const { container } = render(<ScrollToHashTarget id="category-rules" />)
    expect(container.innerHTML).toBe('')
  })
})
