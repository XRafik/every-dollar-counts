import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, cleanup } from '@testing-library/react'
import Loading from '@/app/(app)/loading'

// app/(app)/loading.tsx: what every tab shows from the tap until its page has been read (#156).

afterEach(() => {
  cleanup()
})

describe('app/(app)/loading.tsx', () => {
  it('tells a screen reader the page is loading', () => {
    render(<Loading />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  // It stands in for every page, for as long as a page takes. A figure here would be one with no
  // "isn't syncing" banner beside it (#135), and a notice here would be one no page asked for.
  it('draws no figures, words or links: only shapes, hidden from screen readers', () => {
    const { container } = render(<Loading />)
    const shapes = container.querySelector('[aria-hidden="true"]')!
    expect(shapes.textContent).toBe('')
    expect(container.querySelector('a')).toBeNull()
  })

  // It renders in <main>, between the shell's sticky top bar and its fixed tab bar (AppShell). Taken
  // out of the flow it could cover either, and a bar wider than the page would scroll a phone
  // sideways.
  it('stays in the page flow, and no wider than the page', () => {
    const { container } = render(<Loading />)
    for (const el of container.querySelectorAll('*')) {
      const classes = el.getAttribute('class')?.split(/\s+/) ?? []
      expect(classes.filter((c) => /^(fixed|sticky|absolute|w-screen|h-screen|min-h-screen)$/.test(c))).toEqual([])
      // A minimum width beats max-w-full in CSS, so there is none beyond zero.
      expect(classes.filter((c) => /^min-w-/.test(c) && c !== 'min-w-0')).toEqual([])
      // A fixed width, as w-40 or w-[600px], only alongside max-w-full, which caps it at the page.
      if (classes.some((c) => /^w-(\d+(\.\d+)?|\[[^\]]+\]|px)$/.test(c))) expect(classes).toContain('max-w-full')
    }
  })
})

// Next's router scrolls to a link's #target from the page's own segment, the one new leaf it gives a
// navigation's scroll to. Under app/(app)/loading.tsx, a level above the route folders, that segment
// mounts with the page, and the scroll lands. A loading.tsx beside page.tsx runs the page's scroll
// handler while its placeholder is up instead, finds no target and drops the scroll. In a production
// build, both links to /settings#category-rules (TransactionCard, LearnedMarker) then landed at the
// top of Settings.
describe('app/(app)/loading.tsx: links to a #target', () => {
  // From this file, not the working directory, so it checks this checkout wherever it runs from.
  const fromRoot = (path: string) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', path)

  it('has no loading.tsx beside the Settings page, which links to Category rules scroll into', () => {
    expect(existsSync(fromRoot('app/(app)/settings/page.tsx'))).toBe(true)
    expect(existsSync(fromRoot('app/(app)/settings/loading.tsx'))).toBe(false)
  })
})
