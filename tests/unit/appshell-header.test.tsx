import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { AppShell } from '@/components/AppShell'
import { buttonClass } from '@/components/ui/Button'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}))

afterEach(cleanup)

function shell() {
  const { container } = render(
    <AppShell householdName="Milne" userEmail="a@b.c">
      <p>content</p>
    </AppShell>
  )
  const header = container.querySelector('header') as HTMLElement
  const aside = container.querySelector('aside') as HTMLElement
  return {
    header,
    phoneSignOut: within(header).getByRole('button', { name: 'Sign out' }),
    sidebarSignOut: within(aside).getByRole('button', { name: 'Sign out' }),
  }
}

// The phone's top bar (#121). Sign out is its only control, and at `h-9 w-9` it was a 36x36 tap
// target: stage 5 raised the shared control classes to §7's 44px, and this button never used them.
// Asserted on class strings because jsdom computes no layout.
describe('AppShell phone header', () => {
  it('gives sign-out a 44px square hit area', () => {
    const classes = shell().phoneSignOut.className.split(/\s+/)
    expect(classes).toContain('min-h-[44px]')
    // Icon-only, so nothing else makes it 44 wide: px-3 around the 18px icon is 42.
    expect(classes).toContain('min-w-[44px]')
  })

  // The rule comes from the shared class, so a later change to buttonClass reaches this button too.
  it('takes its classes from buttonClass', () => {
    expect(shell().phoneSignOut.className).toBe(buttonClass('ghost', 'sm', 'min-w-[44px]'))
  })

  // The bigger box is phone-only because the whole bar is.
  it('keeps the bar, and so the bigger box, off the desktop layout', () => {
    expect(shell().header.className.split(/\s+/)).toContain('md:hidden')
  })

  // Desktop must not change: the sidebar's sign-out is a different button and keeps its look.
  it("leaves the sidebar's sign-out as it was", () => {
    expect(shell().sidebarSignOut.className).toBe(
      'mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white/60 transition-colors hover:bg-pine-600 hover:text-white disabled:opacity-50'
    )
  })
})
