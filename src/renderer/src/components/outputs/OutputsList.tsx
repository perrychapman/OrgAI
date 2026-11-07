import type { FocusEvent, KeyboardEvent, ReactElement, Ref } from 'react'
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import type { RunOutput } from '@shared/types'
import type { OutputDayGroup } from '../../lib/outputsList'
import { isTypeAheadKey, nextTypeAhead, typeAheadMatch } from '../../lib/outputsList'
import type { TypeAhead } from '../../lib/knowledgeList'
import { outputMetaLine, provenanceLine } from '../../lib/outputs'
import { showHidden } from '../../lib/hiddenChars'
import { Badge } from '../ui/Badge'
import OutputKindIcon from './OutputKindIcon'

export interface OutputsListHandle {
  /** Focus the row (scrolled into view inside the list only). */
  focusRow(id: string): void
  /** Focus the roving row (the last focused, else the first). */
  focusCurrent(): void
}

/**
 * The grouped Outputs list (docs/design/outputs.md section 8): one `role=listbox` across the day groups, so the list is
 * one Tab stop (roving tabindex; Up / Down / Home / End move, letters type ahead on the title, Enter or a click opens
 * the detail, Space selects). Rows carry no buttons.
 */
export function OutputsList({
  ref,
  domId,
  groups,
  hidden,
  selectedId,
  tagOf,
  onSelect,
  onOpen,
  onShowMore
}: {
  ref?: Ref<OutputsListHandle>
  domId: string
  groups: readonly OutputDayGroup[]
  /** Rows beyond the page ("Show 300 more"). */
  hidden: number
  selectedId: string | null
  tagOf: (runId: string) => string | undefined
  /** Arrow keys and Space: the selection follows focus without opening the pane. */
  onSelect: (id: string) => void
  /** Enter or a click: select and open the detail. */
  onOpen: (id: string) => void
  onShowMore: () => void
}): ReactElement {
  const uid = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const rows = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const current = useRef<string | null>(null)
  const rowDomId = useCallback((id: string): string => `${uid}-row-${id}`, [uid])
  const typeAhead = useRef<TypeAhead | null>(null)

  // One Tab stop: the current row (selected one on first render) is tabbable, the rest are not.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || rows.length === 0) return
    if (!current.current || !rows.some((r) => r.id === current.current)) current.current = rows.some((r) => r.id === selectedId) ? selectedId : (rows[0]?.id ?? null)
    for (const o of Array.from(el.querySelectorAll<HTMLElement>('[role=option]'))) o.tabIndex = o.dataset.id === current.current ? 0 : -1
  })

  const focusId = useCallback(
    (id: string): void => {
      current.current = id
      const el = document.getElementById(rowDomId(id))
      if (!el) return
      for (const o of Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role=option]') ?? [])) o.tabIndex = o === el ? 0 : -1
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    },
    [rowDomId]
  )

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (id) => focusId(rows.some((r) => r.id === id) ? id : (rows[0]?.id ?? '')),
      focusCurrent: () => {
        const id = current.current && rows.some((r) => r.id === current.current) ? current.current : rows[0]?.id
        if (id) focusId(id)
      }
    }),
    [rows, focusId]
  )

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.id
    if (!id) return
    const from = rows.findIndex((r) => r.id === id)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, from + (e.key === 'ArrowDown' ? 1 : -1)))
      if (to !== from && rows[to]) {
        focusId(rows[to].id)
        onSelect(rows[to].id)
      }
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
      const hit = typeAheadMatch(
        rows.map((r) => r.title),
        from,
        typeAhead.current.text
      )
      if (hit >= 0) {
        e.preventDefault()
        focusId(rows[hit].id)
        onSelect(rows[hit].id)
      }
    }
  }

  const onFocus = (e: FocusEvent<HTMLUListElement>): void => {
    if (e.target === e.currentTarget) {
      const id = current.current && rows.some((r) => r.id === current.current) ? current.current : rows[0]?.id
      if (id) focusId(id)
      return
    }
    const id = (e.target as HTMLElement).closest<HTMLElement>('[role=option]')?.dataset.id
    if (id) current.current = id
  }

  return (
    <ul ref={listRef} id={domId} className="outputs-list" role="listbox" aria-label="Outputs" data-testid="outputs-list" tabIndex={-1} onKeyDown={onKeyDown} onFocus={onFocus}>
      {groups.map((g) => (
        <li key={g.key} role="presentation" className="outputs-group" data-testid="outputs-group">
          <h2 id={`${uid}-g-${g.key}`} className="outputs-group-title" data-testid="outputs-group-title">
            {g.label} <span className="outputs-group-n">{g.items.length}</span>
          </h2>
          <ul role="group" aria-labelledby={`${uid}-g-${g.key}`} className="outputs-group-rows">
            {g.items.map((o) => (
              <OutputRow key={o.id} output={o} tag={tagOf(o.runId)} selected={o.id === selectedId} domId={rowDomId(o.id)} onOpen={onOpen} />
            ))}
          </ul>
        </li>
      ))}
      {hidden > 0 && (
        <li role="presentation" className="outputs-more-wrap">
          <button type="button" className="btn sm" data-testid="outputs-more" onClick={onShowMore}>
            Show {Math.min(300, hidden)} more
          </button>
        </li>
      )}
    </ul>
  )
}

function OutputRow({ output, tag, selected, domId, onOpen }: { output: RunOutput; tag: string | undefined; selected: boolean; domId: string; onOpen: (id: string) => void }): ReactElement {
  const missing = output.missing === true
  return (
    <li
      id={domId}
      role="option"
      className="output-row"
      data-testid="output-row"
      data-id={output.id}
      data-kind={output.kind}
      data-missing={missing ? 'true' : 'false'}
      aria-selected={selected}
      tabIndex={-1}
      onClick={() => onOpen(output.id)}
    >
      <span className="output-row-icon">
        <OutputKindIcon kind={output.kind} />
      </span>
      <span className="output-row-text">
        <span className="output-row-head">
          <span className="output-row-title" data-testid="output-row-title" title={output.title}>
            {showHidden(output.title)}
          </span>
          {missing && (
            <Badge tone="attention" title="The file was moved or deleted outside OrgAI">
              File missing
            </Badge>
          )}
        </span>
        <span className="output-row-meta" data-testid="output-row-meta">
          {outputMetaLine(output)}
        </span>
        <span className="output-row-prov" data-testid="output-row-prov">
          {provenanceLine(output, tag)}
        </span>
      </span>
    </li>
  )
}
