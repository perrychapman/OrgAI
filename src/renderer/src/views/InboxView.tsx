import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Inbox as InboxIcon } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { decisionFocus } from '../components/DecisionCard'
import { keys } from '../lib/keysHeld'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import InboxHeader from '../components/inbox/InboxHeader'
import InboxList from '../components/inbox/InboxList'
import InboxDetail from '../components/inbox/InboxDetail'
import { useInboxData } from '../components/inbox/useInboxData'
import { useNow } from '../components/dashboard/useDashboardData'
import {
  ENTER_DWELL_MS,
  FRESH_GUARD,
  NO_FILTERS,
  afterAnswerText,
  applyFilters,
  filterCounts,
  guardArrive,
  guardPress,
  guardRelease,
  guardReset,
  guardSwallows,
  nextSelection,
  projectOptions,
  selectionText,
  stepSelection,
  type InboxFilters,
  type InboxItem
} from '../lib/inbox'
import '../styles/inbox.css'

/** Roles whose own widget owns the keys (J, K, arrows, Enter): the Inbox keys stay out of their way. */
const KEY_OWNER_ROLES = '[role="combobox"],[role="textbox"],[role="searchbox"],[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="listbox"],[role="option"]'

/** True while the user types into a field (or a menu-like control owns the keys): the Inbox keys then stay out of the way. */
function typingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || !!el.closest(KEY_OWNER_ROLES)
}

/** True while a dialog is open anywhere (the Inbox never reacts to keys behind one). */
function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"],[role="alertdialog"],dialog[open]')
}

/** Moves focus to the one action of the shown item: the card's primary button, else its first field or button. */
function focusMainAction(root: HTMLElement | null): boolean {
  const q = (sel: string): HTMLElement | null => root?.querySelector<HTMLElement>(sel) ?? null
  const el =
    q('.inbox-main') ??
    q('.decision-footer .btn.primary:not([disabled]):not([aria-disabled="true"])') ??
    q('.decision-body input:not([disabled]), .decision-body textarea:not([disabled]), .decision-body summary, .decision-body button:not([disabled])') ??
    q('.decision-footer button:not([disabled])')
  el?.focus()
  return !!el
}

/**
 * Inbox (docs/design/ui-overhaul/project/Inbox.dc.html): every decision waiting on the user across projects, with the
 * runs that finished since the user last looked. The list is the single source of the "waiting" number: the sidebar badge,
 * the Needs-you popover and this page count the same decisions. The selected decision is the run view's own card, so an
 * answer is made where the user sees everything the card says.
 *
 * The key guarantee: no decision is answered by a key event that began before the card's action had focus. Enter on a row
 * only moves focus (fresh press, never a repeat); from then on Enter / Space are swallowed in the detail pane until the
 * key that was down at that moment is released (and for a short dwell after that Enter), and a repeating keydown never
 * presses a card button. After an answer focus goes to the next ROW, never to a card's action. A deliberate press on the
 * focused action still answers it; that is a visible, separate key press, not an automatic one.
 */
export default function InboxView(): ReactElement {
  const now = useNow(30_000)
  const { waiting, finished, workingTeams, markRead, markAllRead } = useInboxData(now)
  const setView = useAppStore((s) => s.setView)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const focusRun = useAppStore((s) => s.focusRun)
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS)
  const [selected, setSelected] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const guard = useRef(FRESH_GUARD)

  // Say something to a screen reader; the same words twice in a row are spoken again (clear, then set on the next frame).
  const liveFrame = useRef(0)
  const announce = useCallback((text: string): void => {
    cancelAnimationFrame(liveFrame.current)
    setLive('')
    liveFrame.current = requestAnimationFrame(() => setLive(text))
  }, [])
  useEffect(() => () => cancelAnimationFrame(liveFrame.current), [])

  const all = useMemo(() => [...waiting, ...finished], [waiting, finished])
  // A project filter whose project has nothing left falls back to every project.
  const projects = useMemo(() => projectOptions(all), [all])
  const project = filters.project !== 'all' && !projects.some((p) => p.id === filters.project) ? 'all' : filters.project
  const counts = useMemo(() => filterCounts(all, project), [all, project])
  const filter = filters.filter !== 'all' && !counts.kinds.some((k) => k.filter === filters.filter) ? 'all' : filters.filter
  const effective = useMemo<InboxFilters>(() => ({ filter, project }), [filter, project])
  const shownWaiting = useMemo(() => applyFilters(waiting, effective), [waiting, effective])
  const shownFinished = useMemo(() => applyFilters(finished, effective), [finished, effective])
  const order = useMemo(() => [...shownWaiting, ...shownFinished], [shownWaiting, shownFinished])
  const ids = useMemo(() => order.map((i) => i.id), [order])
  const idsKey = ids.join('\u0000')

  // The selection follows the list: kept while present, else the item that followed it (answering lands on the next one).
  // Adjusted while rendering, so no frame ever shows a detail for an item that left.
  const [seenIds, setSeenIds] = useState<{ key: string; ids: string[] } | null>(null)
  if (seenIds === null || seenIds.key !== idsKey) {
    const next = nextSelection(seenIds?.ids ?? [], selected, ids)
    setSeenIds({ key: idsKey, ids })
    if (next !== selected) {
      // The list moved the selection by itself (an answer, a chip): the next card must not take focus on its own.
      if (next !== null) decisionFocus.suppress = true
      setSelected(next)
    }
  }
  const item = order.find((i) => i.id === selected) ?? null
  const index = item ? order.indexOf(item) : -1

  // What the page said last, to tell an answered item (gone from the data) from one only a chip hides.
  const last = useRef<{ selected: string | null; group: string | null; allIds: Set<string>; focusInside: boolean }>({ selected: null, group: null, allIds: new Set(), focusInside: false })
  useEffect(() => {
    const prev = last.current
    const stillThere = new Set(all.map((i) => i.id))
    const answered = prev.selected !== null && prev.allIds.has(prev.selected) && !stillThere.has(prev.selected)
    if (answered) {
      announce(afterAnswerText(item, index, order.length, waiting.length, prev.group === 'finished' ? 'Cleared' : 'Answered'))
      // The answered card took focus with it: land on the next ROW, never on a card's action (a key still held from the
      // answer, or a second press, must not reach the next request).
      if (prev.focusInside) {
        const nextId = item?.id
        requestAnimationFrame(() => {
          const a = document.activeElement
          if (a && a !== document.body && rootRef.current?.contains(a)) return
          const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-testid=inbox-row]')
          const row = rows ? [...rows].find((r) => r.getAttribute('data-id') === nextId) : undefined
          if (row) row.focus()
          else document.querySelector<HTMLElement>('[data-testid=inbox-answer-order], .inbox-title')?.focus()
        })
      }
    }
    last.current = { selected, group: item?.group ?? null, allIds: stillThere, focusInside: prev.focusInside }
    // Only the data and the selection matter here; `item`, `index` and the counts are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, selected])

  // Where focus is, as far as the page can tell (a removed element fires no blur that says where it went).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const onIn = (): void => {
      last.current.focusInside = true
    }
    const onOut = (e: FocusEvent): void => {
      const to = e.relatedTarget as Node | null
      if (to && !root.contains(to)) last.current.focusInside = false
    }
    root.addEventListener('focusin', onIn)
    root.addEventListener('focusout', onOut)
    return () => {
      root.removeEventListener('focusin', onIn)
      root.removeEventListener('focusout', onOut)
    }
  }, [])

  // The decision card puts focus on its primary button when it appears; moving by the list keeps focus on the list.
  useState(() => {
    // Arriving on the Inbox keeps focus where the user put it (the sidebar), not on the first card's button.
    decisionFocus.suppress = true
    return null
  })
  useEffect(() => {
    decisionFocus.suppress = false
  }, [selected])
  // Arrival: focus goes to the list's first row (the heading when empty), so J, K and Enter work at once. Never taken from
  // someone typing, from a dialog, or from a place inside the Inbox. The Enter (or Space) that activated the nav row may
  // still be down: while it is, a fresh Enter on a row does nothing (its repeats are always swallowed). The hold ends at the
  // key-up of the opening key, not on a timer, so a deliberate Enter always works once the keys are up.
  const openerHeld = useRef(false)
  useEffect(() => {
    let release: (() => void) | undefined
    // A key released in another window never sends a keyup here (the tracker clears on blur and then never calls back).
    const onBlur = (): void => {
      openerHeld.current = false
    }
    window.addEventListener('blur', onBlur)
    const frame = requestAnimationFrame(() => {
      const a = document.activeElement
      if (a && a !== document.body && (rootRef.current?.contains(a) || typingTarget(a))) return
      if (dialogOpen()) return
      const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-testid=inbox-row]')
      const row = rows ? ([...rows].find((r) => r.tabIndex === 0) ?? rows[0]) : undefined
      if (keys.held()) {
        openerHeld.current = true
        release = keys.whenReleased(() => {
          openerHeld.current = false
        })
      }
      if (row) row.focus()
      else rootRef.current?.querySelector<HTMLElement>('.inbox-title')?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('blur', onBlur)
      release?.()
    }
  }, [])
  const choose = useCallback(
    (id: string | null): void => {
      if (!id) return
      if (id !== selected) decisionFocus.suppress = true
      setSelected(id)
    },
    [selected]
  )

  // The row is already in the list (J / K / Esc only name rows that are drawn), so focus moves now. Waiting for the next
  // animation frame left a window, as long as the frame took to arrive (a busy or hidden window delivers it late), in which
  // the person's next key, an Enter on that row, ran first and was then undone by the late focus hand-back. Only a row that
  // is not drawn yet (the list is changing) waits one frame.
  const focusRow = useCallback((id: string): void => {
    const find = (): HTMLElement | undefined => [...(listRef.current?.querySelectorAll<HTMLElement>('[data-testid=inbox-row]') ?? [])].find((r) => r.getAttribute('data-id') === id)
    const go = (row: HTMLElement): void => {
      row.focus()
      row.scrollIntoView?.({ block: 'nearest' })
    }
    const now = find()
    if (now) {
      go(now)
      return
    }
    requestAnimationFrame(() => {
      const row = find()
      if (!row) return
      // A late hand-back never takes focus from where the person has gone since.
      const a = document.activeElement
      if (a && a !== document.body && !rootRef.current?.contains(a)) return
      go(row)
    })
  }, [])

  const move = useCallback(
    (delta: 1 | -1 | 'first' | 'last'): void => {
      const to = stepSelection(ids, selected, delta)
      if (!to || to === selected) return
      choose(to)
      // In the list the focused row is read out by itself; elsewhere (a chip, the page) the live region says where the selection went.
      if (listRef.current?.contains(document.activeElement)) focusRow(to)
      else {
        const at = ids.indexOf(to)
        const it = order[at]
        if (it) announce(selectionText(it, at, ids.length))
      }
    },
    [ids, selected, order, choose, focusRow, announce]
  )

  // "Answer in order": the oldest waiting item, shown, with focus on its main action.
  const answerInOrder = useCallback((): void => {
    const target = shownWaiting[0] ?? waiting[0]
    if (!target) return
    if (!shownWaiting[0]) setFilters(NO_FILTERS)
    setSelected(target.id)
    // Two frames: the card mounts (and takes focus itself unless it is already shown), then focus is set either way.
    requestAnimationFrame(() => requestAnimationFrame(() => focusMainAction(detailRef.current)))
  }, [shownWaiting, waiting])

  // Which guarded keys are down (capture phase, before anything else sees them), and a lost keyup when the window blurs.
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      guard.current = guardPress(guard.current, e.key, e.repeat)
    }
    const up = (e: KeyboardEvent): void => {
      guard.current = guardRelease(guard.current, e.key)
    }
    const blur = (): void => {
      guard.current = guardReset()
    }
    document.addEventListener('keydown', down, true)
    document.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('keydown', down, true)
      document.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [])
  // Focus came into the detail pane from outside it: whatever key is down right now began earlier and may not press anything.
  const onDetailFocus = useCallback((e: ReactFocusEvent<HTMLElement>): void => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    guard.current = guardArrive(guard.current, Date.now())
  }, [])
  // Capture phase on the pane, so it runs before the card's buttons see the key: swallow a guarded Enter / Space.
  const onDetailKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>): void => {
    // Plain Enter in a multi-line field is a new line, not a press.
    if (e.target instanceof HTMLTextAreaElement && !e.ctrlKey && !e.metaKey) return
    if (guardSwallows(guard.current, e.key, e.repeat, Date.now())) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, [])

  // J / K, arrows, Enter and Esc. Never while the user types, never with a modifier, from a dialog, or from outside the
  // Inbox (focus must be inside it or on the body). A held key (repeat) is ignored by every one of them.
  const keyState = useRef({ move, item })
  keyState.current = { move, item }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (typingTarget(e.target)) return
      if (dialogOpen()) return
      const target = e.target instanceof Node ? e.target : null
      const onBody = target === document.body || target === document.documentElement
      if (!onBody && !(target && rootRef.current?.contains(target))) return
      const inList = !!target && !!listRef.current?.contains(target)
      const inDetail = !!target && !!detailRef.current?.contains(target)
      const k = e.key
      if (k === 'j' || k === 'J' || (inList && k === 'ArrowDown')) {
        if (inDetail) return
        e.preventDefault()
        if (e.repeat) return
        keyState.current.move(1)
      } else if (k === 'k' || k === 'K' || (inList && k === 'ArrowUp')) {
        if (inDetail) return
        e.preventDefault()
        if (e.repeat) return
        keyState.current.move(-1)
      } else if (inList && (k === 'Home' || k === 'End')) {
        e.preventDefault()
        if (e.repeat) return
        keyState.current.move(k === 'Home' ? 'first' : 'last')
      } else if (k === 'Enter' && (inList || onBody)) {
        // On a row Enter goes to the main action instead of pressing nothing, and only on a fresh press. The action
        // itself is not pressable until this Enter is released (see the guard), then it is a second, deliberate press.
        if (e.repeat) {
          if (inList) e.preventDefault()
          return
        }
        // The key that opened the Inbox from the sidebar is still down: it must not reach a row or a card.
        if (inList && openerHeld.current) {
          e.preventDefault()
          return
        }
        if (focusMainAction(detailRef.current)) {
          e.preventDefault()
          guard.current = guardArrive(guard.current, Date.now(), ENTER_DWELL_MS)
        }
      } else if (k === 'Escape' && inDetail) {
        // Back to the list. Esc never answers: a decline is always a visible button in the card.
        const id = keyState.current.item?.id
        if (id && !e.repeat) {
          e.preventDefault()
          focusRow(id)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [focusRow])

  const openRun = useCallback(
    (it: InboxItem): void => {
      if (it.kind === 'team') return
      if (it.group === 'finished' && it.runId) {
        markRead(it.runId)
        void focusRun(it.projectId, it.runId)
      } else if (it.runId) {
        void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key)
      }
    },
    [markRead, focusRun, jumpToDecision]
  )
  const clear = useCallback(
    (it: InboxItem): void => {
      if (it.runId) markRead(it.runId)
    },
    [markRead]
  )

  const nothing = waiting.length === 0 && finished.length === 0
  const nothingShown = order.length === 0 && !nothing
  const upNext = index >= 0 ? (order[index + 1] ?? null) : null

  return (
    <div className="inbox-view" data-testid="inbox-view" ref={rootRef}>
      <div className="inbox-page">
        <InboxHeader
          waitingCount={waiting.length}
          finishedCount={finished.length}
          counts={counts}
          projects={projects}
          filters={effective}
          canAnswer={waiting.length > 0}
          onFilters={setFilters}
          onAnswerInOrder={answerInOrder}
        />
        {nothing ? (
          <div className="inbox-empty" data-testid="inbox-empty">
            <EmptyState
              icon={InboxIcon}
              title="Nothing is waiting on you"
              description={workingTeams === 0 ? 'No team has a run going. Anything they need from you shows up here.' : `${workingTeams} ${workingTeams === 1 ? 'team has' : 'teams have'} a run going. Anything they need from you shows up here.`}
              actions={
                <Button variant="secondary" testId="inbox-see-running" onClick={() => setView('projects')}>
                  See what is running
                </Button>
              }
            />
          </div>
        ) : (
          <div className="inbox-body">
            <div ref={listRef} className="inbox-list-wrap">
              <InboxList
                waiting={shownWaiting}
                finished={shownFinished}
                saysNothingWaiting={effective.filter === 'all'}
                selectedId={selected}
                now={now}
                onSelect={(id) => choose(id)}
                onMarkAllRead={markAllRead}
              />
              {nothingShown && <p className="inbox-section-empty">Nothing matches these filters.</p>}
            </div>
            <section className="inbox-detail-pane" aria-label="Selected item" ref={detailRef} onFocus={onDetailFocus} onKeyDownCapture={onDetailKeyDown} data-testid="inbox-detail-pane">
              {item ? (
                <div key={item.id} className="inbox-detail-motion motion-view">
                  <InboxDetail item={item} upNext={upNext} now={now} onOpenRun={openRun} onClear={clear} />
                </div>
              ) : (
                <p className="inbox-section-empty">Pick an item to see it here.</p>
              )}
            </section>
          </div>
        )}
        <div className="sr-only" role="status" aria-live="polite" data-testid="inbox-live">
          {live}
        </div>
      </div>
    </div>
  )
}
