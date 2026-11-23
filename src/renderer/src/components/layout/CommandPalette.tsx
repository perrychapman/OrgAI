import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Briefcase, Code, CornerDownLeft, FileText, House, Inbox, MessageSquare, Network, Plug, Plus, Search, Settings, Sparkles, CalendarClock, ChartColumn, type LucideIcon } from 'lucide-react'
import { projectKindOf } from '@shared/defaults'
import { isVirtualProjectId, type RunSummary, type VirtualProjectId } from '@shared/types'
import { ASSISTANT_ORDER, assistantLabel } from '../../lib/assistants'
import { clientOf } from '../../lib/clientGroups'
import {
  buildPaletteItems,
  flatten,
  resultsPhrase,
  sectionsFor,
  stepIndex,
  type PaletteInput,
  type PaletteItem,
  type PaletteTarget
} from '../../lib/commandPalette'
import { exitProps, useExitPresence } from '../../lib/useExitPresence'
import { chainGroups, needsYou } from '../../lib/runChains'
import { displayRunName } from '../../lib/orgChange'
import { runIndexMap, runTag } from '../../lib/runLabels'
import { waitingItems } from '../../lib/needsYou'
import { isMacPlatform, currentPlatform } from '../../lib/platform'
import { isRunLive, openNewChat, openNewProject, useAppStore, waitingRuns, type View } from '../../store/useAppStore'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import '../../styles/palette.css'

const ICONS: Record<PaletteItem['icon'], LucideIcon> = {
  home: House,
  inbox: Inbox,
  chat: MessageSquare,
  helper: Sparkles,
  usage: ChartColumn,
  schedules: CalendarClock,
  settings: Settings,
  code: Code,
  engagement: Briefcase,
  run: Network,
  tab: FileText,
  plus: Plus
}
// Helpers keep the sidebar's own marks.
const HELPER_ICONS: Partial<Record<VirtualProjectId, LucideIcon>> = { harness: Plug, skills: Sparkles }

/** The shortcut as the platform writes it: "Ctrl K" or "⌘K". */
export function paletteShortcut(): { text: string; aria: string } {
  return isMacPlatform(currentPlatform()) ? { text: '⌘K', aria: 'Command+K' } : { text: 'Ctrl K', aria: 'Control+K' }
}

/** Everything the palette can open, read once from the store when it opens (it is a short-lived surface, not a subscriber). */
function snapshotInput(tabs: readonly { view: string; label: string }[] | null, activeView: string | undefined): PaletteInput {
  const s = useAppStore.getState()
  const known = new Map<string, { id: string; startedAt: number }[]>()
  const summaries = new Map<string, RunSummary>()
  for (const list of Object.values(s.historyByProject)) for (const h of list) summaries.set(h.id, h)
  for (const r of Object.values(s.runs)) summaries.set(r.summary.id, r.summary)
  for (const h of summaries.values()) {
    if (!h.projectId) continue
    const list = known.get(h.projectId) ?? []
    list.push({ id: h.id, startedAt: h.startedAt })
    known.set(h.projectId, list)
  }
  const indexes = new Map<string, number>()
  for (const list of known.values()) for (const [id, n] of runIndexMap(list)) indexes.set(id, n)
  const firstOf = new Map<string, RunSummary>()
  for (const [pid] of known) {
    const mine = [...summaries.values()].filter((x) => x.projectId === pid)
    for (const g of chainGroups(mine)) for (const m of g.members) firstOf.set(m.id, g.first)
  }
  const live = Object.values(s.runs)
    .filter((r) => r.summary.projectId && isRunLive(r))
    .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || b.summary.startedAt - a.summary.startedAt)
  const projectNames = new Map(s.projects.map((p) => [p.id, p.name]))
  for (const id of ASSISTANT_ORDER) projectNames.set(id, assistantLabel(id))
  const project = s.selectedProjectId ? (isVirtualProjectId(s.selectedProjectId) ? s.virtualProjects[s.selectedProjectId] : s.projects.find((p) => p.id === s.selectedProjectId)) : undefined
  const inProject = ['home', 'run', 'history', 'outputs', 'knowledge', 'todos', 'team', 'settings'].includes(s.view)
  return {
    projects: s.projects.map((p) => ({ id: p.id, name: p.name, kind: projectKindOf(p) === 'engagement' ? 'engagement' : 'code', client: clientOf(p) || undefined })),
    runs: live.map((r) => {
      const first = firstOf.get(r.summary.id) ?? r.summary
      return { runId: r.summary.id, projectId: r.summary.projectId as string, label: `${runTag(indexes.get(first.id))}: ${displayRunName(first)}`, needsYou: needsYou(r) }
    }),
    projectNames,
    current: project && inProject && tabs ? { name: isVirtualProjectId(project.id) ? assistantLabel(project.id) : project.name, tabs, activeView } : null,
    helpers: ASSISTANT_ORDER.map((id) => ({ id, label: assistantLabel(id) })),
    waiting: waitingRuns(s).reduce((n, r) => n + waitingItems(r).length, 0)
  }
}

/** Do what the sidebar row of the same name does. */
function run(target: PaletteTarget): void {
  const s = useAppStore.getState()
  const PROJECT_VIEWS = ['home', 'run', 'history', 'outputs', 'knowledge', 'todos', 'team', 'settings']
  switch (target.type) {
    case 'view':
      if (target.view === 'usage') s.openUsage()
      else if (target.view === 'schedules') s.openSchedules()
      else s.setView(target.view)
      return
    case 'assistant':
      void s.openAssistant(target.id)
      return
    case 'project':
      void s.openProject(target.projectId)
      if (!PROJECT_VIEWS.includes(s.view)) s.setView('run')
      return
    case 'tab':
      s.setView(target.view as View)
      return
    case 'run':
      if (s.selectedProjectId !== target.projectId) s.selectProject(target.projectId)
      void s.openRun(target.runId)
      if (!PROJECT_VIEWS.includes(s.view)) s.setView('run')
      return
    case 'new-project':
      openNewProject()
      return
    case 'new-chat':
      void openNewChat()
  }
}

/**
 * Search or jump to (Ctrl/Cmd+K, the sidebar's search button): one native modal dialog with a combobox over a listbox.
 * The input keeps DOM focus; the highlighted row is announced through aria-activedescendant. Arrows move (wrapping),
 * Enter opens, Esc closes and focus returns to whatever opened it. Choosing something lands focus on the page content,
 * like a skip link, because the opener is no longer where the user is going.
 */
export default function CommandPalette({
  open,
  onClose,
  tabs,
  activeView
}: {
  open: boolean
  onClose: () => void
  /** The open project's tabs, as the topbar shows them; null on an app-level screen. */
  tabs: readonly { view: string; label: string }[] | null
  activeView?: string
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const exit = useExitPresence(open)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const skipRestore = useRef(false)
  const items = useMemo(() => (open ? buildPaletteItems(snapshotInput(tabs, activeView)) : []), [open, tabs, activeView])
  const sections = useMemo(() => sectionsFor(items, query), [items, query])
  const flat = useMemo(() => flatten(sections), [sections])
  const shortcut = paletteShortcut()

  useEffect(() => {
    const el = ref.current
    if (!el || !open) return undefined
    const opener = document.activeElement as HTMLElement | null
    skipRestore.current = false
    setQuery('')
    setActive(0)
    if (!el.open) el.showModal()
    inputRef.current?.focus()
    return () => {
      if (el.open) el.close()
      if (skipRestore.current) return
      const now = document.activeElement
      if (!now || now === document.body || el.contains(now)) {
        if (opener && document.contains(opener)) opener.focus()
        else document.getElementById('main-content')?.focus()
      }
    }
  }, [open])

  // Typing resets the highlight to the best match.
  useEffect(() => setActive(0), [query])
  // The highlighted row stays in view.
  useEffect(() => {
    const id = flat[active]?.id
    if (!id) return
    listRef.current?.querySelector<HTMLElement>(`[data-option="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, flat])

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return
    skipRestore.current = true
    onClose()
    run(item.target)
    // Land on the content the user asked for, after the route has rendered.
    window.setTimeout(() => document.getElementById('main-content')?.focus({ preventScroll: true }), 60)
  }
  const optionId = (id: string): string => `${listId}-${id}`
  const activeItem = flat[active]
  const typed = query.trim()

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Search or jump to"
      data-testid="command-palette"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {exit.mounted && (
        <div className="palette-panel" {...exitProps(exit.state)}>
          <div className="palette-field">
            <Icon icon={Search} size="md" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              className="palette-input"
              data-testid="command-palette-input"
              aria-label="Search or jump to"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? optionId(activeItem.id) : undefined}
              placeholder="Search projects, runs and pages"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((i) => stepIndex(i, e.key === 'ArrowDown' ? 1 : -1, flat.length))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  choose(activeItem)
                }
              }}
            />
            <kbd className="palette-kbd" aria-hidden="true">
              Esc
            </kbd>
          </div>
          <div className="palette-list" id={listId} role="listbox" aria-label="Results" ref={listRef}>
            {sections.map((sec, si) => {
              const rows = sec.items.map((item) => {
                const index = flat.indexOf(item)
                const selected = index === active
                const Glyph = item.target.type === 'assistant' ? (HELPER_ICONS[item.target.id] ?? ICONS[item.icon]) : ICONS[item.icon]
                return (
                  <div
                    key={item.id}
                    id={optionId(item.id)}
                    data-option={item.id}
                    data-testid="command-palette-option"
                    role="option"
                    aria-selected={selected}
                    className={`palette-option${selected ? ' is-active' : ''}`}
                    data-attention={item.attention ? '' : undefined}
                    onMouseMove={() => {
                      if (!selected) setActive(index)
                    }}
                    onClick={() => choose(item)}
                  >
                    <span className="palette-option-icon">
                      <Icon icon={Glyph} size="sm" />
                    </span>
                    <span className="palette-option-text">
                      <span className="palette-option-label">{item.label}</span>
                      {item.hint && <span className="palette-option-hint">{item.hint}</span>}
                    </span>
                    {typed && <span className="palette-option-group">{item.group}</span>}
                    {selected && <Icon icon={CornerDownLeft} size="xs" />}
                  </div>
                )
              })
              return sec.group ? (
                <div key={sec.group} role="group" aria-labelledby={`${listId}-g${si}`} className="palette-group">
                  <div className="palette-group-label" id={`${listId}-g${si}`}>
                    {sec.group}
                  </div>
                  {rows}
                </div>
              ) : (
                <div key="results" role="presentation">
                  {rows}
                </div>
              )
            })}
            {typed && flat.length === 0 && (
              <div className="palette-empty" data-testid="command-palette-empty">
                <EmptyState compact icon={Search} title={`No results for "${typed}"`} description="Check the spelling, or try a project, run or page name." />
              </div>
            )}
          </div>
          <div className="palette-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> open
            </span>
            <span className="palette-foot-fill" />
            <span>{shortcut.text} to open</span>
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {typed ? resultsPhrase(flat.length) : ''}
          </div>
        </div>
      )}
    </dialog>
  )
}
