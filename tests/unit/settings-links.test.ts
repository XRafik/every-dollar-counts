import { describe, it, expect } from 'vitest'
import { CATEGORY_RULES_HREF } from '@/lib/settings-links'

// lib/settings-links.ts: the address TransactionCard's "Manage in Settings" and LearnedMarker open
// Settings at (#156). Their tests compare their hrefs with this constant, so it is checked here, in
// its own right.
describe('CATEGORY_RULES_HREF', () => {
  it('is Settings, opened on Category rules by a query and not a #fragment', () => {
    const url = new URL(CATEGORY_RULES_HREF, 'http://localhost')
    expect(url.origin).toBe('http://localhost')
    expect(url.pathname).toBe('/settings')
    expect(url.searchParams.get('section')).toBe('category-rules')
    expect(url.hash).toBe('')
  })
})
