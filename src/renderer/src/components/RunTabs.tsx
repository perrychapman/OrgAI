import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleAlert, Pencil, Plus, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/types'
import { isDraftEmpty, isRunLive, newRunDraftKey, projectTabRuns, useAppStore, useRunIndexes, type RunState } from '../store/useAppStore'
import { needsYou } from '../lib/runChains'
import { promptLine, runTag, shortPrompt } from '../lib/runLabels'
import { runStatus, type RunTone } from '../lib/runStatus'
import { Icon } from './ui/Icon'

const DRAFT_ID = 'new'

interface TabItem {
  id: string
  kind: 'run' | 'draft'
  run?: RunState
}

interface TabView {
  tag: string
  title: string
  tooltip: string
  label: string
  tone: RunTone | 'none'
  waiting: boolean
  hasDraft: boolean
  closable: boolean
}

/**
 * Keyboard shortcuts for the run workspace. Ctrl+T opens the New run page. Ctrl+W hides the viewed tab when it is
 * finished (or closes the New run page); it is always swallowed in the run view so it can never close the window.
 */
export function useRunTabShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key !== 't' && key !== 'w') return
      const st = useAppStore.getState()
      const pid = st.selectedProjectId
      if (!pid || st.view === 'projects' || st.view === 'appSettings') return
      if (key === 't') {
        e.preventDefault()
        st.openDraft()
        st.focusComposer()
        return
      }
      if (st.view !== 'run') return
      e.preventDefault()
      const runId = st.draftPage[pid] ? undefined : st.activeRunByProject[pid]
      const run = runId ? st.runs[runId] : undefined
      if (!run) {
        if (st.draftPage[pid]) st.closeDraft()
        return
      }
      if (isRunLive(run)) useAppStore.setState({ tabNotice: 'A working run stays open. End its session first.' })
      else st.dismissRun(run.summary.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Browser-style run tabs for the selected project. A real tablist: one tab stop (roving tabindex), arrows, Home and
 * End move focus, Enter or Space opens the focused tab, Delete hides a finished one. Tabs that do not fit collapse
 * into a "+n" menu (never a scrollbar); the viewed tab always stays visible and "+" stays at the end.
 */
export default function RunTabs({ project }: { project: Project }): ReactElement {
  const runs = useAppStore(useShallow(projectTabRuns))
  const viewedId = useAppStore((s) => s.activeRunByProject[project.id])
  const draftPage = useAppStore((s) => !!s.draftPage[project.id])
  const draftOnPage = useAppStore((s) => !isDraftEmpty(s.composerDrafts[newRunDraftKey(project.id)]))
  const draftKeys = useAppStore(useShallow((s) => Object.keys(s.composerDrafts).filter((k) => !isDraftEmpty(s.composerDrafts[k]))))
  const notice = useAppStore((s) => s.tabNotice)
  const openRun = useAppStore((s) => s.openRun)
  const openDraft = useAppStore((s) => s.openDraft)
  const closeDraft = useAppStore((s) => s.closeDraft)
  const dismissRun = useAppStore((s) => s.dismissRun)
  const indexes = useRunIndexes()

  const viewedRun = !draftPage && viewedId ? runs.find((r) => r.summary.id === viewedId) : undefined
  const selectedId = viewedRun ? viewedRun.summary.id : DRAFT_ID
  const items: TabItem[] = useMemo(() => {
    const list: TabItem[] = runs.map((run) => ({ id: run.summary.id, kind: 'run', run }))
    if (!viewedRun || draftOnPage) list.push({ id: DRAFT_ID, kind: 'draft' })
    return list
  }, [runs, viewedRun, draftOnPage])

  const view = (item: TabItem): TabView => {
    if (item.kind === 'draft') {
      const only = items.length === 1
      return {
        tag: '',
        title: 'New run',
        tooltip: 'New run: a blank page for a new task. The other runs keep going.',
        label: draftOnPage ? 'New run. Has an unsent draft.' : 'New run',
        tone: 'none',
        waiting: false,
        hasDraft: draftOnPage,
        closable: !only
      }
    }
    const run = item.run as RunState
    const waiting = needsYou(run)
    const st = runStatus(run.summary.status, { waiting, endedWithApp: !!run.summary.endedWithApp })
    const tag = runTag(indexes.get(run.summary.id))
    const full = promptLine(run.summary.prompt)
    const hasDraft = draftKeys.includes(run.summary.id)
    return {
      tag,
      title: shortPrompt(run.summary.prompt, 60),
      tooltip: `${tag}: ${full}\n${st.word}${st.note ? ` (${st.note})` : ''}${run.summary.kind === 'setup' ? ' · Setup' : ''}`,
      label: `${tag}: ${shortPrompt(run.summary.prompt, 60)}. ${st.word}.${hasDraft ? ' Has an unsent draft.' : ''}`,
      tone: st.tone,
      waiting,
      hasDraft,
      closable: !isRunLive(run)
    }
  }

  // Overflow: how many tabs fit next to "+" (and the "+n" button when something overflows).
  const barRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  const noticeRef = useRef<HTMLSpanElement>(null)
  const [cap, setCap] = useState<number | null>(null)
  const count = items.length
  const measure = useCallback(() => {
    const bar = barRef.current
    const first = listRef.current?.querySelector<HTMLElement>('.run-tab-wrap')
    const plus = newRef.current
    if (!bar || !first || !plus) return
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0
    const tabW = first.getBoundingClientRect().width + gap
    const plusW = plus.getBoundingClientRect().width + gap
    const noticeW = noticeRef.current ? noticeRef.current.getBoundingClientRect().width + gap : 0
    const room = bar.clientWidth - plusW - noticeW
    const all = Math.floor((room + gap) / tabW)
    setCap(count <= all ? count : Math.max(1, Math.floor((room - plusW + gap) / tabW)))
  }, [count])
  useLayoutEffect(() => {
    measure()
  }, [measure, notice])
  useEffect(() => {
    const bar = barRef.current
    if (!bar || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => measure())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [measure])

  const selectedIdx = items.findIndex((t) => t.id === selectedId)
  const limit = cap ?? items.length
  let visible = items.slice(0, limit)
  if (selectedIdx >= limit && limit > 0) visible = [...items.slice(0, limit - 1), items[selectedIdx]]
  const visibleIds = new Set(visible.map((t) => t.id))
  const hidden = items.filter((t) => !visibleIds.has(t.id))
  const hiddenWaiting = hidden.filter((t) => t.run && needsYou(t.run)).length

  // Roving tabindex: the selected tab is the stop, arrows move it.
  const [roving, setRoving] = useState(selectedId)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocus = useRef(false)
  useEffect(() => setRoving(selectedId), [selectedId])
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    tabRefs.current.get(selectedId)?.focus()
  }, [selectedId, items.length])
  const rovingId = visibleIds.has(roving) ? roving : selectedId

  const activate = (item: TabItem): void => {
    if (item.kind === 'draft') openDraft()
    else void openRun(item.id)
  }
  const hide = (item: TabItem): void => {
    refocus.current = true
    if (item.kind === 'draft') closeDraft()
    else dismissRun(item.id)
  }
  const focusTab = (id: string): void => {
    setRoving(id)
    tabRefs.current.get(id)?.focus()
  }
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const ids = visible.map((t) => t.id)
    const at = ids.indexOf(rovingId)
    if (at < 0) return
    let next: string | undefined
    if (e.key === 'ArrowRight') next = ids[(at + 1) % ids.length]
    else if (e.key === 'ArrowLeft') next = ids[(at - 1 + ids.length) % ids.length]
    else if (e.key === 'Home') next = ids[0]
    else if (e.key === 'End') next = ids[ids.length - 1]
    else if (e.key === 'Delete') {
      const item = visible[at]
      if (view(item).closable) {
        e.preventDefault()
        hide(item)
      }
      return
    }
    if (next === undefined) return
    e.preventDefault()
    focusTab(next)
  }

  // "+n" menu.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menuOpen) return undefined
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node) && !moreRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuOpen])
  useEffect(() => {
    if (hidden.length === 0) setMenuOpen(false)
  }, [hidden.length])
  const onMenuKey = (e: ReactKeyboardEvent): void => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      setMenuOpen(false)
      moreRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      buttons[(at + 1) % buttons.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      buttons[(at - 1 + buttons.length) % buttons.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      buttons[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      buttons[buttons.length - 1]?.focus()
    } else if (e.key === 'Tab') setMenuOpen(false)
  }

  return (
    <div className="run-tabs" ref={barRef}>
      <div className="run-tablist" role="tablist" aria-label="Open runs" aria-orientation="horizontal" ref={listRef} onKeyDown={onKeyDown}>
        {visible.map((item) => {
          const v = view(item)
          const selected = item.id === selectedId
          return (
            <div key={item.id} className={`run-tab-wrap ${selected ? 'selected' : ''} ${v.waiting ? 'waiting' : ''}`} role="presentation" data-run={item.id}>
              <button
                type="button"
                role="tab"
                id={`run-tab-${item.id}`}
                className="run-tab"
                aria-selected={selected}
                aria-controls="run-panel"
                aria-label={v.label}
                title={v.tooltip}
                tabIndex={item.id === rovingId ? 0 : -1}
                ref={(el) => {
                  if (el) tabRefs.current.set(item.id, el)
                  else tabRefs.current.delete(item.id)
                }}
                onFocus={() => setRoving(item.id)}
                onClick={() => activate(item)}
              >
                {item.kind === 'draft' ? (
                  <span className="run-tab-glyph">
                    <Icon icon={Plus} size="xs" />
                  </span>
                ) : (
                  <span className={`run-dot ${v.tone}`} aria-hidden="true" />
                )}
                <span className="run-tab-index">{v.tag}</span>
                <span className="run-tab-title">{v.title}</span>
                <span className="run-tab-badge" aria-hidden="true">
                  {v.waiting ? (
                    <span className="badge-warn" title="Waiting for you">
                      <Icon icon={CircleAlert} size="xs" />
                    </span>
                  ) : v.hasDraft ? (
                    <span className="badge-draft" title="Unsent draft">
                      <Icon icon={Pencil} size="xs" />
                    </span>
                  ) : null}
                </span>
              </button>
              {v.closable && (
                <button type="button" className="run-tab-close" tabIndex={-1} aria-label={`Hide ${v.tag || 'New run'}`} title="Hide this tab (Ctrl+W)" onClick={() => hide(item)}>
                  <Icon icon={X} size="xs" />
                </button>
              )}
            </div>
          )
        })}
      </div>
      {hidden.length > 0 && (
        <div className="run-tab-more-wrap">
          <button
            type="button"
            ref={moreRef}
            className={`run-tab-more ${hiddenWaiting > 0 ? 'waiting' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${hidden.length} more run${hidden.length === 1 ? '' : 's'}${hiddenWaiting > 0 ? `, ${hiddenWaiting} waiting for you` : ''}`}
            title="More runs"
            onClick={() => setMenuOpen((o) => !o)}
          >
            +{hidden.length}
            <Icon icon={ChevronDown} size="xs" />
          </button>
          {menuOpen && (
            <div className="run-tab-menu" role="menu" aria-label="More runs" ref={menuRef} onKeyDown={onMenuKey}>
              {hidden.map((item) => {
                const v = view(item)
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="run-tab-menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      activate(item)
                    }}
                  >
                    {item.kind === 'draft' ? <Icon icon={Plus} size="xs" /> : <span className={`run-dot ${v.tone}`} aria-hidden="true" />}
                    <span className="run-tab-index">{v.tag}</span>
                    <span className="run-tab-title">{v.title}</span>
                    {v.waiting && <Icon icon={CircleAlert} size="xs" label="Waiting for you" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      <button type="button" ref={newRef} className="run-tab-new" aria-label="New run" title="New run (Ctrl+T)" onClick={openDraft}>
        <Icon icon={Plus} size="sm" />
      </button>
      {notice && (
        <span className="run-tabs-notice" role="status" ref={noticeRef}>
          {notice}
        </span>
      )}
    </div>
  )
}
