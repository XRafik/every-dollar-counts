// §7's 44px minimum tap height for a control that is only its text (#122), read off class strings
// because jsdom computes no layout.
import { expect } from 'vitest'
import Link from 'next/link'

// tapTargetClass's tokens (components/ui/styles.ts), checked one by one so a failure names the one
// missing: the hit area grows below `md`, both minimums are released at `md`, and the text is not
// resized. Split on whitespace, so `md:min-h-0` cannot pass for `min-h-[44px]` or the reverse.
export function expectTapTarget(className: unknown) {
  const classes = String(className ?? '').split(/\s+/)
  for (const token of ['inline-flex', 'items-center', 'min-h-[44px]', 'min-w-[44px]', 'md:min-h-0', 'md:min-w-0']) {
    expect(classes, `"${token}" missing from "${String(className)}"`).toContain(token)
  }
}

type El = { type?: unknown; props?: Record<string, unknown> }

function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf((node as El).props?.children)
}

// The <a>, <Link> or <button> a Server Component writes with this text, found in the unrendered
// tree it returns. Throws when there is none, so a test cannot pass by finding nothing.
export function controlWithText(tree: unknown, text: string): El & { props: Record<string, unknown> } {
  const found: El[] = []
  const walk = (node: unknown) => {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const el = node as El
    if ((el.type === 'a' || el.type === 'button' || el.type === Link) && textOf(el.props?.children).trim() === text) {
      found.push(el)
    }
    walk(el.props?.children)
  }
  walk(tree)
  if (found.length === 0) throw new Error(`no link or button reading "${text}" in the tree`)
  return found[0] as El & { props: Record<string, unknown> }
}
