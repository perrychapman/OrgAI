// Compare (S7, docs/design/outputs-2.md 12.2): two version selects, a swap, a summary spoken once, and the per-kind change view.
// Reads useOutputDetail() (output, versions, compare, announce). `output-compare[data-kind][data-state]`.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowLeftRight } from 'lucide-react'
import type { OutputDiff, OutputKind, OutputVersion } from '@shared/types'
import { Button } from '../ui/Button'
import { summarySentence } from '../../lib/outputDiff'
import { useOutputDetail } from './outputDetailContext'
import CompareBlocks from './CompareBlocks'
import CompareCells from './CompareCells'
import CompareSlides from './CompareSlides'
import CompareText from './CompareText'
import CompareTwoUp from './CompareTwoUp'
import '../../styles/outputs-compare.css'

export interface ComparePanelProps {
  /** Leave compare (back to the preview). */
  onClose(): void
}

const DRAWING_KINDS: ReadonlySet<OutputKind> = new Set(['mermaid', 'svg', 'image'])

type State = { key: string; state: 'loading' } | { key: string; state: 'error' } | { key: string; state: 'ready'; diff: OutputDiff }

function versionLabel(v: OutputVersion, current: number): string {
  const name = v.label ? ` · ${v.label}` : ''
  return `Version ${v.n}${v.n === current ? ' (current)' : ''}${name}`
}

export default function ComparePanel({ onClose }: ComparePanelProps): ReactElement | null {
  const d = useOutputDetail()
  const output = d?.output ?? null
  const versions = d?.versions ?? null
  const current = d?.currentVersion ?? 1
  const announce = d?.announce
  // Defaults: the older version against the current one.
  const initial = useMemo(() => {
    if (d?.compare) return d.compare
    const older = (versions ?? []).filter((v) => v.n !== current).map((v) => v.n)
    return { a: older.length ? Math.max(...older) : Math.max(1, current - 1), b: current }
  }, [d?.compare, versions, current])
  const [a, setA] = useState(initial.a)
  const [b, setB] = useState(initial.b)
  const [attempt, setAttempt] = useState(0)
  const [st, setSt] = useState<State | null>(null)
  const aSelect = useRef<HTMLSelectElement>(null)
  const outputId = output?.id
  const projectId = output?.projectId
  const tick = output?.updatedAt

  // The shell asked for another pair while Compare is open.
  const asked = d?.compare
  useEffect(() => {
    if (asked) {
      setA(asked.a)
      setB(asked.b)
    }
  }, [asked?.a, asked?.b]) // eslint-disable-line react-hooks/exhaustive-deps

  // The A select takes focus when Compare opens (14.3).
  useEffect(() => {
    aSelect.current?.focus()
  }, [])

  const key = `${outputId}/${a}/${b}/${attempt}`
  useEffect(() => {
    if (!outputId || !projectId) return undefined
    let live = true
    const api = window.orgai?.outputs
    if (a === b) {
      setSt({ key, state: 'ready', diff: { kind: 'none', reason: 'Pick two different versions to compare.' } })
      return undefined
    }
    if (!api) {
      setSt({ key, state: 'error' })
      return undefined
    }
    api.compare({ projectId, outputId, a, b }).then(
      (diff) => live && setSt({ key, state: 'ready', diff }),
      () => live && setSt({ key, state: 'error' })
    )
    return () => {
      live = false
    }
  }, [key, outputId, projectId, a, b, tick])

  const shown: State = st && st.key === key ? st : { key, state: 'loading' }
  const diff = shown.state === 'ready' ? shown.diff : null
  const spoken = useRef('')
  useEffect(() => {
    if (!diff || a === b) return
    const text = diff.kind === 'none' ? '' : summarySentence(diff)
    const id = `${key}|${text}`
    if (!text || spoken.current === id) return
    spoken.current = id
    announce?.(text)
  }, [diff, key, a, b, announce])

  const say = useCallback((t: string) => announce?.(t), [announce])
  if (!d || !output) return null

  const numbers = new Set<number>([a, b])
  for (const v of versions ?? []) numbers.add(v.n)
  const ordered = [...numbers].sort((x, y) => y - x)
  const byNumber = new Map((versions ?? []).map((v) => [v.n, v]))
  const optionLabel = (n: number): string => {
    const v = byNumber.get(n)
    return v ? versionLabel(v, current) : `Version ${n}${n === current ? ' (current)' : ''}`
  }
  const summary = diff && a !== b && diff.kind !== 'none' ? summarySentence(diff) : ''

  let body: ReactElement
  if (shown.state === 'loading') {
    body = (
      <p className="compare-note" data-testid="output-compare-loading">
        Comparing...
      </p>
    )
  } else if (shown.state === 'error') {
    body = (
      <div className="compare-error" role="alert">
        <p>Could not compare these versions.</p>
        <Button size="sm" testId="output-compare-retry" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    )
  } else if (DRAWING_KINDS.has(output.kind)) {
    body = <CompareTwoUp output={output} a={a} b={b} diff={shown.diff} announce={say} />
  } else if (shown.diff.kind === 'none') {
    body = (
      <p className="compare-note" data-testid="output-compare-none">
        {shown.diff.reason}
      </p>
    )
  } else if (shown.diff.kind === 'text') {
    body = <CompareText output={output} a={a} b={b} diff={shown.diff} announce={say} />
  } else if (shown.diff.kind === 'blocks') {
    body = <CompareBlocks output={output} a={a} b={b} diff={shown.diff} announce={say} />
  } else if (shown.diff.kind === 'cells') {
    body = <CompareCells output={output} a={a} b={b} diff={shown.diff} announce={say} />
  } else {
    body = <CompareSlides output={output} a={a} b={b} diff={shown.diff} announce={say} />
  }

  return (
    <section className="output-compare" data-testid="output-compare" data-kind={output.kind} data-state={shown.state} aria-label="Compare versions">
      <div className="compare-head">
        <Button variant="ghost" size="sm" icon={ArrowLeft} testId="output-compare-close" onClick={onClose}>
          Back
        </Button>
        <div className="compare-picks">
          <label className="compare-pick">
            <span>Compare</span>
            <select ref={aSelect} className="select" data-testid="output-compare-a" value={a} onChange={(e) => setA(Number(e.target.value))}>
              {ordered.map((n) => (
                <option key={n} value={n}>
                  {optionLabel(n)}
                </option>
              ))}
            </select>
          </label>
          <Button variant="ghost" size="sm" icon={ArrowLeftRight} testId="output-compare-swap" ariaLabel="Swap the two versions" onClick={() => { setA(b); setB(a) }}>
            Swap
          </Button>
          <label className="compare-pick">
            <span>with</span>
            <select className="select" data-testid="output-compare-b" value={b} onChange={(e) => setB(Number(e.target.value))}>
              {ordered.map((n) => (
                <option key={n} value={n}>
                  {optionLabel(n)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <p className="compare-summary" data-testid="output-compare-summary">
        {summary || (a === b ? 'Pick two different versions.' : '')}
      </p>
      <div className="compare-main">{body}</div>
    </section>
  )
}
