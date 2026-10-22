'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// A box that renders its children only while it has a size (#116).
//
// A chart drawn twice, once per layout, with CSS hiding one of them by width, flashes on neither
// device: the server sends both and CSS picks before anything paints. But recharts'
// ResponsiveContainer measures its box once mounted, the hidden one measures 0x0, and recharts warns
// "The width(0) and height(0) of chart should be greater than 0", in production too: it hardcodes
// isDev. So the chart goes inside this box, and mounts only while the box is shown. When the box is
// hidden again, as when a window is resized across md, the chart unmounts.
//
// The box itself, with its classes and its fixed height, goes out from the server either way, so
// the page lays out as before and nothing moves when the chart arrives. A ResizeObserver tells it
// when it has a size: it reports a box when it starts observing it, if the box has a size, and
// again whenever the size changes, and a box hidden with display:none has none. Without
// ResizeObserver nothing renders inside, and nothing is lost: ResponsiveContainer needs it to
// size a chart at all.
export function WhenSized({
  className,
  style,
  children,
}: {
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [sized, setSized] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    // One box observed, so one entry each time.
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSized(width > 0 && height > 0)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={box} className={className} style={style}>
      {sized ? children : null}
    </div>
  )
}
