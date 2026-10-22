import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WhenSized } from '@/components/ui/WhenSized'

// A ResizeObserver the test drives, in place of the browser's (jsdom has none). The browser reports
// a box's size when it starts observing it, if the box has one, and again whenever the size changes;
// a box hidden with display:none has none, so starting to observe it reports nothing. `resize`
// stands for each of those reports.
type Watch = { callback: ResizeObserverCallback; boxes: Set<Element>; observer: ResizeObserver }
let watches: Watch[] = []
let browserObserver: typeof ResizeObserver | undefined

beforeEach(() => {
  browserObserver = globalThis.ResizeObserver
  watches = []
  globalThis.ResizeObserver = class {
    private watch: Watch
    constructor(callback: ResizeObserverCallback) {
      this.watch = { callback, boxes: new Set(), observer: this as unknown as ResizeObserver }
      watches.push(this.watch)
    }
    observe(box: Element) {
      this.watch.boxes.add(box)
    }
    unobserve(box: Element) {
      this.watch.boxes.delete(box)
    }
    disconnect() {
      this.watch.boxes.clear()
    }
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = browserObserver as typeof ResizeObserver
})

function resize(box: Element, width: number, height: number) {
  act(() => {
    for (const w of watches) {
      if (!w.boxes.has(box)) continue
      w.callback([{ target: box, contentRect: { width, height } } as unknown as ResizeObserverEntry], w.observer)
    }
  })
}

// Counts its mounts and unmounts, standing in for a chart.
const life = { mounted: 0, unmounted: 0 }
function Chart() {
  useEffect(() => {
    life.mounted++
    return () => {
      life.unmounted++
    }
  }, [])
  return <p>chart</p>
}

function box() {
  const { container } = render(
    <WhenSized className="hidden md:block" style={{ width: '100%', height: 340 }}>
      <Chart />
    </WhenSized>
  )
  return container.firstElementChild!
}

// #116: one of a chart's two instances is always hidden by CSS. recharts measures the hidden one at
// 0x0 and warns, in production too, so the chart inside is mounted only while its box has a size.
describe('WhenSized', () => {
  beforeEach(() => {
    life.mounted = 0
    life.unmounted = 0
  })

  it('renders nothing inside a box with no size', () => {
    const el = box()
    expect(screen.queryByText('chart')).toBeNull()
    expect(life.mounted).toBe(0)
    // The box itself is there, as the page laid it out.
    expect(el.className).toBe('hidden md:block')
    expect((el as HTMLElement).style.height).toBe('340px')
  })

  it('renders its children once the box has a size', () => {
    const el = box()
    resize(el, 800, 340)
    expect(screen.getByText('chart')).toBeTruthy()
    expect(life.mounted).toBe(1)
  })

  // A window resized across md: the shown box is hidden, and the hidden one shown.
  it('unmounts them when the box loses its size, and mounts them again when it gets one back', () => {
    const el = box()
    resize(el, 800, 340)
    resize(el, 0, 0)
    expect(screen.queryByText('chart')).toBeNull()
    expect(life.unmounted).toBe(1)
    resize(el, 600, 340)
    expect(screen.getByText('chart')).toBeTruthy()
    expect(life.mounted).toBe(2)
  })

  // recharts warns when either side is 0, so a box needs both.
  it.each([
    [800, 0],
    [0, 340],
  ])('counts %ix%i as no size', (width, height) => {
    const el = box()
    resize(el, width, height)
    expect(screen.queryByText('chart')).toBeNull()
  })

  it('stops observing the box when it unmounts', () => {
    const { unmount } = render(
      <WhenSized>
        <Chart />
      </WhenSized>
    )
    expect(watches.map((w) => w.boxes.size)).toEqual([1])
    unmount()
    expect(watches.map((w) => w.boxes.size)).toEqual([0])
  })

  // The server cannot measure, so it sends the box and nothing in it: the page keeps its layout,
  // and the chart arrives once the browser has measured the box it is shown in.
  it('sends the box, with its classes and size, and nothing in it from the server', () => {
    expect(
      renderToStaticMarkup(
        <WhenSized className="md:hidden" style={{ width: '100%', height: 280 }}>
          <Chart />
        </WhenSized>
      )
    ).toBe('<div class="md:hidden" style="width:100%;height:280px"></div>')
  })
})
