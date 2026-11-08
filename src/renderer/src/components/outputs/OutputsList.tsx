import type { FocusEvent, KeyboardEvent, ReactElement, Ref } from 'react'
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { runTag } from '@shared/view/runLabels'
import { isTypeAheadKey, nextTypeAhead, type TypeAhead } from '../../lib/knowledgeList'
import { Check } from 'lucide-react'
import { OUTPUTS_PAGE, currentProvenance, dayGroups, isNewVersion, rowMetaLine, titleTypeAhead } from '../../lib/outputsList'
import { showHidden } from '../../lib/hiddenChars'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import ExtBadge from './ExtBadge'
import { OutputBadges, OutputThumb } from './OutputThumb'
import { useOutputThumb } from './useOutputThumb'

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
  seen,
  selectMode = false,
  checked,
  onToggle,
  onSelect,
  onOpen
}: {
  ref?: Ref<OutputsListHandle>
  rows: readonly RunOutput[]
  indexes: ReadonlyMap<string, number>
  now: number
  selectedId: string | null
  /** The version the user last saw per output (drives "New"). */
  seen: Readonly<Record<string, number>>
  /** Select mode: Space and a click toggle `checked` instead of showing the item. */
  selectMode?: boolean
  checked?: ReadonlySet<string>
  onToggle?: (id: string) => void
  /** Space: show the item without moving focus. */
  onSelect: (id: string) => void
  /** Enter or a click: select, open the pane and move focus to its heading. */
  onOpen: (id: string) => void
}): ReactElement {
  const tagFor = useCallback((runId: string): string | undefined => (indexes.has(runId) ? runTag(indexes.get(runId)) : undefined), [indexes])
  const onClick = (id: string): void => (selectMode ? onToggle?.(id) : onOpen(id))
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
  const lastSelected = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    // A selection made elsewhere (the pane's previous / next) moves the roving stop with it.
    if (selectedId !== lastSelected.current) {
      lastSelected.current = selectedId
      if (selectedId && shown.some((r) => r.id === selectedId)) current.current = selectedId
    }
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
      if (selectMode) onToggle?.(id)
      else onSelect(id)
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
      <ul ref={listRef} className="outputs-list" role="listbox" aria-label="Outputs" aria-multiselectable={selectMode || undefined} data-select={selectMode ? 'true' : undefined} data-testid="outputs-list" tabIndex={-1} onKeyDown={onKeyDown} onFocus={onFocus}>
        {groups.map((g) => (
          <li key={g.key} role="presentation" className="outputs-group" data-testid="outputs-group">
            {/* Hidden from the tree (a listbox owns options and groups only); aria-labelledby still reads it as the group's name. */}
            <h2 id={`${uid}-g-${g.key}`} className="outputs-group-title" data-testid="outputs-group-title" aria-hidden="true">
              {g.label} <span className="outputs-group-n">{g.items.length}</span>
            </h2>
            <ul role="group" aria-labelledby={`${uid}-g-${g.key}`} className="outputs-group-rows">
              {g.items.map((o) => (
                <OutputRow
                  key={o.id}
                  output={o}
                  tagFor={tagFor}
                  shown={o.id === selectedId}
                  isNew={isNewVersion(o, seen)}
                  selectMode={selectMode}
                  checked={checked?.has(o.id) ?? false}
                  domId={rowDomId(o.id)}
                  onClick={onClick}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <div className="outputs-more">
          <Button size="sm" testId="outputs-more" onClick={() => setLimit(shownCount + OUTPUTS_PAGE)}>
            {`Show ${more} more`}
          </Button>
        </div>
      )}
    </div>
  )
}

function OutputRow({
  output,
  tagFor,
  shown,
  isNew,
  selectMode,
  checked,
  domId,
  onClick
}: {
  output: RunOutput
  tagFor: (runId: string) => string | undefined
  shown: boolean
  isNew: boolean
  selectMode: boolean
  checked: boolean
  domId: string
  onClick: (id: string) => void
}): ReactElement {
  const meta = rowMetaLine(output)
  const prov = currentProvenance(output, tagFor)
  const { ref, thumb } = useOutputThumb(output)
  return (
    <li
      id={domId}
      role="option"
      className="outputs-row"
      data-testid="output-row"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={output.missing ? 'true' : 'false'}
      data-shown={shown ? 'true' : undefined}
      aria-selected={selectMode ? checked : shown}
      tabIndex={-1}
      onClick={() => onClick(output.id)}
    >
      {selectMode && <SelectBox checked={checked} />}
      <span className="outputs-row-thumb" ref={ref}>
        <OutputThumb thumb={thumb} kind={output.kind} size="row" />
      </span>
      <span className="outputs-row-body">
        <span className="outputs-row-head">
          <span className="outputs-row-title" data-testid="output-row-title" title={output.title}>
            {showHidden(output.title)}
          </span>
          <ExtBadge fileName={output.fileName} />
          {output.missing && <Badge tone="attention">Missing</Badge>}
          <OutputBadges openNotes={output.openNoteCount ?? 0} isNew={isNew} />
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

/** The visual checkbox of select mode: the option itself is the control (aria-selected carries the state). */
export function SelectBox({ checked }: { checked: boolean }): ReactElement {
  return (
    <span className="output-select" data-testid="output-select" data-checked={checked ? 'true' : 'false'} aria-hidden="true">
      {checked && <Icon icon={Check} size="sm" />}
    </span>
  )
}
