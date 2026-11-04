import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppWindow, ChevronDown, CircleAlert, EyeOff, Pencil, Plus, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Project, VirtualProjectId } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { newSessionLabel } from '../lib/assistants'
import { isDraftEmpty, isRunLive, newRunDraftKey, projectTabRuns, useAppStore, useProjectSummaries, useRunIndexes, type RunState } from '../store/useAppStore'
import { chainGroups, needsYou } from '../lib/runChains'
import { runMenuAction } from '../lib/menuRegistry'
import { openRunWindow } from '../lib/menuActions'
import { runName, runTag, shortPrompt } from '../lib/runLabels'
import { statusOfRun, statusText, type RunTone } from '../lib/runStatus'
import { Icon } from './ui/Icon'

/** Longest prompt excerpt put in a tab tooltip. */
const PROMPT_TIP_CHARS = 300

const DRAFT_ID = 'new'

interface TabItem {
  /** The newest member's run id for a run tab (DOM id, selection, actions); 'new' for the New run tab. */
  id: string
  /** React key: the chain key (oldest member id), stable across continues. */
  key: string
  kind: 'run' | 'draft'
  /** The chain's newest loaded member. */
  run?: RunState
  /** The chain's first member: it names the tab. */
  first?: { id: string; title?: string; prompt: string }
  sessions: number
}

interface TabView {
  tag: string
  title: string
  tooltip: string
  label: string
  tone: RunTone | 'none'
  /** Status word from lib/runStatus (read by screen readers and e2e); empty for the New run tab. */
  word: string
  waiting: boolean
  hasDraft: boolean
  unread: number
  closable: boolean
}

/**
 * Keyboard shortcuts for the run workspace. Ctrl+T opens the New run page. Ctrl+W hides the viewed tab when it is
 * finished (or closes the New run page); Ctrl+W is always swallowed so it can never close the window, even outside the run view.
 */
export function useRunTabShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key !== 't' && key !== 'w') return
      // Electron's default menu would close the window; swallow Ctrl+W everywhere.
      if (key === 'w') e.preventDefault()
      if (e.repeat) return
      // Both keys share the application menu's router (Ctrl+T = File > New run, Ctrl+W = Window > Close tab).
      if (key === 't') {
        e.preventDefault()
        runMenuAction('new-run')
        return
      }
      runMenuAction('close-tab')
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
  const unreadByRun = useAppStore((s) => s.unreadByRun)
  const openRun = useAppStore((s) => s.openRun)
  const openDraft = useAppStore((s) => s.openDraft)
  const closeDraft = useAppStore((s) => s.closeDraft)
  const dismissRun = useAppStore((s) => s.dismissRun)
  const indexes = useRunIndexes()
  const virtual = isVirtualProjectId(project.id)
  const newLabel = virtual ? newSessionLabel(project.id as VirtualProjectId) : 'New run'

  const summaries = useProjectSummaries()
  const groupOf = useMemo(() => {
    const byMember = new Map<string, ReturnType<typeof chainGroups<(typeof summaries)[number]>>[number]>()
    for (const g of chainGroups(summaries)) for (const m of g.members) byMember.set(m.id, g)
    return byMember
  }, [summaries])
  // The viewed id may name an older member of a chain (a stale pointer): it still selects that chain's one tab.
  const viewedGroup = viewedId ? groupOf.get(viewedId) : undefined
  const viewedRun =
    !draftPage && viewedId
      ? (runs.find((r) => r.summary.id === viewedId) ?? (viewedGroup ? runs.find((r) => groupOf.get(r.summary.id) === viewedGroup) : undefined))
      : undefined
  const selectedId = viewedRun ? viewedRun.summary.id : DRAFT_ID
  const items: TabItem[] = useMemo(() => {
    const list: TabItem[] = runs.map((run) => {
      const g = groupOf.get(run.summary.id)
      return { id: run.summary.id, key: g?.key ?? run.summary.id, kind: 'run', run, first: g?.first ?? run.summary, sessions: g?.members.length ?? 1 }
    })
    if (!viewedRun || draftOnPage) list.push({ id: DRAFT_ID, key: DRAFT_ID, kind: 'draft', sessions: 0 })
    return list
  }, [runs, groupOf, viewedRun, draftOnPage])

  const view = (item: TabItem): TabView => {
    if (item.kind === 'draft') {
      const only = items.length === 1
      return {
        tag: '',
        title: newLabel,
        tooltip: virtual ? `${newLabel}: a blank page to start over. The other sessions keep going.` : 'New run: a blank page for a new task. The other runs keep going.',
        label: draftOnPage ? `${newLabel}. Has an unsent draft.` : newLabel,
        tone: 'none',
        word: '',
        waiting: false,
        hasDraft: draftOnPage,
        unread: 0,
        closable: !only
      }
    }
    const run = item.run as RunState
    const waiting = needsYou(run)
    // Status is the newest member's; the name and tag are the chain's first member's (R1 keeps naming the conversation).
    const st = statusOfRun(run, project, waiting)
    const words = statusText(st)
    const first = item.first ?? run.summary
    const tag = runTag(indexes.get(first.id))
    const name = runName(first)
    // Untrusted text in a tooltip: capped. The full prompt lives only in the transcript.
    const full = shortPrompt(first.prompt, PROMPT_TIP_CHARS)
    const sessions = item.sessions > 1 ? `${item.sessions} sessions` : ''
    // The composer draft is kept per conversation (chain key), like the tab.
    const hasDraft = draftKeys.includes(item.key)
    const unread = unreadByRun[run.summary.id] ?? 0
    return {
      tag,
      title: name,
      tooltip: `${tag}: ${full}\n${words}${st.note && st.note !== words ? ` (${st.note})` : ''}${sessions ? ` · ${sessions}` : ''}${run.summary.kind === 'setup' ? ' · Setup' : ''}`,
      label: `${tag}: ${name}. ${words}.${sessions ? ` ${sessions}.` : ''}${unread > 0 ? ` ${unread} unread note${unread === 1 ? '' : 's'} from other runs.` : ''}${hasDraft ? ' Has an unsent draft.' : ''}`,
      tone: st.tone,
      word: words,
      waiting,
      hasDraft,
      unread,
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
  const hiddenMarked = hidden.some((t) => view(t).unread > 0 || view(t).hasDraft)

  // Roving tabindex: the selected tab is the stop, arrows move it.
  const [roving, setRoving] = useState(selectedId)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocus = useRef(false)
  useEffect(() => setRoving(selectedId), [selectedId])
  // The "stays open" notice belongs to the tab it was raised on; switching tabs clears it.
  useEffect(() => {
    const s = useAppStore.getState()
    if (s.tabNotice === 'A working run stays open. End its session first.') useAppStore.setState({ tabNotice: null })
  }, [selectedId])
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
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      openCtx(rovingId)
      return
    } else if (e.key === 'Delete') {
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
  // Tab context menu (right click, ContextMenu key or Shift+F10 on a tab): Hide, Open in new window.
  const [ctx, setCtx] = useState<{ id: string; left: number; top: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const setTabNotice = useAppStore((s) => s.setTabNotice)
  const openCtx = (id: string): void => {
    const el = tabRefs.current.get(id)?.parentElement
    const rect = el?.getBoundingClientRect()
    if (rect) setCtx({ id, left: rect.left, top: rect.bottom })
  }
  useEffect(() => {
    if (!ctx) return undefined
    ctxRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const onDown = (e: PointerEvent): void => {
      if (!ctxRef.current?.contains(e.target as Node)) setCtx(null)
    }
    const close = (): void => setCtx(null)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctx])
  // Keep the menu inside the viewport: pull it left, or open it above the tab when it would run off the bottom.
  useLayoutEffect(() => {
    const el = ctxRef.current
    if (!ctx || !el) return
    const margin = 8
    const r = el.getBoundingClientRect()
    const tabTop = tabRefs.current.get(ctx.id)?.parentElement?.getBoundingClientRect().top ?? ctx.top
    el.style.left = `${Math.max(margin, Math.min(ctx.left, window.innerWidth - r.width - margin))}px`
    el.style.top = `${ctx.top + r.height + margin > window.innerHeight ? Math.max(margin, tabTop - r.height) : ctx.top}px`
  }, [ctx])
  const closeCtx = (): void => {
    const id = ctx?.id
    setCtx(null)
    // The tab may have moved into the "+n" overflow meanwhile.
    if (id) (tabRefs.current.get(id) ?? moreRef.current)?.focus()
  }
  const openInWindow = (item: TabItem): void => {
    const run = item.run
    if (!run) return
    openRunWindow(run.summary.projectId, run.summary.id)
  }
  const onMenuKey = (e: ReactKeyboardEvent, root: HTMLElement | null = menuRef.current, close: () => void = () => {
    setMenuOpen(false)
    moreRef.current?.focus()
  }): void => {
    const buttons = Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
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
    } else if (e.key === 'Tab') {
      setMenuOpen(false)
      setCtx(null)
    }
  }

  return (
    <div className="run-tabs" ref={barRef} data-testid="run-tabs">
      <div className="run-tablist" role="tablist" aria-label="Open runs" aria-orientation="horizontal" ref={listRef} onKeyDown={onKeyDown}>
        {visible.map((item) => {
          const v = view(item)
          const selected = item.id === selectedId
          return (
            <div key={item.key} className={`run-tab-wrap ${selected ? 'selected' : ''}`} role="presentation" data-run={item.id} data-chain={item.key}>
              <button
                type="button"
                role="tab"
                id={`run-tab-${item.id}`}
                className="run-tab"
                aria-selected={selected}
                aria-controls="run-panel"
                aria-label={v.label}
                aria-describedby={`run-tab-desc-${item.id}`}
                title={v.tooltip}
                tabIndex={item.id === rovingId ? 0 : -1}
                ref={(el) => {
                  if (el) tabRefs.current.set(item.id, el)
                  else tabRefs.current.delete(item.id)
                }}
                onFocus={() => setRoving(item.id)}
                onPointerDown={(e) => e.currentTarget.setAttribute('data-pointer', '')}
                onBlur={(e) => e.currentTarget.removeAttribute('data-pointer')}
                onClick={() => activate(item)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openCtx(item.id)
                }}
              >
                {item.kind === 'draft' ? (
                  <span className="run-tab-glyph">
                    <Icon icon={Plus} size="xs" />
                  </span>
                ) : (
                  <span className={`run-dot ${v.tone}${v.hasDraft || v.unread > 0 ? ' marked' : ''}`} aria-hidden="true" />
                )}
                <span className="run-tab-index">{v.tag}</span>
                <span className="run-tab-title">{v.title}</span>
                {v.word && <span className="sr-only">{v.word}</span>}
              </button>
              <span className="sr-only" id={`run-tab-desc-${item.id}`}>
                {v.tooltip}
              </span>
              {v.closable && (
                <button type="button" className="run-tab-close" tabIndex={-1} aria-label={`Hide ${v.tag || newLabel}`} title="Hide this tab (Ctrl+W)" onClick={() => hide(item)}>
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
            aria-label={`${hidden.length} more run${hidden.length === 1 ? '' : 's'}${hiddenWaiting > 0 ? `, ${hiddenWaiting} waiting for you` : ''}${hiddenMarked ? ', some with unread notes or drafts' : ''}`}
            title="More runs"
            onClick={() => setMenuOpen((o) => !o)}
          >
            +{hidden.length}
            {hiddenMarked && <span className="run-tab-more-dot" aria-hidden="true" />}
            <Icon icon={ChevronDown} size="xs" />
          </button>
          {menuOpen && (
            <div className="run-tab-menu" role="menu" aria-label="More runs" ref={menuRef} onKeyDown={onMenuKey}>
              {hidden.map((item) => {
                const v = view(item)
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className="run-tab-menuitem"
                    title={v.tooltip}
                    onClick={() => {
                      setMenuOpen(false)
                      activate(item)
                    }}
                  >
                    {item.kind === 'draft' ? <Icon icon={Plus} size="xs" /> : <span className={`run-dot ${v.tone}`} aria-hidden="true" />}
                    <span className="run-tab-index">{v.tag}</span>
                    <span className="run-tab-title">{v.title}</span>
                    {v.waiting && <Icon icon={CircleAlert} size="xs" label="Waiting for you" />}
                    {!v.waiting && v.hasDraft && <Icon icon={Pencil} size="xs" label="Unsent draft" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      {ctx &&
        (() => {
          const item = items.find((t) => t.id === ctx.id)
          if (!item) return null
          const v = view(item)
          return (
            <div
              className="run-tab-menu run-tab-ctx"
              role="menu"
              aria-label={`${v.tag ? `${v.tag}: ${v.title}` : newLabel} actions`}
              ref={ctxRef}
              style={{ left: ctx.left, top: ctx.top }}
              onKeyDown={(e) => onMenuKey(e, ctxRef.current, closeCtx)}
            >
              <button
                type="button"
                role="menuitem"
                className="run-tab-menuitem"
                disabled={!v.closable}
                title={v.closable ? 'Hide this tab (Ctrl+W)' : 'A working run stays open. End its session first.'}
                onClick={() => {
                  setCtx(null)
                  hide(item)
                }}
              >
                <Icon icon={EyeOff} size="xs" />
                Hide
              </button>
              {item.kind === 'run' && (
                <button
                  type="button"
                  role="menuitem"
                  className="run-tab-menuitem"
                  onClick={() => {
                    setCtx(null)
                    openInWindow(item)
                  }}
                >
                  <Icon icon={AppWindow} size="xs" />
                  Open in new window
                </button>
              )}
            </div>
          )
        })()}
      <button type="button" ref={newRef} className="run-tab-new" aria-label={newLabel} title={`${newLabel} (Ctrl+T)`} onClick={openDraft}>
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
