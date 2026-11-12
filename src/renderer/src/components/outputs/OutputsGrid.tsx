import type { FocusEvent, KeyboardEvent, ReactElement, Ref } from 'react'
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RunOutput } from '@shared/types'
import { isTypeAheadKey, nextTypeAhead, type TypeAhead } from '../../lib/knowledgeList'
import { OUTPUTS_PAGE, cardMetaLine, gridColumns, gridTarget, isNewVersion, titleTypeAhead } from '../../lib/outputsList'
import { showHidden } from '../../lib/hiddenChars'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { SelectBox, type OutputsListHandle } from './OutputsList'
import { OutputBadges, OutputThumb } from './OutputThumb'
import { useOutputThumb } from './useOutputThumb'

/**
 * The Outputs tab as a grid of cards (docs/design/outputs-2.md section 5): one `role=listbox` (one Tab stop, roving
 * tabindex). Left / Right move by one, Up / Down by a row (the column count is measured from the cards' tops), Home / End,
 * type-ahead on the title, Space shows the item without moving focus (or toggles it in select mode), Enter or a click
 * opens it. Cards past OUTPUTS_PAGE render behind "Show 300 more".
 */
export function OutputsGrid({
  ref,
  rows,
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
  selectedId: string | null
  seen: Readonly<Record<string, number>>
  selectMode?: boolean
  checked?: ReadonlySet<string>
  onToggle?: (id: string) => void
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}): ReactElement {
  const uid = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [limit, setLimit] = useState(OUTPUTS_PAGE)
  const domId = useCallback((id: string): string => `${uid}-card-${id}`, [uid])
  const selectedAt = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1
  const shownCount = Math.min(rows.length, Math.max(limit, selectedAt >= 0 ? selectedAt + 1 : 0))
  const shown = useMemo(() => rows.slice(0, shownCount), [rows, shownCount])

  const current = useRef<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const lastSelected = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (selectedId !== lastSelected.current) {
      lastSelected.current = selectedId
      if (selectedId && shown.some((r) => r.id === selectedId)) current.current = selectedId
    }
    if (!current.current || !shown.some((r) => r.id === current.current)) current.current = selectedId && shown.some((r) => r.id === selectedId) ? selectedId : (shown[0]?.id ?? null)
    for (const o of Array.from(el.querySelectorAll<HTMLElement>('[role=option]'))) o.tabIndex = o.dataset.id === current.current ? 0 : -1
  })
  useLayoutEffect(() => {
    if (!pendingFocus) return
    const el = document.getElementById(domId(pendingFocus))
    if (el) {
      el.focus({ preventScroll: false })
      setPendingFocus(null)
    }
  }, [pendingFocus, shown, domId])

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

  const columns = (): number => {
    const el = listRef.current
    if (!el) return 1
    return gridColumns(Array.from(el.querySelectorAll<HTMLElement>('[role=option]')).map((o) => o.offsetTop))
  }

  const typeAhead = useRef<TypeAhead | null>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.id
    if (!id) return
    const from = rows.findIndex((r) => r.id === id)
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      const to = gridTarget(e.key, from, rows.length, columns())
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
      <ul
        ref={listRef}
        className="outputs-grid"
        role="listbox"
        aria-label="Outputs"
        aria-multiselectable={selectMode || undefined}
        data-select={selectMode ? 'true' : undefined}
        data-testid="outputs-grid"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {shown.map((o) => (
          <OutputCard
            key={o.id}
            output={o}
            shown={o.id === selectedId}
            isNew={isNewVersion(o, seen)}
            selectMode={selectMode}
            checked={checked?.has(o.id) ?? false}
            domId={domId(o.id)}
            onClick={(id) => (selectMode ? onToggle?.(id) : onOpen(id))}
          />
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

function OutputCard({
  output,
  shown,
  isNew,
  selectMode,
  checked,
  domId,
  onClick
}: {
  output: RunOutput
  shown: boolean
  isNew: boolean
  selectMode: boolean
  checked: boolean
  domId: string
  onClick: (id: string) => void
}): ReactElement {
  const { ref, thumb } = useOutputThumb(output)
  const title = showHidden(output.title)
  return (
    <li
      id={domId}
      role="option"
      className="output-card"
      data-testid="output-card"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={output.missing ? 'true' : 'false'}
      data-shown={shown ? 'true' : undefined}
      aria-selected={selectMode ? checked : shown}
      tabIndex={-1}
      onClick={() => onClick(output.id)}
    >
      <span className="output-card-thumb" ref={ref}>
        <OutputThumb thumb={thumb} kind={output.kind} size="card" />
        {selectMode && <SelectBox checked={checked} />}
      </span>
      <span className="output-card-title" title={output.title}>
        {title}
      </span>
      <span className="output-card-foot">
        <span className="output-card-meta">{cardMetaLine(output)}</span>
        {output.missing && <Badge tone="attention">Missing</Badge>}
        <OutputBadges openNotes={output.openNoteCount ?? 0} isNew={isNew} />
      </span>
    </li>
  )
}
