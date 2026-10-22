import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Under app/(app)/loading.tsx a tapped link's address shows, with the placeholder, before its page
// has been read. If reading it fails, Next's router loads that address in full, and to an address
// with a #fragment the browser takes that as a jump within the page: nothing loads, and the
// placeholder stays up (#156). So no link in the app goes to a path with a #fragment; a page's part
// is named with a query instead, as lib/settings-links.ts does.

// From this file, not the working directory, so it reads this checkout wherever it runs from (#201).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Every link's destination written as a string, as an attribute (href="/x", href={'/x'},
// href={`/x`}) or as a property (href: '/x', as in AppShell's tabs), in the TSX under these folders.
const HREF = /href\s*[=:]\s*\{?\s*(["'`])(.*?)\1/g
const links = ['app', 'components'].flatMap((dir) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.tsx'))
    .flatMap((file) => {
      const path = join(dir, file)
      return [...readFileSync(join(root, path), 'utf8').matchAll(HREF)].map((m) => ({ path, href: m[2] }))
    })
)

describe('links inside the app (#156)', () => {
  // Links this test knows are there, one of each kind, so finding no #fragment means something.
  it('reads the links it checks', () => {
    expect(links).toContainEqual({ path: join('app', '(app)', 'transactions', 'page.tsx'), href: '/transactions' })
    expect(links).toContainEqual({ path: join('components', 'AppShell.tsx'), href: '/settings' })
  })

  it('go to no path with a #fragment', () => {
    expect(links.filter(({ href }) => href.startsWith('/') && href.includes('#'))).toEqual([])
  })
})
