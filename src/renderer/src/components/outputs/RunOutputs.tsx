import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { RunOutput } from '@shared/types'
import { chainKeyOf, chainOf } from '../../lib/runChains'
import { outputsOfRuns } from '../../lib/outputs'
import { RUN_ROW_THUMB_KINDS, currentProvenance, isNewVersion, rowMetaLine } from '../../lib/outputsList'
import { OutputBadges, OutputThumb } from './OutputThumb'
import { useOutputThumb } from './useOutputThumb'
import { showHidden } from '../../lib/hiddenChars'
import { overlayOwnsEscape } from '../../lib/outputToolbar'
import { runTag } from '../../lib/runLabels'
import { useAppStore, useProjectSummaries, useRunIndexes } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import OutputActions from './OutputActions'
import OutputDetail, { confirmLeaveOutput } from './OutputDetail'
import OutputKindIcon from './OutputKindIcon'
import { OutputStepper, stepKeyHandler } from './OutputStepper'
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
  const tagOf = useCallback((id: string) => indexes.get(id), [indexes])

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
  const [grabFocus, setGrabFocus] = useState(true)
  const open = (id: string | null): void => {
    if (id) setGrabFocus(true)
    useAppStore.getState().openRunOutput(runId, id)
  }
  // Leaving the shown output (another one, Back) asks first while it has unsaved edits (outputs-2 9, dirty guard).
  const leaveThen = (to: string | null, then: () => void): void => {
    if (shown && to === shown.id) {
      then()
      return
    }
    void confirmLeaveOutput().then((ok) => {
      if (ok) then()
    })
  }
  const back = (): void => {
    if (!shown) return
    const id = shown.id
    leaveThen(null, () => {
      pendingFocus.current = { id }
      open(null)
    })
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

  // Previous / next: a click keeps focus on the button (the detail does not grab it); the keys put it on the heading.
  const step = (to: string, viaKeyboard: boolean): void =>
    leaveThen(to, () => {
      setGrabFocus(viaKeyboard)
      useAppStore.getState().openRunOutput(runId, to)
    })
  const onStepKey = stepKeyHandler(list, shown?.id ?? null, step)

  const onDetailKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    onStepKey(e)
    if (e.key !== 'Escape' || e.defaultPrevented) return
    // A menu or dialog inside the detail closes itself first (also when focus is still on the menu's trigger).
    if (overlayOwnsEscape(e.target as Element, (id) => document.getElementById(id)?.hasAttribute('popover') === true)) return
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
          <OutputStepper rows={list} id={shown?.id ?? null} onStep={step} />
        </div>
      )}
      {showList &&
        (list.length === 0 ? (
          <p className="run-outputs-empty" data-testid="run-outputs-empty" tabIndex={-1}>
            No outputs yet. Agents can produce documents, workbooks and diagrams here.
          </p>
        ) : (
          <ul className="run-outputs-list" data-testid="run-outputs-list" data-split={wide && shown ? 'true' : undefined} tabIndex={-1} aria-label="Files">
            {list.map((o) => (
              <OutputRow key={o.id} output={o} current={o.id === shown?.id} tagOf={tagOf} onShow={() => leaveThen(o.id, () => open(o.id))} onNotice={say} onRemoved={removed} />
            ))}
          </ul>
        ))}
      {shown && (
        <div className="run-output-detail" onKeyDown={onDetailKey}>
          {!detailOnly && (
            <div className="run-output-stepbar">
              <OutputStepper rows={list} id={shown.id} onStep={step} />
            </div>
          )}
          <OutputDetail key={shown.id} output={shown} onRemoved={removed} onNotice={say} narrowHint={!wide} autoFocus={grabFocus} />
        </div>
      )}
    </div>
  )
}

function OutputRow({
  output,
  current,
  tagOf,
  onShow,
  onNotice,
  onRemoved
}: {
  output: RunOutput
  current: boolean
  /** The run's tag number (R1 = 1) for a run id: the maker or the run that wrote the current version. */
  tagOf: (runId: string) => number | undefined
  onShow: () => void
  onNotice: (text: string) => void
  onRemoved: (id: string) => void
}): ReactElement {
  const title = showHidden(output.title)
  const seen = useAppStore((s) => s.outputSeenVersion)
  const wantsThumb = RUN_ROW_THUMB_KINDS.has(output.kind)
  const { ref, thumb } = useOutputThumb({ ...output, missing: output.missing || !wantsThumb ? true : undefined })
  const meta = rowMetaLine(output)
  const uid = useId()
  return (
    <li
      className="run-output-row"
      data-testid="run-output-row"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={output.missing ? 'true' : undefined}
      data-current={current ? 'true' : undefined}
    >
      {/* The row itself opens the output (one native button over icon and text); More is the row's one visible control.
          Named "Show <title>" plus its badges from the content; meta and provenance describe it. */}
      <button
        type="button"
        className="run-output-show"
        data-testid="run-output-show"
        aria-labelledby={`${uid}-verb ${uid}-title ${uid}-badges`}
        aria-describedby={`${uid}-meta ${uid}-prov`}
        aria-current={current ? 'true' : undefined}
        onClick={onShow}
      >
        <span className="sr-only" id={`${uid}-verb`}>
          Show
        </span>
        <span className="run-output-icon" ref={ref}>
          {wantsThumb ? <OutputThumb thumb={thumb} kind={output.kind} size="run" /> : <OutputKindIcon kind={output.kind} />}
        </span>
        <span className="run-output-text">
          <span className="run-output-head">
            <span className="run-output-title" id={`${uid}-title`} title={title}>
              {title}
            </span>
            <span className="run-output-badges" id={`${uid}-badges`}>
              <ExtBadge fileName={output.fileName} />
              <OutputBadges openNotes={output.openNoteCount ?? 0} isNew={isNewVersion(output, seen)} />
            </span>
          </span>
          <span className="run-output-meta" id={`${uid}-meta`}>{output.missing ? `File missing · ${meta}` : meta}</span>
          <span className="run-output-prov" id={`${uid}-prov`}>{currentProvenance(output, (id) => { const n = tagOf(id); return n !== undefined ? runTag(n) : undefined })}</span>
        </span>
      </button>
      <div className="run-output-actions">
        <OutputActions output={output} onNotice={onNotice} onRemoved={onRemoved} />
      </div>
    </li>
  )
}
