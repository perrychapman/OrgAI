// Compare for Word documents: the preview blocks of both versions, aligned by main's 'blocks' diff (equal, inserted, deleted,
// changed with word marks). Plain text only; tables compare by cell text. docs/design/outputs-2.md 12.2.
import type { ReactElement } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { DocumentBlock, OutputDiff, OutputDiffMark, RunOutput } from '@shared/types'
import { Button } from '../ui/Button'
import { blockGapText, blockRows, tableCells, type BlockRowView, type BlockSide } from '../../lib/outputDiff'
import { ChangeNavBar, useChangeNav, useVersionPreview } from './CompareParts'
import { Marked } from './CompareText'
import '../../styles/outputs-compare.css'

export interface CompareBlocksProps {
  output: RunOutput
  a: number
  b: number
  diff: Extract<OutputDiff, { kind: 'blocks' }>
  announce(text: string): void
}

const GLYPH = { add: '+', del: '-', eq: ' ' } as const
const SR = { add: 'Added: ', del: 'Removed: ', eq: '' } as const

function BlockBody({ side, marks }: { side: BlockSide; marks?: OutputDiffMark[] }): ReactElement {
  if (side.type === 'table') {
    const grid = tableCells(side.text, marks)
    const head = side.headerRows ?? 0
    return (
      <table className="compare-table">
        <tbody>
          {grid.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const Tag = r < head ? 'th' : 'td'
                return (
                  <Tag key={c}>
                    {cell.length === 0 ? null : cell.map((s, i) => (s.marked ? <mark key={i} className="compare-mark">{s.text}</mark> : <span key={i}>{s.text}</span>))}
                  </Tag>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (side.type === 'list') {
    // Offsets run across the joined text, so each item keeps its own start.
    let at = 0
    return (
      <ul className="compare-list">
        {side.text.split('\n').map((item, i) => {
          const start = at
          at += item.length + 1
          const local = (marks ?? []).map(([s, e]) => [s - start, e - start] as OutputDiffMark).filter(([s, e]) => e > 0 && s < item.length)
          return (
            <li key={i}>
              <Marked text={item} marks={local} />
            </li>
          )
        })}
      </ul>
    )
  }
  const cls = side.type === 'heading' ? 'compare-block-heading' : side.type === 'code' ? 'compare-block-code' : undefined
  return (
    <div className={cls} data-level={side.level}>
      <Marked text={side.text} marks={marks} />
    </div>
  )
}

function Part({ op, side, marks, current, attrs }: { op: 'add' | 'del' | 'eq'; side: BlockSide; marks?: OutputDiffMark[]; current: boolean; attrs: Record<string, unknown> }): ReactElement {
  return (
    <div className="compare-block" data-op={op} data-type={side.type} data-testid="output-compare-block" data-current={current ? 'true' : undefined} {...attrs}>
      <span className="compare-glyph" aria-hidden="true">{GLYPH[op]}</span>
      <div className="compare-block-body">
        <span className="sr-only">{SR[op]}</span>
        <BlockBody side={side} marks={marks} />
      </div>
    </div>
  )
}

function Row({ row, nav }: { row: Extract<BlockRowView, { kind: 'row' }>; nav: number }): ReactElement {
  const cur = row.change !== undefined && row.change === nav
  const plain: Record<string, unknown> = row.first && row.change !== undefined ? { 'data-change-first': row.change } : {}
  if (row.op === 'chg' && row.left && row.right) {
    return (
      <>
        <Part op="del" side={row.left} marks={row.marksA} current={cur} attrs={plain} />
        <Part op="add" side={row.right} marks={row.marksB} current={cur} attrs={{}} />
      </>
    )
  }
  if (row.op === 'del' && row.left) return <Part op="del" side={row.left} current={cur} attrs={plain} />
  if (row.op === 'add' && row.right) return <Part op="add" side={row.right} current={cur} attrs={plain} />
  const side = row.right ?? row.left
  return side ? <Part op="eq" side={side} current={false} attrs={{}} /> : <></>
}

export default function CompareBlocks({ output, a, b, diff, announce }: CompareBlocksProps): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const body = useRef<HTMLDivElement>(null)
  const aPrev = useVersionPreview(output, a)
  const bPrev = useVersionPreview(output, b)
  const aBlocks: DocumentBlock[] | null = aPrev.state === 'ready' && aPrev.preview.kind === 'document' ? aPrev.preview.blocks : null
  const bBlocks: DocumentBlock[] | null = bPrev.state === 'ready' && bPrev.preview.kind === 'document' ? bPrev.preview.blocks : null
  const ready = aBlocks !== null && bBlocks !== null
  const rows = useMemo(() => (ready ? blockRows(diff.rows, aBlocks, bBlocks, expanded) : []), [ready, diff, aBlocks, bBlocks, expanded])
  const count = useMemo(() => rows.filter((r) => r.kind === 'row' && r.first).length, [rows])
  const nav = useChangeNav(count, body, announce)
  const failed = aPrev.state === 'error' || bPrev.state === 'error'
  return (
    <div className="compare-pane" data-testid="output-compare-blocks" onKeyDown={nav.onKeyDown}>
      <div className="compare-bar">
        <ChangeNavBar count={count} nav={nav} />
      </div>
      {diff.truncated && <p className="compare-note">Only the first changes are shown. Open the file to see the rest.</p>}
      <div ref={body} className="compare-body" data-testid="output-compare-body" role="region" tabIndex={0} aria-label={`Changes between version ${a} and version ${b}`}>
        {failed ? (
          <p className="compare-note">Could not load these versions to show their changes.</p>
        ) : !ready ? (
          <p className="compare-note">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="compare-note">No changes.</p>
        ) : (
          rows.map((r, i) =>
            r.kind === 'gap' ? (
              <div key={r.id} className="compare-gap">
                <Button variant="ghost" size="sm" ariaLabel={`${blockGapText(r.count)}, show them`} onClick={() => { setExpanded((s) => new Set(s).add(r.id)); body.current?.focus() }}>
                  {blockGapText(r.count)}
                </Button>
              </div>
            ) : (
              <Row key={i} row={r} nav={nav.index} />
            )
          )
        )}
      </div>
    </div>
  )
}
