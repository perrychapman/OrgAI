import type { FocusEvent, KeyboardEvent, MouseEvent, ReactElement, Ref } from 'react'
import { useCallback, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArchiveRestore, Archive, ArrowRight, Pencil } from 'lucide-react'
import type { KnowledgeGroup, KnowledgeItem, RunFacts } from '../../lib/knowledge'
import { itemName, itemRetired } from '../../lib/knowledge'
import type { ListEntry, TypeAhead } from '../../lib/knowledgeList'
import { WINDOW_THRESHOLD, edgeRow, flattenGroups, isTypeAheadKey, nextTypeAhead, rowIndexOf, scrollTopFor, stepRow, typeAheadMatch, windowRange } from '../../lib/knowledgeList'
import { useArrival } from '../../lib/useArrival'
import { isMenuKey } from '../../lib/contextMenu'
import { ContextMenu, useContextMenu, type MenuEntry, type OpenOptions } from '../ui/ContextMenu'
import { KnowledgeRow } from './KnowledgeRow'

export interface KnowledgeListHandle {
  /** Scroll the row into view (inside the list only) and focus it. */
  focusRow(id: string): void
  /** Focus the roving row (the last focused one, else the first). */
  focusCurrent(): void
}

/**
 * The grouped list (docs/design/knowledge.md section 2): one `role=listbox` across every group, so the whole list is
 * one Tab stop (a roving tabindex; Up / Down / Home / End move, letters type ahead on the name, Enter opens, Space
 * selects, Shift+F10 or the context menu opens the row's "More actions" menu). Past 100 rows only the rows near the
 * viewport are rendered (lib/knowledgeList.ts `windowRange`), with group titles in flow and spacers for the rest.
 */
export function KnowledgeList({
  ref,
  domId,
  groups,
  runs,
  selectedId,
  showAgentBadge,
  onSelect,
  onOpen,
  onRetire,
  onEditNote,
  scope,
  enter
}: {
  /** Project + filter key: a change of scope never animates the rows it reveals. */
  scope: string
  /** The list was just switched to from the graph: it enters with the view swap. */
  enter?: boolean
  ref?: Ref<KnowledgeListHandle>
  domId: string
  groups: readonly KnowledgeGroup[]
  runs: RunFacts
  selectedId: string | null
  showAgentBadge: boolean
  /** Arrow keys and Space: the selection follows focus without opening the pane. */
  onSelect: (id: string) => void
  /** Enter or a click: select and open the detail pane. */
  onOpen: (id: string) => void
  onRetire: (item: KnowledgeItem, retired: boolean) => void
  onEditNote: (id: string) => void
}): ReactElement {
  const uid = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const entries = useMemo(() => flattenGroups(groups), [groups])
  const rows = useMemo(() => entries.filter((e): e is Extract<ListEntry, { type: 'row' }> => e.type === 'row'), [entries])
  // Rows appended while the list is open fade in; windowing, filter changes and bursts of more than 12 never do.
  const isNew = useArrival(useMemo(() => rows.map((r) => r.item.id), [rows]), scope, { maxPerBatch: 12 })
  const rowDomId = useCallback((id: string): string => `${uid}-row-${id}`, [uid])

  // ---- windowing ----
  const [view, setView] = useState({ top: 0, height: 0 })
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const measure = (): void => setView({ top: el.scrollTop, height: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const range = useMemo(() => windowRange(entries, view.top, view.height), [entries, view])

  // ---- roving focus (one Tab stop) ----
  // The current row's id (not its element: windowing may unmount and remount it).
  const current = useRef<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const options = Array.from(el.querySelectorAll<HTMLElement>('[role=option]'))
    if (options.length === 0) return
    if (!current.current || !rows.some((r) => r.item.id === current.current)) current.current = rows[0]?.item.id ?? null
    for (const o of options) o.tabIndex = o.dataset.id === current.current ? 0 : -1
  })
  // Focus a row once it is rendered (keyboard moves and focusRow may target a row outside the window).
  useLayoutEffect(() => {
    if (!pendingFocus) return
    const el = document.getElementById(rowDomId(pendingFocus))
    if (el) {
      el.focus({ preventScroll: true })
      setPendingFocus(null)
    }
  }, [pendingFocus, range, rowDomId])

  const goTo = useCallback(
    (index: number): void => {
      const e = entries[index]
      const el = listRef.current
      if (!e || e.type !== 'row' || !el) return
      const top = scrollTopFor(entries, index, el.scrollTop, el.clientHeight)
      if (top !== el.scrollTop) {
        el.scrollTop = top
        setView({ top, height: el.clientHeight })
      }
      current.current = e.item.id
      setPendingFocus(e.item.id)
    },
    [entries]
  )

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (id) => {
        const i = rowIndexOf(entries, id)
        if (i >= 0) goTo(i)
        else {
          const first = edgeRow(entries, 'first')
          if (first >= 0) goTo(first)
        }
      },
      focusCurrent: () => {
        const i = rowIndexOf(entries, current.current)
        goTo(i >= 0 ? i : edgeRow(entries, 'first'))
      }
    }),
    [entries, goTo]
  )

  // ---- the row menu (right click, Menu key, Shift+F10; components/ui/ContextMenu.tsx) ----
  const menu = useContextMenu<string>()
  /** Opening the menu makes its row the current, selected one (as before the migration). */
  const menuOpts = (id: string, row: HTMLElement): OpenOptions => {
    current.current = id
    onSelect(id)
    // Windowing may have unmounted the row by the time the menu closes: the row by id, else the list.
    return { anchor: row, invoker: row, fallbackFocus: () => document.getElementById(rowDomId(id)) ?? listRef.current }
  }
  const onRowContextMenu = (e: MouseEvent<HTMLUListElement>): void => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[role=option]') : null
    const id = row?.dataset.id
    // Selected text in the list keeps the platform menu (Copy): leave the selection and the row as they are.
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim() && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return
    if (row && id) menu.onContextMenu(e, id, menuOpts(id, row))
  }
  const menuItems = (id: string): MenuEntry[] => {
    const item = rows.find((r) => r.item.id === id)?.item
    if (!item) return []
    const retired = itemRetired(item)
    return [
      { id: 'open', label: 'Open', icon: ArrowRight, testId: 'knowledge-row-open', onSelect: () => onOpen(item.id) },
      ...(item.type === 'note' ? [{ id: 'edit', label: 'Edit', icon: Pencil, testId: 'knowledge-row-edit-note', onSelect: () => onEditNote(item.id) }] : []),
      { id: 'retire', label: retired ? 'Restore' : 'Retire', icon: retired ? ArchiveRestore : Archive, testId: 'knowledge-row-retire', onSelect: () => onRetire(item, !retired) }
    ]
  }

  // ---- keys ----
  const typeAhead = useRef<TypeAhead | null>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const target = e.target as HTMLElement
    const id = target.closest<HTMLElement>('[role=option]')?.dataset.id
    if (!id) return
    const from = rowIndexOf(entries, id)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      const to = e.key === 'Home' ? edgeRow(entries, 'first') : e.key === 'End' ? edgeRow(entries, 'last') : stepRow(entries, from, e.key === 'ArrowDown' ? 1 : -1)
      const target = to >= 0 ? entries[to] : undefined
      if (target && target.type === 'row' && to !== from) {
        goTo(to)
        onSelect(target.item.id)
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
    const row = target.closest<HTMLElement>('[role=option]')
    if (row && isMenuKey(e)) {
      menu.onKeyDown(e, id, menuOpts(id, row))
      return
    }
    if (isTypeAheadKey(e)) {
      typeAhead.current = nextTypeAhead(typeAhead.current, e.key, Date.now())
      const rowFrom = rows.findIndex((r) => r.item.id === id)
      const hit = typeAheadMatch(
        rows.map((r) => itemName(r.item)),
        rowFrom,
        typeAhead.current.text
      )
      if (hit >= 0) {
        e.preventDefault()
        const target = rowIndexOf(entries, rows[hit].item.id)
        goTo(target)
        onSelect(rows[hit].item.id)
      }
    }
  }

  const onFocus = (e: FocusEvent<HTMLUListElement>): void => {
    const target = e.target as HTMLElement
    if (target === e.currentTarget) {
      // The skip link lands on the listbox itself: hand focus to the roving row.
      const i = rowIndexOf(entries, current.current)
      goTo(i >= 0 ? i : edgeRow(entries, 'first'))
      return
    }
    const id = target.closest<HTMLElement>('[role=option]')?.dataset.id
    if (id) current.current = id
  }

  // Group titles stay in flow: a windowed slice may start inside a group, so the group's `li` and `ul` wrap just the
  // rendered rows (the heading above it is rendered only when its title entry is in the slice).
  const slice = entries.slice(range.start, range.end)
  const groupsOut: { kind: string; label: string; count: number; titleId: string; withTitle: boolean; rows: KnowledgeItem[] }[] = []
  for (const e of slice) {
    if (e.type === 'title') groupsOut.push({ kind: e.kind, label: e.label, count: e.count, titleId: `${uid}-g-${e.kind}`, withTitle: true, rows: [] })
    else {
      let g = groupsOut[groupsOut.length - 1]
      if (!g) {
        const group = groups.find((x) => x.items.some((i) => i.id === e.item.id))
        g = { kind: group?.kind ?? '', label: group?.label ?? '', count: group?.items.length ?? 0, titleId: `${uid}-g-${group?.kind ?? ''}`, withTitle: false, rows: [] }
        groupsOut.push(g)
      }
      g.rows.push(e.item)
    }
  }

  return (
    <>
      <ul
        ref={listRef}
        id={domId}
        className={enter ? 'knowledge-list motion-view' : 'knowledge-list'}
        role="listbox"
        aria-label="Items"
        data-testid="knowledge-list"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onContextMenu={onRowContextMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          if (rows.length > WINDOW_THRESHOLD) setView({ top: el.scrollTop, height: el.clientHeight })
        }}
      >
        {range.topPad > 0 && <li role="presentation" className="knowledge-spacer" style={{ height: range.topPad }} aria-hidden="true" />}
        {groupsOut.map((g) => (
          <li key={g.kind} role="presentation" className="knowledge-group" data-kind={g.kind} data-testid="knowledge-group">
            {g.withTitle && (
              <h2 id={g.titleId} className="knowledge-group-title" data-testid="knowledge-group-title">
                {g.label} <span className="knowledge-group-n">{g.count}</span>
              </h2>
            )}
            <ul role="group" aria-labelledby={g.titleId} aria-label={g.withTitle ? undefined : g.label} className="knowledge-group-rows">
              {g.rows.map((item) => (
                <KnowledgeRow key={item.id} item={item} runs={runs} selected={item.id === selectedId} showAgentBadge={showAgentBadge} domId={rowDomId(item.id)} arrive={isNew(item.id)} onOpen={onOpen} />
              ))}
            </ul>
          </li>
        ))}
        {range.bottomPad > 0 && <li role="presentation" className="knowledge-spacer" style={{ height: range.bottomPad }} aria-hidden="true" />}
      </ul>
      <ContextMenu
        control={menu}
        label={(id) => {
          const item = rows.find((r) => r.item.id === id)?.item
          return item ? `More actions for ${itemName(item)}` : 'More actions'
        }}
        items={menuItems}
        testId="knowledge-row-more"
      />
    </>
  )
}
