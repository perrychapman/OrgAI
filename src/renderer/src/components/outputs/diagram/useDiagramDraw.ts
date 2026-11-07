// Drawing a Mermaid source into a CHECKED svg root (docs/design/outputs-2.md section 8). Every drawing in the viewer, the light
// export redraw and the overview comes from here, so it all passes lib/outputSvg.ts safeMermaidSvg. Nothing is inserted as text.
import { useEffect, useRef, useState } from 'react'
import { safeMermaidSvg } from '../../../lib/outputSvg'
import { mermaidConfig, type MermaidTheme } from '../../../lib/diagramExport'

export type Drawn = { state: 'drawing' } | { state: 'ok'; root: Element } | { state: 'error'; message: string } | { state: 'refused' }

let renderSeq = 0
// Mermaid keeps global state (initialize, a temp element per render), so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()

/** Plain sentence from a mermaid parse error (first line, no stack). */
export function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const line = raw.split('\n').find((l) => l.trim()) ?? 'unknown error'
  return line.trim().replace(/[.:\s]+$/, '').slice(0, 200)
}

async function drawNow(text: string, theme: MermaidTheme): Promise<Drawn> {
  const id = `output-mermaid-${++renderSeq}`
  try {
    const m = (await import('mermaid')).default
    m.initialize(mermaidConfig(theme))
    try {
      await m.parse(text)
    } catch (e) {
      return { state: 'error', message: messageOf(e) }
    }
    const { svg } = await m.render(id, text)
    const checked = safeMermaidSvg(svg)
    return checked.ok ? { state: 'ok', root: checked.root } : { state: 'refused' }
  } catch (e) {
    return { state: 'error', message: messageOf(e) }
  } finally {
    // A failed render can leave its temp element (and mermaid's wrapper) in <body>.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** Draws through the one queue. Never rejects. */
export function drawDiagram(text: string, theme: MermaidTheme): Promise<Drawn> {
  const job = queue.then(() => drawNow(text, theme))
  queue = job.catch(() => undefined)
  return job
}

export interface DiagramDraw {
  /** What the latest source and theme did. */
  drawn: Drawn
  /** The last drawing that worked (kept through a redraw and through an error), or null. */
  good: Element | null
}

/** Draws `text` in `theme` whenever either changes; with `enabled` false nothing is drawn and the state stays 'drawing'. */
export function useDiagramDraw(text: string, theme: MermaidTheme, enabled: boolean): DiagramDraw {
  const [drawn, setDrawn] = useState<Drawn>({ state: 'drawing' })
  const [good, setGood] = useState<Element | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    if (!enabled) return undefined
    const mine = ++seq.current
    setDrawn((d) => (d.state === 'drawing' ? d : { state: 'drawing' }))
    void drawDiagram(text, theme).then((d) => {
      if (seq.current !== mine) return
      setDrawn(d)
      if (d.state === 'ok') setGood(d.root)
      // A drawing that held active content is never kept on screen, not even as the last good one.
      else if (d.state === 'refused') setGood(null)
    })
    return () => {
      seq.current++
    }
  }, [text, theme, enabled])
  return { drawn, good }
}
