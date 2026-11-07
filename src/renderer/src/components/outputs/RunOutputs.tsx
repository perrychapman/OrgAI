import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { RunOutput } from '@shared/types'
import { chainKeyOf, chainOf } from '../../lib/runChains'
import { outputMetaLine, outputsOfRuns, provenanceLine } from '../../lib/outputs'
import { showHidden } from '../../lib/hiddenChars'
import { runTag } from '../../lib/runLabels'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import OutputActions from './OutputActions'
import OutputDetail from './OutputDetail'
import OutputKindIcon from './OutputKindIcon'
import ExtBadge from './ExtBadge'
import '../../styles/outputs.css'

/** How long a notice line stays. */
const NOTICE_MS = 8000

/** Where focus goes after the detail closed: a row's Show button, the list or the empty state. */
type FocusTarget = { id: string } | 'list' | 'empty'

const rowShow = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid=run-output-row][data-id="${id}"] [data-testid=run-output-show]`)

/**
 * The run side tab "Outputs" (docs/design/outputs.md section 3): every output of the conversation (every member run,
 * every agent), newest first. Show opens the shared `OutputDetail`: in a narrow panel it replaces the list (Back or
 * Esc returns to that row's Show button), in a wide panel it sits under the list.
 */
export default function RunOutputs({ runId, projectId }: { runId: string; projectId: string }): ReactElement {
  const summaries = useProjectSummaries()
  const chain = useMemo(() => chainOf(summaries, runId), [summaries, runId])
  const chainIds = useMemo(() => chain.map((m) => m.id), [chain])
  const chainKey = useMemo(() => chainKeyOf(summaries, runId), [summaries, runId])
  const all = useAppStore((s) => s.outputsByProject[projectId])
  const loadOutputs = useAppStore((s) => s.loadOutputs)
  const openId = useAppStore((s) => s.runOutputsByChain[chainKey]?.openId ?? null)
  const indexes = useRunIndexes()
  const list = useMemo(() => outputsOfRuns(all, chainIds), [all, chainIds])
  const shown = useMemo(() => list.find((o) => o.id === openId) ?? null, [list, openId])

  useEffect(() => {
    if (all === undefined) void loadOutputs(projectId)
  }, [all, loadOutputs, projectId])

  // ---- width: the SidePanel marks its parent grid `data-side-wide` from 480 px ----
  const root = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const parent = root.current?.closest('aside.side-panel')?.parentElement
    if (!parent) return undefined
    const read = (): void => setWide(parent.hasAttribute('data-side-wide'))
    read()
    const mo = new MutationObserver(read)
    mo.observe(parent, { attributes: true, attributeFilter: ['data-side-wide'] })
    return () => mo.disconnect()
  }, [])

  // ---- notice (polite) ----
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    // Clear first so the same sentence twice is heard twice.
    setNotice('')
    requestAnimationFrame(() => setNotice(text))
    noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_MS)
  }, [])
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  // ---- show / back / removed, with the focus each one lands on ----
  const pendingFocus = useRef<FocusTarget | null>(null)
  const open = (id: string | null): void => useAppStore.getState().openRunOutput(runId, id)
  const back = (): void => {
    if (!shown) return
    pendingFocus.current = { id: shown.id }
    open(null)
  }
  const removed = (id: string): void => {
    const at = list.findIndex((o) => o.id === id)
    const next = list[at + 1] ?? list[at - 1]
    pendingFocus.current = next ? { id: next.id } : 'empty'
    open(null)
  }
  useEffect(() => {
    const target = pendingFocus.current
    if (!target || shown) return
    pendingFocus.current = null
    requestAnimationFrame(() => {
      const el =
        target === 'empty'
          ? document.querySelector<HTMLElement>('[data-testid=run-outputs-empty]')
          : target === 'list'
            ? document.querySelector<HTMLElement>('[data-testid=run-outputs-list]')
            : rowShow(target.id)
      el?.focus({ preventScroll: true })
    })
  }, [shown, list])

  const onDetailKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    // A menu or dialog inside the detail closes itself first.
    if ((e.target as Element).closest('[popover], dialog, [role=dialog]')) return
    e.preventDefault()
    e.stopPropagation()
    back()
  }

  const detailOnly = !!shown && !wide
  const showList = !detailOnly

  return (
    <div className="run-outputs" data-testid="run-outputs" data-mode={detailOnly ? 'detail' : wide && shown ? 'split' : 'list'} ref={root}>
      <p className="output-notice" data-testid="output-notice" role="status" aria-live="polite">
        {notice}
      </p>
      {detailOnly && (
        <div className="run-output-backbar">
          <Button variant="ghost" size="sm" icon={ArrowLeft} testId="run-output-back" onClick={back}>
            Back to outputs
          </Button>
        </div>
      )}
      {showList &&
        (list.length === 0 ? (
          <p className="run-outputs-empty" data-testid="run-outputs-empty" tabIndex={-1}>
            No outputs yet. Agents can produce documents, workbooks and diagrams here.
          </p>
        ) : (
          <ul className="run-outputs-list" data-testid="run-outputs-list" data-split={wide && shown ? 'true' : undefined} tabIndex={-1} aria-label="Outputs">
            {list.map((o) => (
              <OutputRow key={o.id} output={o} current={o.id === shown?.id} tag={indexes.get(o.runId)} onShow={() => open(o.id)} onNotice={say} onRemoved={removed} />
            ))}
          </ul>
        ))}
      {shown && (
        <div className="run-output-detail" onKeyDown={onDetailKey}>
          <OutputDetail key={shown.id} output={shown} onRemoved={removed} onNotice={say} narrowHint={!wide} />
        </div>
      )}
    </div>
  )
}

function OutputRow({
  output,
  current,
  tag,
  onShow,
  onNotice,
  onRemoved
}: {
  output: RunOutput
  current: boolean
  tag: number | undefined
  onShow: () => void
  onNotice: (text: string) => void
  onRemoved: (id: string) => void
}): ReactElement {
  const title = showHidden(output.title)
  return (
    <li
      className="run-output-row"
      data-testid="run-output-row"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={output.missing ? 'true' : undefined}
      aria-current={current ? 'true' : undefined}
    >
      <span className="run-output-icon">
        <OutputKindIcon kind={output.kind} />
      </span>
      <div className="run-output-text">
        <span className="run-output-head">
          <span className="run-output-title" title={title}>
            {title}
          </span>
          <ExtBadge fileName={output.fileName} />
        </span>
        <span className="run-output-meta">{output.missing ? `File missing · ${outputMetaLine(output)}` : outputMetaLine(output)}</span>
        <span className="run-output-prov">{provenanceLine(output, tag !== undefined ? runTag(tag) : undefined)}</span>
      </div>
      <div className="run-output-actions">
        <Button variant="primary" size="sm" testId="run-output-show" ariaLabel={`Show ${title}`} onClick={onShow}>
          Show
        </Button>
        <OutputActions output={output} onNotice={onNotice} onRemoved={onRemoved} />
      </div>
    </li>
  )
}
