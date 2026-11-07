// Compare for text kinds (markdown, text, json, and the source of a diagram or svg): Changes | Side by side (| Rendered).
// docs/design/outputs-2.md 12.2. Added = "+" and underline, removed = "-" and strike-through: never colour alone.
import type { ReactElement } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { OutputDiff, OutputDiffMark, RunOutput } from '@shared/types'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Button } from '../ui/Button'
import { Markdown } from '../Markdown'
import { changeStarts, gapText, linesOf, segmentsOf, sideRows, textRows, type SideCell, type TextRow } from '../../lib/outputDiff'
import { ChangeNavBar, currentAttr, previewTextOf, useChangeNav, useVersionPreview } from './CompareParts'
import '../../styles/outputs-compare.css'

type TextMode = 'changes' | 'side' | 'rendered'

export interface CompareTextProps {
  output: RunOutput
  a: number
  b: number
  diff: Extract<OutputDiff, { kind: 'text' }>
  announce(text: string): void
}

export function Marked({ text, marks }: { text: string; marks?: OutputDiffMark[] }): ReactElement {
  const segs = segmentsOf(text, marks)
  if (segs.length === 0) return <span className="compare-empty-line"> </span>
  return (
    <>
      {segs.map((s, i) => (s.marked ? <mark key={i} className="compare-mark">{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  )
}

const GLYPH = { add: '+', del: '-', eq: ' ' } as const
const SR = { add: 'Added: ', del: 'Removed: ', eq: '' } as const

function GapRow({ row, onExpand }: { row: Extract<TextRow, { kind: 'gap' }>; onExpand(id: string): void }): ReactElement {
  return (
    <div className="compare-gap" data-testid="output-compare-gap">
      {row.known ? (
        <Button variant="ghost" size="sm" onClick={() => onExpand(row.id)} ariaLabel={`${gapText(row.count)}, show them`}>
          {gapText(row.count)}
        </Button>
      ) : (
        <span className="compare-gap-text">{gapText(row.count)}</span>
      )}
    </div>
  )
}

function SideSide({ cell, side }: { cell?: SideCell; side: 'left' | 'right' }): ReactElement {
  if (!cell) return <div className="compare-side-cell" data-empty="true" data-side={side} aria-hidden="true" />
  return (
    <div className="compare-side-cell" data-op={cell.op} data-side={side}>
      <span className="compare-num" aria-hidden="true">{cell.n}</span>
      <span className="compare-glyph" aria-hidden="true">{GLYPH[cell.op]}</span>
      <span className="compare-text">
        <span className="sr-only">{SR[cell.op]}</span>
        <Marked text={cell.text} marks={cell.marks} />
      </span>
    </div>
  )
}

export default function CompareText({ output, a, b, diff, announce }: CompareTextProps): ReactElement {
  const [mode, setMode] = useState<TextMode>('changes')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const body = useRef<HTMLDivElement>(null)
  const isMarkdown = output.kind === 'markdown'
  const bPrev = useVersionPreview(output, b)
  const aPrev = useVersionPreview(output, a, mode === 'rendered')
  const bText = previewTextOf(bPrev)
  const bLines = useMemo(() => (bText === null ? null : linesOf(bText)), [bText])
  const rows = useMemo(() => textRows(diff, bLines, expanded), [diff, bLines, expanded])
  const side = useMemo(() => (mode === 'side' ? sideRows(rows) : []), [mode, rows])
  const count = useMemo(() => changeStarts(rows).length, [rows])
  const nav = useChangeNav(count, body, announce)
  const expand = (id: string): void => {
    setExpanded((s) => new Set(s).add(id))
    body.current?.focus()
  }
  const options: { value: TextMode; label: string }[] = [
    { value: 'changes', label: 'Changes' },
    { value: 'side', label: 'Side by side' },
    ...(isMarkdown ? [{ value: 'rendered' as const, label: 'Rendered' }] : [])
  ]
  const aText = previewTextOf(aPrev)
  return (
    <div className="compare-pane" data-testid="output-compare-text" data-mode={mode} onKeyDown={nav.onKeyDown}>
      <div className="compare-bar">
        <div data-testid="output-compare-mode">
          <SegmentedControl label="Show" value={mode} options={options} onChange={setMode} />
        </div>
        {mode !== 'rendered' && <ChangeNavBar count={count} nav={nav} />}
      </div>
      {diff.truncated && <p className="compare-note">Only the first changes are shown. Open the file to see the rest.</p>}
      <div ref={body} className="compare-body" data-testid="output-compare-body" role="region" tabIndex={0} aria-label={`Changes between version ${a} and version ${b}`}>
        {mode === 'rendered' ? (
          <div className="compare-rendered">
            <section className="compare-rendered-col" aria-label={`Version ${a}`}>
              <h5 className="compare-col-head">Version {a}</h5>
              {aText === null ? <p className="compare-note">{aPrev.state === 'error' ? 'Could not load this version.' : 'Loading...'}</p> : <Markdown text={aText} />}
            </section>
            <section className="compare-rendered-col" aria-label={`Version ${b}`}>
              <h5 className="compare-col-head">Version {b}</h5>
              {bText === null ? <p className="compare-note">{bPrev.state === 'error' ? 'Could not load this version.' : 'Loading...'}</p> : <Markdown text={bText} />}
            </section>
          </div>
        ) : mode === 'changes' ? (
          <div className="compare-lines">
            {rows.map((r, i) =>
              r.kind === 'gap' ? (
                <GapRow key={r.id} row={r} onExpand={expand} />
              ) : (
                <div key={i} className="compare-line" data-op={r.op} {...currentAttr(nav.index, r.change, r.first)}>
                  <span className="compare-num" aria-hidden="true">{r.a ?? ''}</span>
                  <span className="compare-num" aria-hidden="true">{r.b ?? ''}</span>
                  <span className="compare-glyph" aria-hidden="true">{GLYPH[r.op]}</span>
                  <span className="compare-text">
                    <span className="sr-only">{SR[r.op]}</span>
                    <Marked text={r.text} marks={r.marks} />
                  </span>
                </div>
              )
            )}
            {rows.length === 0 && <p className="compare-note">No changes.</p>}
          </div>
        ) : (
          <div className="compare-side">
            <div className="compare-side-head">
              <span>Version {a}</span>
              <span>Version {b}</span>
            </div>
            {side.map((r, i) =>
              r.kind === 'gap' ? (
                <GapRow key={r.id} row={r} onExpand={expand} />
              ) : (
                <div key={i} className="compare-side-row" {...currentAttr(nav.index, r.change, r.first)}>
                  <SideSide cell={r.left} side="left" />
                  <SideSide cell={r.right} side="right" />
                </div>
              )
            )}
            {side.length === 0 && <p className="compare-note">No changes.</p>}
          </div>
        )}
      </div>
    </div>
  )
}
