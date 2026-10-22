import { describe, it, expect, afterEach } from 'vitest'
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

// Every class on every element it draws.
function classesOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('*')].flatMap((el) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
}

// The only classes it may use, exactly as written, variant and all. It renders in <main>, between
// the shell's sticky top bar and its fixed tab bar (AppShell): taken out of the flow it could cover
// either, anything wider than the page would scroll a phone sideways, and a white card with a border
// would look like a page that had loaded empty. Each class here does none of that. A list of what to
// refuse kept missing spellings ([position:fixed], inline-[600px], md:max-w-none, relative with an
// offset), so a new class has to be added here, on purpose.
const ALLOWED = new Set([
  'space-y-6',
  'space-y-2',
  'sr-only',
  'motion-safe:animate-pulse',
  'h-8',
  'h-4',
  'h-40',
  'w-40',
  'w-56',
  'max-w-full',
  'rounded-lg',
  'rounded-md',
  'rounded-card',
  'bg-line',
  'bg-line/60',
])

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

  // With Reduce Motion the pulse stops, and what is left must still read as a placeholder: a white
  // card with a border under two faint bars looked like a page that had loaded empty. So every shape
  // is filled like the bars, and none is a white card or has a border.
  it('draws every shape filled, none as a white card', () => {
    const { container } = render(<Loading />)
    const shapes = [...container.querySelectorAll('[aria-hidden="true"] *')].filter((el) => el.children.length === 0)
    expect(shapes.length).toBeGreaterThan(0)
    for (const shape of shapes) {
      const utilities = (shape.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).map((c) => parse(c).utility)
      expect(utilities.filter((u) => /^bg-line(\/\d+)?$/.test(u))).toHaveLength(1)
      expect(utilities.filter((u) => /^(bg-(surface|white|canvas)|border)/.test(u))).toEqual([])
    }
  })

  // The pulse is for those who have not turned Reduce Motion on: every animation is under the
  // motion-safe: variant, and there is one.
  it('pulses only where motion is welcome', () => {
    const { container } = render(<Loading />)
    const animated = classesOf(container).map(parse).filter((c) => c.utility.startsWith('animate-'))
    expect(animated.length).toBeGreaterThan(0)
    for (const c of animated) expect(c.variant.split(':')).toContain('motion-safe')
  })

  it('uses only classes known to keep it in the page flow, no wider than the page', () => {
    const { container } = render(<Loading />)
    expect(classesOf(container).filter((c) => !ALLOWED.has(c))).toEqual([])
    // An inline style could do what no class shows.
    expect(container.querySelectorAll('[style]')).toHaveLength(0)
  })
})
