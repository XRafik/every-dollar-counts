import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, screen, cleanup } from '@testing-library/react'
import Loading from '@/app/(app)/loading'

// app/(app)/loading.tsx: what every tab shows from the tap until its page has been read (#156).

afterEach(() => {
  cleanup()
})

// A class as Tailwind applies it: its variants (md:, max-md:, hover:, [&>*]:) split off, and its
// important mark (!fixed in v3, fixed! in v4) dropped. A colon inside brackets is part of the value.
function parse(cls: string): { variant: string; utility: string } {
  let depth = 0
  let split = -1
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === '[' || cls[i] === '(') depth++
    else if (cls[i] === ']' || cls[i] === ')') depth--
    else if (cls[i] === ':' && depth === 0) split = i
  }
  return { variant: cls.slice(0, split + 1), utility: cls.slice(split + 1).replace(/^!|!$/g, '') }
}

describe('app/(app)/loading.tsx', () => {
  it('tells a screen reader the page is loading', () => {
    render(<Loading />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  // It stands in for every page, for as long as a page takes. A figure here would be one with no
  // "isn't syncing" banner beside it (#135), and a notice here would be one no page asked for. The
  // one word in it is the screen reader's, and nothing in it can be tapped or focused.
  it('draws no figures, words or links: only shapes, hidden from screen readers', () => {
    const { container } = render(<Loading />)
    expect(container.textContent).toBe('Loading…')
    expect(screen.getByText('Loading…').classList).toContain('sr-only')
    expect(container.querySelector('[aria-hidden="true"]')!.textContent).toBe('')
    expect(container.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0)
  })

  // It renders in <main>, between the shell's sticky top bar and its fixed tab bar (AppShell). Taken
  // out of the flow it could cover either, and anything wider than the page would scroll a phone
  // sideways. A class counts at every screen size and in every state it has a variant for.
  it('stays in the page flow, and no wider than the page', () => {
    const { container } = render(<Loading />)
    for (const el of container.querySelectorAll('*')) {
      const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).map(parse)
      const utilities = classes.map((c) => c.utility)
      expect(utilities.filter((u) => /^(fixed|absolute|sticky)$/.test(u))).toEqual([])
      // Viewport units size it by the screen, not the page.
      expect(utilities.filter((u) => /^(min-)?(w|h|size)-(screen|[sdl]?v[wh]|\[.*\d(?:[sdl]?v[wh]|vmin|vmax)\b.*\])$/.test(u))).toEqual([])
      // A negative margin reaches past the page's edge.
      expect(utilities.filter((u) => /^-(m[a-z]*|space-[xy])-|^m[a-z]*-\[-/.test(u))).toEqual([])
      // A minimum width beats max-w-full in CSS, so there is none beyond zero.
      expect(utilities.filter((u) => /^min-w-/.test(u) && u !== 'min-w-0')).toEqual([])
      // Any other width, as w-40, w-md or w-[600px], only beside max-w-full at every size, which caps
      // it at the page.
      const sized = utilities.some((u) => /^(w|size)-/.test(u) && !/^(w|size)-(full|auto|\d+\/\d+)$/.test(u))
      if (sized) expect(classes.some((c) => c.variant === '' && c.utility === 'max-w-full')).toBe(true)
      // An inline style could do any of these where no class shows it.
      expect(el.getAttribute('style')).toBeNull()
    }
  })
})

// Next's router scrolls to a link's #target from the page's own segment, the one new leaf it gives a
// navigation's scroll to. Under app/(app)/loading.tsx, a level above the route folders, that segment
// mounts with the page, and the scroll lands. A loading.tsx in any folder below, beside a page.tsx or
// above one, puts a boundary between the page and its own segment's scroll handler: the router runs
// that handler while the boundary's placeholder is up, finds no target and drops the scroll. In a
// production build, with one beside the Settings page, both links to /settings#category-rules
// (TransactionCard, LearnedMarker) landed at the top of Settings. A <Suspense> around the card does
// the same (tests/unit/settings-page.test.tsx).
describe('app/(app)/loading.tsx: links to a #target', () => {
  // From this file, not the working directory, so it checks this checkout wherever it runs from.
  const fromRoot = (path: string) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', path)

  it('is the only loading boundary under app/(app), with none in any folder below it', () => {
    const files = readdirSync(fromRoot('app/(app)'), { recursive: true, encoding: 'utf8' })
    // The walk reaches the pages, and finds this boundary, so finding no other means something.
    expect(files).toContain(join('settings', 'page.tsx'))
    expect(files).toContain('loading.tsx')
    expect(files.filter((f) => /^loading\./.test(basename(f)) && dirname(f) !== '.')).toEqual([])
  })
})
