import type { FocusEvent, KeyboardEvent, ReactElement, Ref } from 'react'
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { runTag } from '@shared/view/runLabels'
import { isTypeAheadKey, nextTypeAhead, type TypeAhead } from '../../lib/knowledgeList'
import { outputMetaLine, provenanceLine } from '../../lib/outputs'
import { OUTPUTS_PAGE, dayGroups, titleTypeAhead } from '../../lib/outputsList'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import OutputKindIcon from './OutputKindIcon'

export interface OutputsListHandle {
  /** Focus the row (growing the shown page when it is past it); falls back to the current row. */
  focusRow(id: string | null): void
}

/**
 * The Outputs tab's list (docs/design/outputs.md section 8): one `role=listbox`, so the whole list is one Tab stop
 * (a roving tabindex). Up / Down / Home / End move focus, letters type ahead on the title, Space shows the item in the
 * pane without moving focus, Enter or a click opens it and moves focus to the pane's heading. Rows are grouped by day
 * (a `role=group` per day named by its heading). Rows past OUTPUTS_PAGE render behind "Show 300 more".
 */
export function OutputsList({
  ref,
  rows,
  indexes,
  now,
  selectedId,
  onSelect,
  onOpen
}: {
  ref?: Ref<OutputsListHandle>
  rows: readonly RunOutput[]
  indexes: ReadonlyMap<string, number>
  now: number
  selectedId: string | null
  /** Space: show the item without moving focus. */
  onSelect: (id: string) => void
  /** Enter or a click: select, open the pane and move focus to its heading. */
  onOpen: (id: string) => void
}): ReactElement {
  const uid = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [limit, setLimit] = useState(OUTPUTS_PAGE)
  const rowDomId = useCallback((id: string): string => `${uid}-row-${id}`, [uid])
  // The shown page always reaches the selected row (a deep link or a removal may select one far down).
  const selectedAt = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1
  const shownCount = Math.min(rows.length, Math.max(limit, selectedAt >= 0 ? selectedAt + 1 : 0))
  const shown = useMemo(() => rows.slice(0, shownCount), [rows, shownCount])
  const groups = useMemo(() => dayGroups(shown, now), [shown, now])

  // ---- roving focus (one Tab stop) ----
  const current = useRef<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (!current.current || !shown.some((r) => r.id === current.current)) current.current = selectedId && shown.some((r) => r.id === selectedId) ? selectedId : (shown[0]?.id ?? null)
    for (const o of Array.from(el.querySelectorAll<HTMLElement>('[role=option]'))) o.tabIndex = o.dataset.id === current.current ? 0 : -1
  })
  useLayoutEffect(() => {
    if (!pendingFocus) return
    const el = document.getElementById(rowDomId(pendingFocus))
    if (el) {
      el.focus({ preventScroll: false })
      setPendingFocus(null)
    }
  }, [pendingFocus, shown, rowDomId])

  const goTo = useCallback(
    (index: number): void => {
      const r = rows[index]
      if (!r) return
      if (index + 1 > shownCount) setLimit(Math.ceil((index + 1) / OUTPUTS_PAGE) * OUTPUTS_PAGE)
      current.current = r.id
      setPendingFocus(r.id)
    },
    [rows, shownCount]
  )

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (id) => {
        const i = id ? rows.findIndex((r) => r.id === id) : -1
        if (i >= 0) goTo(i)
        else {
          const c = current.current ? rows.findIndex((r) => r.id === current.current) : -1
          goTo(c >= 0 ? c : 0)
        }
      }
    }),
    [rows, goTo]
  )

  // ---- keys ----
  const typeAhead = useRef<TypeAhead | null>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.id
    if (!id) return
    const from = rows.findIndex((r) => r.id === id)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, from + (e.key === 'ArrowDown' ? 1 : -1)))
      if (to !== from) goTo(to)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      onOpen(id)
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      onSelect(id)
      return
    }
    if (isTypeAheadKey(e)) {
      typeAhead.current = nextTypeAhead(typeAhead.current, e.key, Date.now())
      const hit = titleTypeAhead(rows, from, typeAhead.current.text)
      if (hit >= 0) {
        e.preventDefault()
        goTo(hit)
      }
    }
  }
  const onFocus = (e: FocusEvent<HTMLUListElement>): void => {
    const target = e.target as HTMLElement
    if (target === e.currentTarget) {
      // The skip link lands on the listbox itself: hand focus to the roving row.
      const i = current.current ? rows.findIndex((r) => r.id === current.current) : 0
      goTo(Math.max(0, i))
      return
    }
    const id = target.closest<HTMLElement>('[role=option]')?.dataset.id
    if (id) current.current = id
  }

  const more = Math.min(OUTPUTS_PAGE, rows.length - shownCount)
  return (
    <div className="outputs-list-wrap">
      <ul ref={listRef} className="outputs-list" role="listbox" aria-label="Outputs" data-testid="outputs-list" tabIndex={-1} onKeyDown={onKeyDown} onFocus={onFocus}>
        {groups.map((g) => (
          <li key={g.key} role="presentation" className="outputs-group" data-testid="outputs-group">
            <h2 id={`${uid}-g-${g.key}`} className="outputs-group-title" data-testid="outputs-group-title">
              {g.label} <span className="outputs-group-n">{g.items.length}</span>
            </h2>
            <ul role="group" aria-labelledby={`${uid}-g-${g.key}`} className="outputs-group-rows">
              {g.items.map((o) => (
                <OutputRow key={o.id} output={o} runLabel={runTag(indexes.get(o.runId))} selected={o.id === selectedId} domId={rowDomId(o.id)} onOpen={onOpen} />
              ))}
            </ul>
          </li>
        ))}
        {more > 0 && (
          <li role="presentation" className="outputs-more">
            <Button size="sm" testId="outputs-more" onClick={() => setLimit(shownCount + OUTPUTS_PAGE)}>
              {`Show ${more} more`}
            </Button>
          </li>
        )}
      </ul>
    </div>
  )
}

function OutputRow({ output, runLabel, selected, domId, onOpen }: { output: RunOutput; runLabel: string; selected: boolean; domId: string; onOpen: (id: string) => void }): ReactElement {
  const meta = outputMetaLine(output)
  const prov = provenanceLine(output, runLabel)
  return (
    <li
      id={domId}
      role="option"
      className="outputs-row"
      data-testid="output-row"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={output.missing ? 'true' : 'false'}
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onOpen(output.id)}
    >
      <span className="outputs-row-icon">
        <OutputKindIcon kind={output.kind} />
      </span>
      <span className="outputs-row-body">
        <span className="outputs-row-head">
          <span className="outputs-row-title" data-testid="output-row-title" title={output.title}>
            {output.title}
          </span>
          {output.missing && <Badge tone="attention">Missing</Badge>}
        </span>
        <span className="outputs-row-meta" title={meta}>
          {meta}
        </span>
        <span className="outputs-row-prov" data-testid="output-row-prov">
          {prov}
        </span>
      </span>
    </li>
  )
}
