import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { safeMermaidSvg } from '../../lib/outputSvg'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'

type Drawn = { phase: 'drawing' } | { phase: 'ok'; svg: string } | { phase: 'error'; message: string } | { phase: 'refused' }

let counter = 0

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

function oneLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  const line = raw.split('\n').find((l) => l.trim()) ?? 'unknown problem'
  return line.trim().replace(/[.\s]+$/, '').slice(0, 200)
}

export default function MermaidView({ text, output }: { text: string; output: RunOutput }): ReactElement {
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [drawn, setDrawn] = useState<Drawn>({ phase: 'drawing' })
  const [copied, setCopied] = useState(false)
  const theme = useTheme()
  const seq = useRef(0)

  useEffect(() => {
    const my = ++seq.current
    const id = `orgai-mmd-${++counter}`
    setDrawn({ phase: 'drawing' })
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          theme: theme === 'light' ? 'default' : 'dark'
        })
        await mermaid.parse(text)
        const { svg } = await mermaid.render(id, text)
        if (my !== seq.current) return
        const checked = safeMermaidSvg(svg)
        setDrawn(checked.ok ? { phase: 'ok', svg: checked.svg } : { phase: 'refused' })
      } catch (e) {
        if (my !== seq.current) return
        setDrawn({ phase: 'error', message: oneLine(e) })
      } finally {
        // mermaid leaves its temporary node in the body after a failed render.
        document.getElementById(id)?.remove()
        document.getElementById(`d${id}`)?.remove()
      }
    })()
    return () => {
      seq.current++
    }
  }, [text, theme])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])

  const showSource = view === 'source' || drawn.phase === 'error' || drawn.phase === 'refused'
  const copy = (): void => {
    if (drawn.phase !== 'ok') return
    void navigator.clipboard.writeText(drawn.svg).then(() => setCopied(true), () => undefined)
  }
  return (
    <div className="output-mermaid" data-testid="output-mermaid" data-state={drawn.phase}>
      <div className="output-mermaid-bar">
        <div data-testid="output-mermaid-view">
          <SegmentedControl
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'diagram', label: 'Diagram' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </div>
        {drawn.phase === 'ok' && view === 'diagram' && (
          <Button size="sm" onClick={copy} testId="output-mermaid-copy">
            {copied ? 'Copied' : 'Copy SVG'}
          </Button>
        )}
      </div>
      <span className="sr-only" role="status">
        {copied ? 'SVG copied.' : ''}
      </span>
      {drawn.phase === 'error' && (
        <p className="output-preview-note" data-testid="output-mermaid-error">
          This diagram could not be drawn: {drawn.message}.
        </p>
      )}
      {drawn.phase === 'refused' && (
        <p className="output-preview-note" data-testid="output-mermaid-refused">
          OrgAI did not show this drawing because it contained active content.
        </p>
      )}
      {showSource ? (
        <pre className="output-pre" data-testid="output-source" role="region" aria-label={`${output.title} source`} tabIndex={0}>
          {text}
        </pre>
      ) : drawn.phase === 'drawing' ? (
        <p className="output-preview-note" role="status">
          Drawing…
        </p>
      ) : (
        drawn.phase === 'ok' && (
          <div className="output-mermaid-scroll" role="region" aria-label={`${output.title} diagram`} tabIndex={0}>
            <div
              className="output-mermaid-svg"
              data-testid="output-mermaid-svg"
              role="img"
              aria-label={output.title}
              // Checked by safeMermaidSvg: no script, foreignObject, handlers or outside references.
              dangerouslySetInnerHTML={{ __html: drawn.svg }}
            />
          </div>
        )
      )}
    </div>
  )
}
