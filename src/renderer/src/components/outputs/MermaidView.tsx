import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../ui/Button'
import { SegmentedControl } from '../ui/SegmentedControl'
import { safeMermaidSvg } from '../../lib/outputSvg'

type View = 'diagram' | 'source'
type Drawn = { state: 'drawing' } | { state: 'ok'; svg: string } | { state: 'error'; message: string } | { state: 'refused' }

/** lib/theme.ts resolves System to 'dark' | 'light' and writes it as data-theme on <html>. */
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

let renderSeq = 0
// Mermaid keeps global state (initialize, a temp element per render), so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()

/** Plain sentence from a mermaid parse error (first line, no stack). */
function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const line = raw.split('\n').find((l) => l.trim()) ?? 'unknown error'
  return line.trim().replace(/[.:\s]+$/, '').slice(0, 200)
}

async function drawDiagram(text: string, theme: 'light' | 'dark'): Promise<Drawn> {
  const id = `output-mermaid-${++renderSeq}`
  try {
    const m = (await import('mermaid')).default
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // foreignObject labels are refused by the gate below, so labels are drawn as SVG text.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: theme === 'light' ? 'default' : 'dark'
    })
    try {
      await m.parse(text)
    } catch (e) {
      return { state: 'error', message: messageOf(e) }
    }
    const { svg } = await m.render(id, text)
    const checked = safeMermaidSvg(svg)
    return checked.ok ? { state: 'ok', svg: checked.svg } : { state: 'refused' }
  } catch (e) {
    return { state: 'error', message: messageOf(e) }
  } finally {
    // A failed render can leave its temp element (and mermaid's wrapper) in <body>.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** A Mermaid diagram drawn in the window, with its source one switch away. Never throws; a bad diagram shows its source. */
export default function MermaidView({ text, title, truncated }: { text: string; title: string; truncated?: boolean }): ReactElement {
  const theme = useTheme()
  const [view, setView] = useState<View>('diagram')
  const [drawn, setDrawn] = useState<Drawn>({ state: 'drawing' })
  const [copied, setCopied] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setDrawn({ state: 'drawing' })
    const job = queue.then(() => drawDiagram(text, theme))
    queue = job.catch(() => undefined)
    void job.then((d) => {
      if (seq.current === mine) setDrawn(d)
    })
    return () => {
      seq.current++
    }
  }, [text, theme])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const showSource = view === 'source' || drawn.state === 'error' || drawn.state === 'refused'

  const copy = (): void => {
    if (drawn.state !== 'ok') return
    void navigator.clipboard
      ?.writeText(drawn.svg)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  return (
    <div className="output-mermaid" data-testid="output-mermaid" data-state={drawn.state}>
      <div className="output-toolbar">
        <div data-testid="output-mermaid-view">
          <SegmentedControl<View>
            label="View"
            value={showSource ? 'source' : 'diagram'}
            onChange={setView}
            options={[
              { value: 'diagram', label: 'Diagram' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </div>
        {drawn.state === 'ok' && (
          <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy} testId="output-mermaid-copy">
            Copy SVG
          </Button>
        )}
        <span className="output-quiet" role="status" data-testid="output-mermaid-copied">
          {copied ? 'Copied.' : ''}
        </span>
      </div>
      {drawn.state === 'error' && (
        <p className="output-preview-note output-preview-problem" data-testid="output-mermaid-error">
          This diagram could not be drawn: {drawn.message}.
        </p>
      )}
      {drawn.state === 'refused' && (
        <p className="output-preview-note output-preview-problem" data-testid="output-mermaid-refused">
          OrgAI did not show this drawing because it contained active content.
        </p>
      )}
      {showSource ? (
        <pre className="output-scroll output-pre" data-testid="output-source" role="region" aria-label={`${title} source`} tabIndex={0}>
          {text}
        </pre>
      ) : drawn.state === 'drawing' ? (
        <p className="output-preview-note" role="status">
          Drawing the diagram…
        </p>
      ) : drawn.state === 'ok' ? (
        <div className="output-scroll output-mermaid-stage" role="region" aria-label={`${title} diagram`} tabIndex={0}>
          {/* The one place markup is inserted. It is safe because it passed safeMermaidSvg (parsed as XML, no script,
              foreignObject, event handler, outside link or url(), re-serialized from the checked tree) after Mermaid's
              own 'strict' sanitizer, and the window's CSP forbids script from anywhere but the app. */}
          <div className="output-mermaid-svg" data-testid="output-mermaid-svg" role="img" aria-label={title} dangerouslySetInnerHTML={{ __html: drawn.svg }} />
        </div>
      ) : null}
      {truncated && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </div>
  )
}
