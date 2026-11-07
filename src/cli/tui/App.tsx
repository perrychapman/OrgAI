/**
 * The TUI shell (cli-spec 5.3(1) focus model): composes the status bar, panes, Decision Tray, Composer and slash
 * palette over one InputBus. Every raw input event goes through `dispatch` below: a few global keys first (tray focus,
 * pane cycling, Ctrl+Z, Ctrl+C / Ctrl+D, Esc), then only the focused target's handler, so a character typed in the
 * Composer can never reach the tray. Quitting never stops runs, except on an in-process host after a confirmation.
 */
import { Box, Text } from 'ink'
import { basename } from 'node:path'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Project, ProjectPathCheck, RunStatus, RunSummary } from '../../shared/types'
import { nextSettleAt, settleTimerDelay } from '../../shared/view/foldFinished'
import { isOpenStatus } from '../../shared/view/runChains'
import { statusOfRun, statusText } from '../../shared/view/runStatus'
import { Composer } from './Composer'
import { teamMessageRows, withTeamMilestones } from './collaboration'
import { Welcome } from './Welcome'
import { RunActivity } from './RunActivity'
import { RunCompletion } from './RunCompletion'
import { TUI_NO_DECIDE_NOTICE } from './session'
import { InputBus, InputBusContext, TuiEnvContext } from './context'
import { DecisionTray, GUARD_ARRIVED_NOTICE, GUARD_SWAPPED_NOTICE } from './DecisionTray'
import { cardDetailLines } from './decisions'
import { isTrayFocusKey, PASTE_MAX_CHARS } from './input/keys'
import { computeLayout } from './layout'
import { InspectorPane } from './InspectorPane'
import { paneHint, statusHint, whichKeyLines, type RowKind } from './keymap'
import { Onboarding, DESKTOP_DECISIONS_NOTICE, type OnboardingChoice } from './Onboarding'
import { OrgTreePane } from './OrgTreePane'
import { showInPager } from './pager'
import { PlanPane } from './PlanPane'
import { sanitizeTty } from './sanitizeTty'
import { agentLabel } from '../render'
import { PaneLines, cutSegs, styleFor } from './panes/lines'
import { runPickLines, runPickRows, type RunPickRow } from './runPick'
import { adjacentLiveRun, agentDetail, cardsByAgent, collapseTarget, composerMode, offersRetro, orgTreeRows, partialRows, planView, resolveSelectedRow, runTagOf, statusSummary, subtreeIds, topCard, transcriptRows, trayCards, worktreeRows } from './selectors'
import { usageText } from './usageText'
import { SLASH_COMMANDS } from './slashCommands'
import { SlashPalette } from './SlashPalette'
import { StatusBar } from './StatusBar'
import type { TuiTerminal } from './terminal'
import { asciiOnly, glyphs, separatorFor } from './theme'
import { truncateEnd, wrapText } from './panes/text'
import { TranscriptPane } from './TranscriptPane'
import { trayHeight } from './trayLayout'
import type {
  ComposerMode,
  FocusTarget,
  InputEvent,
  OpenTuiSessionOptions,
  PaneBox,
  PaneId,
  SlashContext,
  TerminalController,
  TranscriptRow,
  TrayCard,
  TuiEnv,
  TuiHostConnection,
  TuiLaunch,
  TuiSessionApi,
  TuiState
} from './types'
import { ESC_INTERRUPT_MS, TUI_TRAFFIC_MS, type TuiNotice } from './types'
import { WorktreesPane } from './WorktreesPane'

/** 128 + SIGINT: a stopOnQuit session that was quit (types.ts EXIT.sigint; not imported to keep this file pure TUI). */
const EXIT_SIGINT = 130
/** A stopOnQuit session whose runs:stop failed and whose run is still open (types.ts EXIT.failure). */
const EXIT_FAILURE = 1

/** Two Ctrl+C presses within this window quit. */
export const CTRL_C_QUIT_MS = 1500
export const COMPOSER_ROWS = 5
export const PANE_ORDER: readonly PaneId[] = ['tree', 'transcript', 'plan', 'worktrees']

export const NOTHING_NEEDS_YOU = 'Nothing needs you'
export const KEY_DROPPED_NOTICE = 'Keys typed before the card had focus were ignored. Read the card, then answer.'
/** The input queue (held while a focus change commits) overflowed and later input was dropped. */
export const INPUT_QUEUE_FULL_NOTICE = 'Some input typed while the screen was changing was dropped.'
export const PRESS_AGAIN ='Press Ctrl+C again to quit'
/** The Ctrl+C notice of a stopOnQuit session (orgai init and the assistants). */
export const PRESS_AGAIN_STOP = 'Press Ctrl+C again to stop the session and quit'
/** stopOnQuit: how long quitting waits for the stopped run's status before it exits anyway. */
export const STOP_WAIT_MS = 5000
export const PASTE_CUT_NOTICE = 'The paste was cut at 1 MB.'

export interface ExitInfo {
  /** The session the App ended on (onboarding may have replaced the first one). */
  session: TuiSessionApi
  /** The followed run was still live and keeps going (a daemon or desktop host). */
  detachedLive: boolean
  /** One line runTui prints after restoring the terminal (exitWhenEnded / stopOnQuit sessions). */
  message?: string
}

/** Raw input after KeyParser (runTui feeds it; tests push events directly). */
export interface InputSource {
  subscribe(fn: (e: InputEvent) => void): () => void
}

export interface AppProps {
  session: TuiSessionApi
  terminal: TerminalController & Partial<Pick<TuiTerminal, 'onResume' | 'stopSelf' | 'suspendForChild' | 'resumeFromChild' | 'suspended'>>
  env: TuiEnv
  launch: TuiLaunch
  conn: TuiHostConnection
  onExit(code: number, info?: ExitInfo): void
  input?: InputSource
  /** Opens a session on another project (onboarding [2] / [3] / [i]). */
  openSession?(opts: OpenTuiSessionOptions): Promise<TuiSessionApi>
  /** The process environment ($PAGER, ORGAI_MOCK). */
  processEnv?: NodeJS.ProcessEnv
  now?: () => number
}

type Overlay =
  | { kind: 'confirm'; question: string; resolve(yes: boolean): void }
  | { kind: 'text'; title: string; lines: string[]; offset: number; /** The composer's keys: a printable key closes it and is typed into the composer. */ passThrough?: boolean }
  | { kind: 'runs'; rows: RunPickRow[]; sel: number }

const isOpen = (status: RunStatus | undefined): boolean => status !== undefined && isOpenStatus(status)
const isWorking = (status: RunStatus | undefined): boolean => status === 'starting' || status === 'running'

const ctrl = (e: InputEvent, ch: string): boolean => e.type === 'key' && e.name === 'char' && e.ctrl && !e.alt && e.ch === ch
const named = (e: InputEvent, name: string): boolean => e.type === 'key' && e.name === name

const errText = (e: unknown): string => sanitizeTty(e instanceof Error ? e.message : String(e))

export const PLACEHOLDERS: Record<ComposerMode, string> = {
  start: 'Describe the work to start a run',
  send: 'Message the run',
  continue: 'Send to continue this session with its memory',
  quick: 'Ask about this folder (a quick run)',
  readOnly: ''
}

export const ESC_AGAIN = 'Press Esc again to interrupt the run.'
export const NOTHING_RUNNING = 'Nothing is running.'
export const READ_ONLY_ESC = 'This session is read-only: there is nothing to interrupt.'
export const PANES_NEED_FULLSCREEN = 'Panes need a full-screen terminal 70 columns wide; /agent <name> shows an agent.'
export const PAGER_HINT = 'Set $PAGER (for example PAGER=less) to page long text.'

/** The composer's placeholder: in send / continue modes it names the followed run (issue #29 M3). */
export function placeholderFor(mode: ComposerMode, s: TuiState, width: number, env?: TuiEnv): string {
  const base = PLACEHOLDERS[mode]
  if ((mode !== 'send' && mode !== 'continue') || !s.activeRunId) return base
  const tag = runTagOf(s, s.activeRunId)
  if (mode === 'continue') return `Send to continue ${tag} with its memory`
  const prefix = `Message ${tag}`
  const raw = s.runs[s.activeRunId]?.summary.title
  const title = typeof raw === 'string' ? sanitizeTty(raw).replace(/\s+/g, ' ').trim() : ''
  if (!title) return prefix
  const room = width - 4 - prefix.length - 3
  // One separator rule and the env's ellipsis (ASCII, screen reader), like every other line of the shell.
  const sep = env ? separatorFor(env) : ' · '
  return room >= 6 ? `${prefix}${sep}${truncateEnd(title, room - (sep.length - 3), env ? glyphs(env).ellipsis : undefined)}` : prefix
}

/** Wraps help / usage / pager-fallback lines to the overlay's text width (never cuts a line off). */
export function wrapOverlayLines(lines: readonly string[], width: number): string[] {
  const w = Math.max(10, width)
  return lines.flatMap((l) => (l === '' ? [''] : wrapText(l, w)))
}

/** "lines 1-18 of 40 · more below" / "end" (the overlay's position cue). */
export function overlayCue(offset: number, room: number, total: number, sep: string): string {
  if (total <= room) return ''
  const last = Math.min(total, offset + room)
  return `lines ${offset + 1}-${last} of ${total}${sep}${last >= total ? 'end' : 'more below'}`
}

/** The status line's hint for a focus (keymap.ts holds the keys; panes show their own keys on their bottom line). */
export function hintsFor(focus: FocusTarget, readOnly: boolean, stopOnQuit = false, row?: RowKind, hintEnv?: TuiEnv): string {
  return statusHint(focus, { readOnly, stopOnQuit, ...(row ? { row } : {}), ...(hintEnv ? { env: hintEnv } : {}) })
}

/** The tray's row budget lives with the tray (trayLayout.ts); re-exported for older imports. */
export { trayHeight }

/** The run a ref names in this state: R<n> by runOrder, else an exact id or a unique prefix of 6+ characters. */
export function runForRef(s: TuiState, ref: string): string | undefined {
  const raw = ref.trim()
  const tag = /^[Rr]([1-9]\d*)$/.exec(raw)
  if (tag) return s.runOrder[Number(tag[1]) - 1]
  if (s.runOrder.includes(raw) || s.runs[raw]) return raw
  if (raw.length < 6) return undefined
  const hits = s.runOrder.filter((id) => id.startsWith(raw))
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * Inline mode prints into primary scrollback through one append-only list (Ink keeps a single Static): transcript rows
 * as they arrive, plus each NEW top tray card's detail lines once, so the card can be read above the 3-line footer.
 */
function useScrollback(enabled: boolean, rows: TranscriptRow[], card: TrayCard | undefined, cols: number): { rows: TranscriptRow[]; printed: ReadonlySet<string> } {
  const ref = useRef<{ list: TranscriptRow[]; seen: Set<string>; printed: Set<string> }>({ list: [], seen: new Set(), printed: new Set() })
  if (!enabled) return { rows, printed: ref.current.printed }
  const st = ref.current
  let changed = false
  for (const r of rows) {
    if (st.seen.has(r.key)) continue
    st.seen.add(r.key)
    st.list.push(r)
    changed = true
  }
  if (card) {
    const key = `card:${card.key}`
    if (!st.seen.has(key)) {
      st.seen.add(key)
      let lines: string[] = []
      try {
        lines = cardDetailLines(card, Math.max(20, cols - 2))
      } catch {
        lines = []
      }
      // The tray reads this set: a card's decision keys unlock only once its body was printed here.
      if (lines.length) st.printed.add(card.key)
      if (lines.length) {
        st.list.push({ key, runId: card.ref.runId, kind: 'system', text: lines.join('\n'), tone: 'warn' })
        changed = true
      }
    }
  }
  if (changed) st.list = [...st.list]
  return { rows: st.list, printed: st.printed }
}

/** The launched run's chain is the one followed (TuiLaunch.runId is a member of it). */
export function followsLaunch(s: TuiState, launchRunId: string | undefined): boolean {
  return launchRunId !== undefined && (s.activeRunId === launchRunId || s.activeChain.includes(launchRunId))
}

/** How an exitWhenEnded session's run was ended: by this TUI's quit, by complete_setup, or by its /stop. */
export type EndedHere = 'quit' | 'complete' | 'slash'

/**
 * The exit code and closing line of an exitWhenEnded session whose run is no longer open: 130 when this TUI's quit
 * stopped it, or someone else stopped it (endedBy 'user') unless this TUI ended it on purpose (complete_setup or
 * /stop); 0 for finished; 1 for error and for a paused run. A setup run ended by /stop before complete_setup marked
 * the project's setup complete (`setupComplete` false) is exit 1, so `orgai init && ...` never goes on with a
 * half-configured project (cli-spec 6.3(1): init exits 0 when complete_setup finishes).
 */
export function launchedRunExit(
  summary: Pick<RunSummary, 'status' | 'kind' | 'endedWithApp' | 'endedBy' | 'error'>,
  label: string,
  endedHere: EndedHere | undefined,
  setupComplete = true
): { code: number; message: string } {
  const what = sanitizeTty(label).replace(/\s+/g, ' ').trim() || 'The run'
  if (endedHere === 'quit') return { code: 130, message: `${what} stopped.` }
  const word = statusText(statusOfRun({ summary }, undefined, false))
  if (summary.status === 'error') {
    const why = summary.error ? sanitizeTty(summary.error).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    return { code: 1, message: why ? `${what} failed: ${why}` : `${what} failed.` }
  }
  if (summary.status === 'finished') {
    if (endedHere === 'complete') return { code: 0, message: `${what} finished.` }
    if (endedHere === 'slash') {
      if (summary.kind === 'setup' && !setupComplete) return { code: 1, message: `${what} ended before the setup was complete. Run orgai init again to finish it.` }
      return { code: 0, message: `${what} ended.` }
    }
    if (summary.endedBy === 'user') return { code: 130, message: `${what}: ${word}.` }
    return { code: 0, message: `${what} finished.` }
  }
  return { code: 1, message: `${what}: ${word}. Continue it with orgai resume.` }
}

/** The project's setup completed after the session opened (complete_setup sets setup.completedAt). */
export function setupCompletedSince(project: Pick<Project, 'setup'> | undefined, completedAtAtLaunch: string | undefined): boolean {
  const at = project?.setup?.state === 'complete' ? project.setup.completedAt : undefined
  return typeof at === 'string' && at !== completedAtAtLaunch
}

/**
 * `orgai [--] <prompt>` begins a work run (cli-spec 6.1). The session may have focused one of the project's live runs
 * (openTuiSession's default pick), so aim the composer at a new run first, as /new does; else the prompt would go to
 * that run as a message (runs:send) and `--team` would be dropped.
 */
export function startLaunchRun(session: TuiSessionApi, launch: Pick<TuiLaunch, 'prompt' | 'team'>): void {
  if (!launch.prompt) return
  session.setComposeTarget('new')
  session.submitPrompt(launch.prompt, launch.team ? { team: launch.team } : undefined).catch((e: unknown) => session.notify(errText(e), 'danger'))
}

export function App(props: AppProps) {
  const { terminal, env, launch, conn } = props
  const processEnv = props.processEnv ?? process.env
  const now = props.now ?? Date.now
  const bus = useMemo(() => new InputBus(), [])
  const [session, setSession] = useState<TuiSessionApi>(props.session)
  // While the terminal is suspended (the $PAGER owns it, or SIGTSTP) the view holds still: notifications are dropped
  // and every render reads the state last shown, so no frame and no <Static> transcript row is written over the
  // child. The resume listener below redraws from the current state (runTui's stdout gate covers stray frames).
  const shown = useRef<TuiState | undefined>(undefined)
  const subscribe = useCallback((cb: () => void) => session.subscribe(() => (terminal.suspended === true ? undefined : cb())), [session, terminal])
  const getSnapshot = useCallback((): TuiState => {
    if (terminal.suspended === true && shown.current !== undefined) return shown.current
    shown.current = session.getState()
    return shown.current
  }, [session, terminal])
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [onboarding, setOnboarding] = useState<boolean>(launch.onboarding !== undefined)
  const [check, setCheck] = useState<ProjectPathCheck | undefined>(undefined)
  const [checkingFolder, setCheckingFolder] = useState(launch.onboarding !== undefined)
  const [onboardingBusy, setOnboardingBusy] = useState<string | undefined>()
  const onboardingPending = useRef(false)
  const [quickEdits, setQuickEdits] = useState<boolean | undefined>(undefined)
  const [focus, setFocusRaw] = useState<FocusTarget>(launch.onboarding ? 'onboarding' : 'composer')
  // Focus lives in a ref too, updated synchronously by every focus change, and input that arrives while a change is
  // still waiting for its commit is queued and replayed (in order) once the new target has registered its handler
  // (issue #31 M9: "/runs\r" in one chunk).
  const focusRef = useRef<FocusTarget>(launch.onboarding ? 'onboarding' : 'composer')
  const pendingFocus = useRef<FocusTarget | undefined>(undefined)
  const inputQueue = useRef<InputEvent[]>([])
  const queueOverflowNoted = useRef(false)
  const lastEsc = useRef<number | undefined>(undefined)
  const panesNoticeShown = useRef(false)
  const openedNoticeDone = useRef(false)
  const [composerRows, setComposerRows] = useState(env.bufferMode === 'inline' ? 1 : COMPOSER_ROWS)
  // Tree and transcript are on unless /tree or /transcript hide them; Plan and Worktrees follow `userPanes` when the user
  // asked (/plan, /wt), else show only while something needs them (a blocked plan, a worktree in review or conflict).
  const [visible, setVisible] = useState<Record<PaneId, boolean>>({ tree: true, transcript: true, plan: true, worktrees: true })
  const [userPanes, setUserPanes] = useState<{ plan?: boolean; worktrees?: boolean }>({})
  const [size, setSize] = useState(() => terminal.size())
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined)
  const [paletteQuery, setPaletteQuery] = useState('')
  // ---- Org tree state (F1, F5). `selectedAgent` is the tree's selected row id; Enter on a plain agent row is a hook for the inspector. ----
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined)
  /** Hide finished agents (`h`, /fold). */
  const [foldOn, setFoldOn] = useState(true)
  /** Expanded "N done" groups: group key -> when it was expanded (agents that finish later fold again). */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, number>>({})
  /** Card key the tray shows first (Enter on a waiting agent row). */
  const [trayFocusKey, setTrayFocusKey] = useState<string | undefined>(undefined)
  /** Agent inspector (F4): the agent id it shows, and whether thinking rows show in it. */
  const [inspectorId, setInspectorId] = useState<string | undefined>(undefined)
  const [showThinking, setShowThinking] = useState(false)
  /** Subtree focus (F7): the agent ids `z` rooted the tree at, outermost first. */
  const [zoomStack, setZoomStack] = useState<string[]>([])
  /** The transcript maximised (F13: `m`, /focus). */
  const [maximised, setMaximised] = useState(false)
  const [, setFoldTick] = useState(0)
  const [, setRedraw] = useState(0)
  const setFocusState = useCallback((t: FocusTarget): void => {
    if (focusRef.current === t && pendingFocus.current === undefined) return
    focusRef.current = t
    pendingFocus.current = t
    setFocusRaw(t)
    setRedraw((n) => n + 1) // a commit always follows, so the queued input is flushed even when the state ends up unchanged
  }, [])
  const lastCtrlC = useRef<number | undefined>(undefined)
  const exiting = useRef(false)
  const started = useRef(false)
  // exitWhenEnded / stopOnQuit (Wave 5): who ended the launched run, and the setup state it started from.
  const endedHere = useRef<EndedHere | undefined>(undefined)
  const setupAtLaunch = useRef(launch.project?.setup?.state === 'complete' ? launch.project.setup.completedAt : undefined)
  const label = launch.title ?? 'The run'

  const notify = useCallback((text: string, tone?: Parameters<TuiSessionApi['notify']>[1]) => session.notify(text, tone), [session])
  // A notice that was about a state the user has left (another run followed, the prompt sent) stops showing at once
  // (R2-L1, L8). Kept as the notice object, so a session switch that restarts notice ids cannot hide a new one.
  const [dismissedNotice, setDismissedNotice] = useState<TuiNotice | undefined>(undefined)
  const dismissNotices = useCallback(() => setDismissedNotice(session.getState().notices.at(-1)), [session])
  const lastActiveRun = useRef(state.activeRunId)
  useEffect(() => {
    const was = lastActiveRun.current
    lastActiveRun.current = state.activeRunId
    if (was !== undefined && state.activeRunId !== was) dismissNotices()
  }, [state.activeRunId, dismissNotices])

  const cards = trayCards(state)
  const top = topCard(state)
  const summary = { ...statusSummary(state), ...(launch.title ? { title: sanitizeTty(launch.title).replace(/\s+/g, ' ').trim() } : {}) }
  const activeStatus = state.activeRunId ? state.runs[state.activeRunId]?.summary.status : undefined
  const inline = env.bufferMode === 'inline'
  const readOnly = state.readOnlyReason !== undefined
  const welcoming = !state.activeRunId && transcriptRows(state).rows.length === 0
  const messages = teamMessageRows(state)
  const decisionsInDesktop = conn.hello?.grantedScopes !== undefined && !conn.hello.grantedScopes.includes('decide')
  const connectionNotice = state.connection === 'gone' ? 'Connection lost. Reconnect to continue.' : state.connection === 'reconnecting' ? 'Reconnecting to the host.' : undefined
  const ordinaryNotice = state.notices.filter(n => n.text !== TUI_NO_DECIDE_NOTICE).at(-1)?.text
  const accessNotice = [
    connectionNotice,
    state.readOnlyReason,
    ordinaryNotice,
    ...(decisionsInDesktop ? [DESKTOP_DECISIONS_NOTICE] : [])
  ].filter(Boolean).join(' ')
  const mode: ComposerMode = readOnly ? 'readOnly' : quickEdits !== undefined && !state.project && !state.activeRunId ? 'quick' : composerMode(state)

  const focusedCard = trayFocusKey ? (cards.find((c) => c.key === trayFocusKey) ?? cards[0]) : cards[0]
  const trayRows = cards.length ? trayHeight(focusedCard ? [focusedCard, ...cards.filter((c) => c !== focusedCard)] : cards, size.cols, size.rows, inline, focus === 'tray') : inline ? 0 : 1

  // Plan and Worktrees appear on their own only when something needs them.
  const planData = planView(state)
  const worktreeData = worktreeRows(state)
  const activePlan = state.activeRunId ? state.runs[state.activeRunId]?.plan : undefined
  const autoPlan = planData !== undefined && activePlan?.status === 'blocked'
  const autoWorktrees = worktreeData.some((w) => w.status === 'review' || w.status === 'conflict' || w.reviewId !== undefined)
  const chosen: Record<PaneId, boolean> = { ...visible, plan: userPanes.plan ?? autoPlan, worktrees: userPanes.worktrees ?? autoWorktrees }
  const effective: Record<PaneId, boolean> = maximised || welcoming ? { tree: false, transcript: true, plan: false, worktrees: false } : chosen
  const effectiveRef = useRef(chosen)
  effectiveRef.current = chosen

  // Org tree rows: finished subtrees folded (F1). One timer to the next moment an agent settles, so reports fold while the run still runs.
  const clock = now()
  const runAgents = state.activeRunId ? state.runs[state.activeRunId]?.agents : undefined
  const zoomRoot = [...zoomStack].reverse().find((id) => runAgents?.[id] !== undefined)
  const treeRows = orgTreeRows(state, { collapse: foldOn, expanded: expandedGroups, now: clock, ...(zoomRoot ? { rootId: zoomRoot } : {}) })
  const selectedRow = resolveSelectedRow(treeRows, selectedAgent)
  // The pane's own default when nothing was chosen: the first agent that needs you, else the first row.
  const orderedRows = [...treeRows.filter((r) => !r.earlier), ...treeRows.filter((r) => r.earlier)]
  const selectedTreeRow = orderedRows.find((r) => r.id === selectedRow) ?? orderedRows.find((r) => r.waiting) ?? orderedRows[0]
  const rowKind: RowKind = selectedTreeRow?.kind === 'group' ? 'group' : selectedTreeRow?.waiting ? 'waiting' : 'agent'
  const zoomPath = (() => {
    if (!zoomRoot || !runAgents) return undefined
    const names: string[] = []
    for (let id: string | null = zoomRoot, hops = 0; id && runAgents[id] && hops < 60; hops++) {
      names.unshift(agentLabel(runAgents[id]))
      id = runAgents[id].parentId
    }
    return names.join(' > ')
  })()
  const zoomIds = zoomRoot && runAgents ? subtreeIds(runAgents, zoomRoot) : undefined
  const inspectorView = inspectorId && state.activeRunId ? agentDetail(state, inspectorId, clock) : undefined
  const inspecting = inspectorView !== undefined && !onboarding
  const lastMessageAt = state.activeRunId ? state.runs[state.activeRunId]?.messages?.at(-1)?.at : undefined
  const trafficDue = lastMessageAt !== undefined && clock - lastMessageAt < TUI_TRAFFIC_MS ? lastMessageAt + TUI_TRAFFIC_MS : undefined
  useEffect(() => {
    if (trafficDue === undefined) return undefined
    const timer = setTimeout(() => setFoldTick((n) => n + 1), Math.max(50, trafficDue - now() + 25))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trafficDue])
  // A different run: the inspector, the subtree focus and the selection belonged to the old one.
  useEffect(() => {
    setInspectorId(undefined)
    setZoomStack([])
    setSelectedAgent(undefined)
  }, [state.activeRunId])
  const settleDue = foldOn && runAgents ? nextSettleAt(Object.values(runAgents), clock) : undefined
  useEffect(() => {
    if (settleDue === undefined) return undefined
    const timer = setTimeout(() => setFoldTick((n) => n + 1), settleTimerDelay(settleDue, now()))
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleDue])

  const treeWanted = treeRows.length + 2 + (messages.length ? Math.min(5, messages.length * 2 + 1) : 0)
  // The inspector takes the right column (split) or the whole body; the layout keeps a transcript column for it.
  const layoutVisible: Record<PaneId, boolean> = inspecting ? { ...effective, transcript: true, plan: false } : effective
  const paletteWanted = focus === 'palette' ? Math.min(10, Math.max(3, Math.floor(size.rows / 3))) : 0
  const plan = computeLayout({
    cols: size.cols,
    rows: size.rows,
    bufferMode: env.bufferMode,
    visible: layoutVisible,
    trayRows,
    composerRows,
    paletteRows: paletteWanted,
    treeRows: treeWanted,
    worktreeRows: worktreeData.length + 1
  })
  // Inline mode draws no pane, so nothing in `panes` exists to focus or show there.
  const panes = inline ? [] : plan.panes.filter((p) => layoutVisible[p.pane])
  const paletteBox = { width: plan.palette?.width || size.cols, height: plan.palette ? plan.palette.height : paletteWanted }
  const bodyRows = Math.max(0, size.rows - plan.statusRows - plan.tray.height - plan.composer.height - paletteBox.height)
  // Overlays are framed in full-screen mode only (no box fragments in scrollback, none for a screen reader).
  const framed = !inline && !env.screenReader
  // Rows an overlay's lines get: its box is the body (the tray and composer stay), minus two borders, the title and the hint.
  const overlayRoom = inline ? Math.max(1, size.rows - 6) : Math.max(1, bodyRows - (framed ? 4 : 2))
  const overlayWidth = Math.max(10, size.cols - 2 - (framed ? 2 : 0))
  const inspectorBox = inline
    ? { width: size.cols, height: Math.max(6, Math.min(16, size.rows - 5)) }
    : plan.mode === 'split'
      ? { width: panes.find((p) => p.pane === 'transcript')?.width ?? size.cols, height: panes.find((p) => p.pane === 'transcript')?.height ?? bodyRows }
      : { width: size.cols, height: bodyRows }

  const setFocus = useCallback((t: FocusTarget) => setFocusState(t), [])

  // Keep focus on something that exists.
  useEffect(() => {
    if (focus === 'tray' && cards.length === 0) {
      inputQueue.current = [] // keys meant for a card that is gone do not become composer text
      setFocusState('composer')
    }
    if (PANE_ORDER.includes(focus as PaneId) && !panes.some((p) => p.pane === focus)) setFocusState('composer')
    if (focus === 'inspector' && !inspecting) setFocusState(panes.some((p) => p.pane === 'tree') ? 'tree' : 'composer')
  }, [focus, cards.length, panes, inspecting])

  // After a focus change commits (children have registered their handlers in their own layout effects, which run
  // first), replay the input that arrived meanwhile, in order, through the newest dispatch.
  useLayoutEffect(() => {
    if (pendingFocus.current === undefined || focus !== pendingFocus.current) return
    pendingFocus.current = undefined
    let queued = inputQueue.current
    inputQueue.current = []
    queueOverflowNoted.current = false
    if (focus === 'tray') {
      // Keys that were typed before the tray had focus (`/inbox\ry` in one chunk, Alt+D then a key) were not typed at
      // the card, so they never act on it, and the card-swap guard has not seen them: drop the printable ones and keep
      // navigation and Esc. With no card left (it was answered meanwhile) nothing is replayed (never turned into text).
      // A queued paste is dropped too: replayed into the tray it could land in an open deny-note or secret field (#35 L2).
      const keep = cards.length === 0 ? [] : queued.filter((e) => e.type !== 'paste' && !(e.type === 'key' && ((e.name === 'char' && !e.ctrl && !e.alt) || e.name === 'enter')))
      if (keep.length < queued.length && cards.length > 0) notify(KEY_DROPPED_NOTICE, 'dim')
      queued = keep
    }
    for (const e of queued) dispatchRef.current(e)
  })

  // Opening on a run that needs you which is not the newest one: say so once (issue #29 M3).
  useEffect(() => {
    if (openedNoticeDone.current || onboarding || !state.activeRunId) return
    openedNoticeDone.current = true
    if (launch.runId || launch.prompt || launch.resumeText) return
    const id = state.activeRunId
    if (state.runOrder.at(-1) === id || !cards.some((c) => c.ref.runId === id)) return
    notify(`Opened ${runTagOf(state, id)}: it needs you. /new starts a new run.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeRunId, onboarding])

  // A resize while suspended is picked up by the resume listener (setSize(terminal.size())).
  useEffect(() => terminal.onResize((cols, rows) => (terminal.suspended === true ? undefined : setSize({ cols, rows }))), [terminal])
  useEffect(() => {
    if (!terminal.onResume) return undefined
    return terminal.onResume(() => {
      session.resync().catch((e: unknown) => session.notify(`Could not resync: ${errText(e)}`, 'warn'))
      setSize(terminal.size())
      setRedraw((n) => n + 1)
    })
  }, [terminal, session])

  // ---------- Exit ----------

  const doExit = useCallback(
    (code: number, message?: string) => {
      if (exiting.current) return
      exiting.current = true
      const s = session.getState()
      const active = s.activeRunId ? s.runs[s.activeRunId]?.summary.status : undefined
      const inproc = conn.inproc !== undefined
      props.onExit(code, { session, detachedLive: !inproc && isOpen(active), ...(message ? { message } : {}) })
    },
    [session, conn, props]
  )

  // stopOnQuit: end the launched run (runs:stop on the chain's newest member), wait for its status (bounded), exit 130.
  const stopAndExit = useCallback(() => {
    if (endedHere.current === 'quit' || exiting.current) return
    endedHere.current = 'quit'
    notify('Stopping the session...')
    const ended = (): boolean => {
      const s = session.getState()
      const st = s.activeRunId ? s.runs[s.activeRunId]?.summary.status : undefined
      return !isOpen(st)
    }
    const settle = new Promise<void>((resolve) => {
      if (ended()) return resolve()
      const timer = setTimeout(() => {
        off()
        resolve()
      }, STOP_WAIT_MS)
      const off = session.subscribe(() => {
        if (!ended()) return
        clearTimeout(timer)
        off()
        resolve()
      })
    })
    const name = sanitizeTty(label).replace(/\s+/g, ' ').trim() || 'The run'
    let failure: string | undefined
    session
      .stop()
      .catch((e: unknown) => {
        failure = errText(e)
        notify(`Could not stop the run: ${failure}`, 'danger')
      })
      .then(() => settle)
      .then(() => {
        // Only claim "stopped" (130) when the run left its open status or the host accepted runs:stop; a refused or
        // failed stop leaves the run live, so say so (exit 1) instead of hiding the detached-live hint.
        if (ended() || failure === undefined) return doExit(EXIT_SIGINT, `${name} stopped.`)
        const keepsGoing = conn.inproc === undefined ? ' The run keeps going.' : ''
        doExit(EXIT_FAILURE, `Could not stop ${name}: ${failure.replace(/[.\s]+$/, '')}.${keepsGoing}`)
      })
  }, [session, notify, doExit, label, conn])

  // A confirm that is replaced by another (or still open at unmount) answers "no", so no caller waits forever.
  const pendingConfirm = useRef<((yes: boolean) => void) | undefined>(undefined)
  const confirm = useCallback(
    (question: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        pendingConfirm.current?.(false)
        pendingConfirm.current = resolve
        setOverlay({ kind: 'confirm', question, resolve: (yes) => {
          if (pendingConfirm.current === resolve) pendingConfirm.current = undefined
          resolve(yes)
        } })
      }),
    []
  )
  useEffect(
    () => () => {
      pendingConfirm.current?.(false)
      pendingConfirm.current = undefined
    },
    []
  )

  const requestQuit = useCallback(() => {
    if (launch.stopOnQuit) {
      const s = session.getState()
      const st = s.activeRunId ? s.runs[s.activeRunId]?.summary.status : undefined
      if (followsLaunch(s, launch.runId) && isOpen(st)) {
        stopAndExit()
        return
      }
    }
    const inproc = conn.inproc !== undefined
    const live = statusSummary(session.getState()).liveRuns
    if (inproc && live > 0) {
      void confirm(`Quitting stops ${live} live run${live === 1 ? '' : 's'} in this in-process host. Quit?`).then((yes) => {
        if (yes) doExit(0)
      })
      return
    }
    doExit(0)
  }, [conn, session, confirm, doExit, launch, stopAndExit])

  // ---------- Text views ----------

  const openText = useCallback(
    async (title: string, text: string): Promise<void> => {
      let shown: 'shown' | 'no-pager' = 'no-pager'
      try {
        shown = await showInPager(text, {
          env: processEnv,
          // The pager shares our process group: hold Ctrl+C / Ctrl+Z handling while it owns the terminal.
          suspend: () => (terminal.suspendForChild ? terminal.suspendForChild() : terminal.suspend()),
          resume: () => (terminal.resumeFromChild ? terminal.resumeFromChild() : terminal.resume())
        })
      } catch (e) {
        notify(`Could not open the pager: ${errText(e)}`, 'warn')
      }
      if (shown === 'no-pager') {
        // The overlay has its own title row: a text that opens with the same title and a blank line (a card's full view) does not repeat it (R2-L3).
        const lead = `${title}\n\n`
        const body = text.startsWith(lead) ? text.slice(lead.length) : text
        setOverlay({ kind: 'text', title: sanitizeTty(title), lines: [...sanitizeTty(body).split('\n'), '', PAGER_HINT], offset: 0 })
      }
    },
    [processEnv, terminal, notify]
  )

  // ---------- Sessions and runs ----------

  const switchSession = useCallback(
    async (opts: OpenTuiSessionOptions): Promise<TuiSessionApi> => {
      if (!props.openSession) {
        if (opts.runId) await session.focusRun(opts.runId)
        return session
      }
      const next = await props.openSession(opts)
      const old = session
      setSession(next)
      old.close().catch(() => undefined)
      return next
    },
    [props, session]
  )

  const submit = useCallback(
    (text: string) => {
      // "Type the prompt for the new run." and the like are answered by sending.
      dismissNotices()
      if (mode === 'quick' && quickEdits !== undefined) {
        session
          .startQuick({ prompt: text, allowEdits: quickEdits, ...(launch.team ? { team: launch.team } : {}) })
          .then(() => setQuickEdits(undefined))
          .catch((e: unknown) => notify(errText(e), 'danger'))
        return
      }
      session.submitPrompt(text).catch((e: unknown) => notify(errText(e), 'danger'))
    },
    [mode, quickEdits, session, launch.team, notify, dismissNotices]
  )

  const chooseOnboarding = useCallback(
    async (choice: OnboardingChoice): Promise<void> => {
      if (onboardingPending.current) return
      const folder = launch.onboarding?.folder ?? state.folder
      if (choice.kind === 'quick') {
        setOnboarding(false)
        setFocusState('composer')
        if (launch.prompt) {
          session.startQuick({ prompt: launch.prompt, allowEdits: choice.allowEdits, ...(launch.team ? { team: launch.team } : {}) }).catch((e: unknown) => notify(errText(e), 'danger'))
        } else {
          setQuickEdits(choice.allowEdits)
          notify(choice.allowEdits ? 'Quick run: edits allowed, each still asks. Type the first message.' : 'Quick run: read-only start, an edit or command asks. Type the first message.')
        }
        return
      }
      const input = {
        name: basename(folder) || 'Project',
        path: folder,
        brief: '',
        kind: 'code' as const,
        ...(processEnv.ORGAI_MOCK === '1' ? { mock: true } : {}),
        ...(choice.kind === 'import' ? { importAgents: choice.sources } : {})
      }
      onboardingPending.current = true
      setOnboardingBusy(choice.kind === 'architect' ? 'Starting the Architect' : 'Creating your project')
      try {
        notify(choice.kind === 'architect' ? 'Creating the project and starting the Architect...' : 'Creating the project...')
        const project = await conn.createProject(input)
        if (choice.kind === 'architect') {
          const run = await conn.startSetup(project.id)
          await switchSession({ project, runId: run.id, folder })
        } else {
          const next = await switchSession({ project, folder })
          if (launch.prompt) startLaunchRun(next, launch)
        }
        setOnboarding(false)
        setFocusState('composer')
      } catch (e) {
        notify(`Could not create the project: ${errText(e)}`, 'danger')
      } finally {
        onboardingPending.current = false
        setOnboardingBusy(undefined)
      }
    },
    [launch, state.folder, processEnv, conn, switchSession, session, notify]
  )

  // The launch: onboarding's folder check, or a prompt / resume text right after the session opened.
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (launch.onboarding) {
      conn
        .checkPath(launch.onboarding.folder)
        .then(setCheck)
        .catch(() => undefined)
        .finally(() => setCheckingFolder(false))
      return
    }
    if (launch.prompt) startLaunchRun(session, launch)
    else if (launch.resumeText) session.submitPrompt(launch.resumeText).catch((e: unknown) => notify(errText(e), 'danger'))
  }, [launch, conn, session, notify])

  // exitWhenEnded: leave once the launched chain's newest member is no longer open; a setup run is ended here once its
  // project's setup completed and it is idle with no open card.
  useEffect(() => {
    if (!launch.exitWhenEnded || exiting.current || !followsLaunch(state, launch.runId) || !state.activeRunId) return
    const run = state.runs[state.activeRunId]
    if (!run) return
    const status = run.summary.status
    if (!isOpen(status)) {
      const { code, message } = launchedRunExit(run.summary, label, endedHere.current, setupCompletedSince(state.project, setupAtLaunch.current))
      doExit(code, message)
      return
    }
    if (endedHere.current === undefined && run.summary.kind === 'setup' && status === 'idle' && cards.length === 0 && setupCompletedSince(state.project, setupAtLaunch.current)) {
      endedHere.current = 'complete'
      notify('Setup is complete. Ending the session...')
      session.stop().catch((e: unknown) => notify(`Could not end the session: ${errText(e)}`, 'danger'))
    }
  }, [state, launch, label, cards.length, doExit, notify, session])

  // ---------- Org tree actions (F1, F5) ----------

  const toggleFold = (): void => {
    setFoldOn((on) => !on)
    notify(foldOn ? 'Showing every agent.' : 'Finished agents are folded into "N done" rows.')
  }
  const expandGroup = (row: { groupKey?: string; members?: string[] }): void => {
    const key = row.groupKey
    if (!key) return
    setExpandedGroups((e) => ({ ...e, [key]: now() }))
    const first = row.members?.[0]
    if (first) setSelectedAgent(first)
  }
  const collapseGroup = (row: { id: string }): void => {
    const key = collapseTarget(treeRows, row.id, expandedGroups)
    if (key === undefined) return
    setExpandedGroups(({ [key]: _gone, ...rest }) => rest)
    setSelectedAgent(row.id)
  }
  const closeInspector = (): void => {
    if (inspectorId) setSelectedAgent(inspectorId)
    setInspectorId(undefined)
    setFocusState(panes.some((p) => p.pane === 'tree') ? 'tree' : 'composer')
  }
  const openInspector = (id: string): void => {
    setSelectedAgent(id)
    setInspectorId(id)
    setFocusState('inspector')
  }
  const zoomTo = (row: { id: string }): void => {
    if (!runAgents?.[row.id]) return
    setZoomStack((st) => (st[st.length - 1] === row.id ? st : [...st, row.id]))
    setSelectedAgent(row.id)
  }
  const unzoom = (): void => {
    if (!zoomRoot) {
      notify('The tree already shows the whole run.')
      return
    }
    setSelectedAgent(zoomRoot)
    setZoomStack((st) => {
      const i = st.lastIndexOf(zoomRoot)
      return i < 0 ? [] : st.slice(0, i)
    })
  }
  const toggleFocusMode = (): void => {
    setMaximised((m) => !m)
    notify(maximised ? 'Panes are back.' : 'Transcript maximised. m or /focus brings the panes back.')
  }
  const switchLive = (dir: 1 | -1): void => {
    const chip = adjacentLiveRun(session.getState(), dir)
    if (!chip) {
      notify('No other live run.')
      return
    }
    const id = runForRef(session.getState(), chip.tag) ?? chip.runId
    session.focusRun(id).catch((err: unknown) => notify(`Could not follow ${chip.tag}: ${errText(err)}`, 'warn'))
  }
  const viewUsage = (): void => {
    void openText('Usage', usageText(session.getState()))
  }
  const viewAgentDiff = (): void => {
    const st = session.getState()
    const branch = inspectorId && st.activeRunId ? st.runs[st.activeRunId]?.agents[inspectorId]?.worktree?.branch : undefined
    if (!branch) {
      notify('This agent has no worktree.')
      return
    }
    session
      .worktreeDiff(branch)
      .then((d) => openText(`Changes on ${sanitizeTty(branch)}`, `${d.stat}\n\n${d.patch}`))
      .catch((err: unknown) => notify(`Could not read the diff: ${errText(err)}`, 'danger'))
  }
  const openKeys = (scope: 'composer' | 'tray'): void => {
    const k = whichKeyLines(scope, env)
    setOverlay({ kind: 'text', title: k.title, lines: k.lines, offset: 0, ...(scope === 'composer' ? { passThrough: true } : {}) })
  }
  const onComposerRows = useCallback((n: number): void => setComposerRows((c) => (c === n ? c : n)), [])
  const openRunsPicker = (runs: RunSummary[]): void => {
    const waiting = new Set(trayCards(session.getState()).map((c) => c.ref.runId))
    const rows = runPickRows(runs, session.getState().project?.id, waiting)
    if (rows.length === 0) {
      notify('No runs yet.')
      return
    }
    const followed = rows.findIndex((r) => r.id === session.getState().activeRunId)
    setOverlay({ kind: 'runs', rows, sel: followed >= 0 ? followed : rows.length - 1 })
  }
  const startRetro = async (runId?: string, listed?: RunSummary): Promise<void> => {
    const st = session.getState()
    const id = runId ?? st.activeRunId
    const summary = id ? (st.runs[id]?.summary ?? listed) : undefined
    if (!id || !summary || !offersRetro(summary)) {
      notify('An Org retrospective looks back at an ended work run of a project.', 'warn')
      return
    }
    const tag = runTagOf(st, id)
    const yes = await confirm(`Start an Org retrospective of ${tag}? The Architect reads the run and proposes changes to your team; you approve each one. It starts a new run that uses tokens.`)
    if (!yes) return
    await session.startRetro(id)
    notify(`Following the Org retrospective of ${tag}. Its proposals wait in the tray.`)
  }
  const focusAgentCard = (row: { id: string }): void => {
    const key = cardsByAgent(state)[row.id]?.[0]
    if (!key) return
    setTrayFocusKey(key)
    setFocusState('tray')
  }

  // ---------- Slash commands ----------

  // A /stop from this TUI ends an exitWhenEnded session on purpose (exit 0, not 130).
  const slashSession = useMemo<TuiSessionApi>(
    () =>
      Object.create(session, {
        stop: {
          value: async () => {
            if (endedHere.current === undefined) endedHere.current = 'slash'
            return session.stop()
          }
        }
      }) as TuiSessionApi,
    [session]
  )

  const slashCtx: SlashContext = {
    session: slashSession,
    state: () => session.getState(),
    notify,
    setFocus,
    togglePane: (p) => {
      if (p === 'plan' || p === 'worktrees') setUserPanes((u) => ({ ...u, [p]: !effectiveRef.current[p] }))
      else setVisible((v) => ({ ...v, [p]: !v[p] }))
    },
    toggleFold: () => toggleFold(),
    toggleFocusMode,
    openRuns: openRunsPicker,
    startRetro: () => startRetro(),
    openAgent: (arg) => {
      const st = session.getState()
      const agents = st.activeRunId ? Object.values(st.runs[st.activeRunId]?.agents ?? {}) : []
      const want = arg.trim().toLowerCase()
      if (!want) {
        notify('Name the agent: /agent <name>.', 'warn')
        return
      }
      const hit = agents.find((a) => a.id === arg.trim() || (a.handle ?? '').toLowerCase() === want || sanitizeTty(agentLabel(a)).toLowerCase() === want || a.name.toLowerCase() === want)
      if (!hit) notify(`No agent "${sanitizeTty(arg).slice(0, 64)}" in this run.`, 'warn')
      else openInspector(hit.id)
    },
    newRun: async ({ prompt, team }) => {
      session.setComposeTarget('new')
      if (prompt && prompt.trim()) {
        await session.submitPrompt(prompt, team ? { team } : undefined)
        return
      }
      setFocusState('composer')
      notify('Type the prompt for the new run.')
    },
    switchRun: async (ref) => {
      const id = runForRef(session.getState(), ref)
      if (!id) {
        notify(`No run ${sanitizeTty(ref).slice(0, 64)} in this project.`, 'warn')
        return
      }
      await session.focusRun(id)
    },
    confirm,
    openText,
    quit: requestQuit
  }

  // ---------- Input ----------

  const ring = (): FocusTarget[] => [
    'composer',
    ...(inspecting ? [...(plan.mode === 'split' ? panes.filter((p) => p.column === 0).map((p) => p.pane) : []), 'inspector' as const] : panes.map((p) => p.pane)),
    ...(cards.length ? (['tray'] as const) : [])
  ]
  const cycle = (dir: 1 | -1): void => {
    const r = ring()
    if (r.length <= 1) {
      // Only the composer: in inline mode (also --inline, a screen reader, TERM=dumb, a narrow terminal) no pane is drawn.
      if (inline && !panesNoticeShown.current) {
        panesNoticeShown.current = true
        notify(PANES_NEED_FULLSCREEN)
      }
      return
    }
    const i = r.indexOf(focusRef.current)
    setFocusState(r[(i < 0 ? 0 : i + dir + r.length) % r.length])
  }
  const focusTray = (): void => {
    setTrayFocusKey(undefined)
    if (cards.length) setFocusState('tray')
    else notify(NOTHING_NEEDS_YOU)
  }

  const overlayKey = (e: InputEvent): void => {
    if (!overlay || e.type !== 'key') return
    if (overlay.kind === 'runs') {
      const n = overlay.rows.length
      const row = overlay.rows[overlay.sel]
      const ch = e.name === 'char' && !e.ctrl && !e.alt ? e.ch : undefined
      if (named(e, 'escape') || ctrl(e, 'c') || ch === 'q') {
        setOverlay(undefined)
        return
      }
      if (named(e, 'down') || ch === 'j') setOverlay({ ...overlay, sel: Math.min(n - 1, overlay.sel + 1) })
      else if (named(e, 'up') || ch === 'k') setOverlay({ ...overlay, sel: Math.max(0, overlay.sel - 1) })
      else if (named(e, 'home')) setOverlay({ ...overlay, sel: 0 })
      else if (named(e, 'end')) setOverlay({ ...overlay, sel: n - 1 })
      else if (row && (named(e, 'enter') || ch === 'c')) {
        setOverlay(undefined)
        const continuing = ch === 'c'
        session
          .focusRun(row.id)
          .then(() => {
            setFocusState('composer')
            if (!continuing) return
            const m = composerMode(session.getState())
            notify(m === 'continue' ? `Type your message to continue ${row.tag} with its memory.` : m === 'send' ? `${row.tag} is still open: type to message it.` : `${row.tag} cannot be continued; type to start a new run.`)
          })
          .catch((err: unknown) => notify(`Could not open ${row.tag}: ${errText(err)}`, 'warn'))
      } else if (row && ch === 'r') {
        setOverlay(undefined)
        // Same availability check as /retro: a read-only session or a run that offers none notifies, never opens the confirm.
        if (!row.retro || readOnly) {
          notify(readOnly ? 'This session is read-only: it cannot start an Org retrospective.' : `${row.tag} is not an ended work run of a project, so it has no retrospective.`, 'warn')
          return
        }
        session
          .focusRun(row.id)
          .then(() => startRetro(row.id, row.summary))
          .catch((err: unknown) => notify(errText(err), 'danger'))
      }
      return
    }
    if (overlay.kind === 'confirm') {
      const ch = e.name === 'char' && !e.ctrl ? e.ch?.toLowerCase() : undefined
      if (ch === 'y' || ch === 'n' || named(e, 'escape') || ctrl(e, 'c')) {
        setOverlay(undefined)
        overlay.resolve(ch === 'y')
      }
      return
    }
    if (overlay.kind !== 'text') return
    const page = overlayRoom
    const max = Math.max(0, wrapOverlayLines(overlay.lines, overlayWidth).length - page)
    let offset = overlay.offset
    if (named(e, 'escape') || ctrl(e, 'c') || (e.name === 'char' && !e.ctrl && e.ch === 'q')) {
      setOverlay(undefined)
      return
    }
    if (overlay.passThrough && e.name === 'char' && !e.ctrl && !e.alt) {
      // Opened by `?` on an empty composer: whatever the user types next is the start of their message.
      setOverlay(undefined)
      bus.dispatch(e, focusRef.current)
      return
    }
    if (named(e, 'down') || (e.name === 'char' && e.ch === 'j')) offset += 1
    else if (named(e, 'up') || (e.name === 'char' && e.ch === 'k')) offset -= 1
    else if (named(e, 'pagedown') || (e.name === 'char' && e.ch === ' ')) offset += page
    else if (named(e, 'pageup')) offset -= page
    else if (named(e, 'home')) offset = 0
    else if (named(e, 'end')) offset = max
    setOverlay({ ...overlay, offset: Math.min(max, Math.max(0, offset)) })
  }

  const dispatch = (e: InputEvent): void => {
    if (exiting.current) return
    // A focus change is waiting for its commit: hold the input until the new target's handler is registered.
    if (pendingFocus.current !== undefined) {
      if (inputQueue.current.length < 512) inputQueue.current.push(e)
      else if (!queueOverflowNoted.current) {
        // Say so once per held period (the flag resets when the queue is replayed), never once per dropped event.
        queueOverflowNoted.current = true
        notify(INPUT_QUEUE_FULL_NOTICE, 'dim')
      }
      return
    }
    const focus = focusRef.current
    if (!named(e, 'escape')) lastEsc.current = undefined
    // KeyParser keeps the first PASTE_MAX_CHARS of a paste and drops the rest.
    if (e.type === 'paste' && e.text.length >= PASTE_MAX_CHARS) notify(PASTE_CUT_NOTICE, 'warn')
    if (overlay) {
      overlayKey(e)
      return
    }
    if (ctrl(e, 'z')) {
      terminal.stopSelf?.()
      return
    }
    if (focus === 'onboarding') {
      if (ctrl(e, 'c') || ctrl(e, 'd')) {
        doExit(0)
        return
      }
      bus.dispatch(e, 'onboarding')
      return
    }
    // Pane-only keys: `?` the keys of this pane, `[` / `]` the previous / next live run, `m` maximise the transcript.
    if (e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt && (PANE_ORDER.includes(focus as PaneId) || focus === 'inspector')) {
      if (e.ch === '?') {
        const k = whichKeyLines(focus, env)
        setOverlay({ kind: 'text', title: k.title, lines: k.lines, offset: 0 })
        return
      }
      if (e.ch === '[' || e.ch === ']') {
        switchLive(e.ch === ']' ? 1 : -1)
        return
      }
      if (e.ch === 'm' && focus !== 'inspector') {
        toggleFocusMode()
        return
      }
    }
    if (named(e, 'escape') && focus === 'inspector') {
      closeInspector()
      return
    }
    if (named(e, 'backtab')) {
      if (focus === 'composer') focusTray()
      else if (focus !== 'palette') cycle(-1)
      else bus.dispatch(e, focus)
      return
    }
    if (isTrayFocusKey(e)) {
      focusTray()
      return
    }
    if (named(e, 'tab')) {
      if (focus === 'palette') {
        bus.dispatch(e, focus)
        return
      }
      if (focus === 'composer' && bus.dispatch(e, focus)) return
      cycle(1)
      return
    }
    if (ctrl(e, 'c')) {
      if ((focus === 'composer' || focus === 'palette') && bus.dispatch(e, focus)) {
        lastCtrlC.current = undefined
        return
      }
      const t = now()
      if (lastCtrlC.current !== undefined && t - lastCtrlC.current <= CTRL_C_QUIT_MS) {
        lastCtrlC.current = undefined
        requestQuit()
        return
      }
      lastCtrlC.current = t
      // 'warn': a danger / warn notice keeps its place on a narrow bar (R2-M1).
      notify(launch.stopOnQuit ? PRESS_AGAIN_STOP : PRESS_AGAIN, 'warn')
      return
    }
    if (ctrl(e, 'd')) {
      if (bus.dispatch(e, focus)) return
      if (focus === 'composer') requestQuit()
      return
    }
    if (named(e, 'escape')) {
      if (bus.dispatch(e, focus)) return
      if (focus !== 'composer') {
        setFocusState('composer')
        return
      }
      const cur = session.getState()
      const working = isWorking(cur.activeRunId ? cur.runs[cur.activeRunId]?.summary.status : undefined)
      if (cur.readOnlyReason !== undefined) {
        notify(READ_ONLY_ESC)
      } else if (!working) {
        notify(NOTHING_RUNNING)
      } else {
        // A stray Esc must not stop work: the first press asks, a second within ESC_INTERRUPT_MS interrupts.
        const t = now()
        if (lastEsc.current !== undefined && t - lastEsc.current <= ESC_INTERRUPT_MS) {
          lastEsc.current = undefined
          notify('Interrupting the run...')
          session.interrupt().catch((err: unknown) => notify(`Could not interrupt: ${errText(err)}`, 'danger'))
        } else {
          lastEsc.current = t
          notify(ESC_AGAIN)
        }
      }
      return
    }
    bus.dispatch(e, focus)
  }

  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  useEffect(() => props.input?.subscribe((e) => dispatchRef.current(e)), [props.input])

  // ---------- Render ----------

  const zoomFilter = zoomIds ? { agentIds: zoomIds } : {}
  const rawTranscript = transcriptRows(state, zoomFilter)
  const transcript = { ...rawTranscript, rows: zoomIds ? rawTranscript.rows : withTeamMilestones(state, rawTranscript.rows) }
  // The footer shows the focused card (the inspector's `d` and Enter on a waiting row move it), so that is the one printed.
  const { rows: scrollback, printed: printedCards } = useScrollback(inline, transcript.rows, focusedCard, size.cols)
  const latestNotice = state.notices.at(-1)
  const notice = latestNotice === dismissedNotice ? undefined : latestNotice
  const hintRow: RowKind = focus === 'inspector' ? (inspectorView?.waiting ? 'waiting' : inspectorView?.worktree ? 'agent' : 'bare') : rowKind
  const hints = hintsFor(focus, readOnly, launch.stopOnQuit === true, hintRow, env)
  const dimStyle = styleFor({ tone: 'dim' }, env)
  const boldStyle = styleFor({ bold: true }, env)
  const listSep = separatorFor(env)
  // Overlay frames (full-screen only): Unicode single lines, 'classic' (+ - |) in ASCII mode; none inline (no box
  // fragments in scrollback) and none for a screen reader.
  const boxBorder: { borderStyle?: 'single' | 'classic' } = framed ? { borderStyle: asciiOnly(env) ? 'classic' : 'single' } : {}

  const inspectorNode = (() => {
    if (!inspecting || !inspectorView || !inspectorId) return null
    const mine = transcriptRows(state, { agentIds: new Set([inspectorId]) })
    const rows = showThinking ? mine.rows : mine.rows.filter((r) => r.kind !== 'thinking')
    return (
      <InspectorPane
        key="inspector"
        width={inspectorBox.width}
        height={inspectorBox.height}
        focused={focus === 'inspector'}
        view={inspectorView}
        messages={messages}
        rows={rows}
        partials={partialRows(state, { agentIds: new Set([inspectorId]) })}
        omitted={mine.omitted}
        showThinking={showThinking}
        onDecide={() => focusAgentCard({ id: inspectorId })}
        onDiff={viewAgentDiff}
        onToggleThinking={() => setShowThinking((t) => !t)}
        onUsage={viewUsage}
        onNotice={(text) => notify(text)}
      />
    )
  })()

  const paneNode = (box: PaneBox) => {
    // The focused pane's own keys sit on a dim line at its bottom, so a long status line can never cut them off.
    const hint = focus === box.pane && box.height >= 6 ? paneHint(box.pane, box.pane === 'tree' ? rowKind : 'agent', 5, box.width, listSep) : ''
    const node = paneBody(box, hint ? box.height - 1 : box.height)
    if (!hint) return node
    return (
      <Box key={box.pane} flexDirection="column" width={box.width} height={box.height}>
        {node}
        <PaneLines width={box.width} height={1} lines={[{ key: 'hint', segs: cutSegs([{ text: hint, dim: true }], box.width, env) }]} env={env} />
      </Box>
    )
  }

  const paneBody = (box: PaneBox, height: number) => {
    const common = { width: box.width, height, focused: focus === box.pane }
    switch (box.pane) {
      case 'tree':
        return (
          <OrgTreePane
            key="tree"
            {...common}
            rows={treeRows}
            messages={messages}
            animated={!terminal.suspended}
            {...(selectedRow ? { selectedId: selectedRow } : {})}
            onSelect={setSelectedAgent}
            onExpand={expandGroup}
            onCollapse={collapseGroup}
            onToggleFold={toggleFold}
            onFocusCard={focusAgentCard}
            onActivate={(row) => (row.earlier ? notify('Agents of an earlier session have no inspector; open that run to see them.') : openInspector(row.id))}
            onZoom={zoomTo}
            onUnzoom={unzoom}
            {...(zoomPath ? { zoomPath } : {})}
            onNotice={(text) => notify(text)}
            folded={foldOn}
            {...(!effective.plan && planData && planData.total > 0 ? { planChip: `Plan ${planData.done}/${planData.total}` } : {})}
          />
        )
      case 'transcript':
        if (welcoming) return <Welcome key="welcome" width={box.width} height={height} folder={state.folder} projectName={state.project?.name} animated={!terminal.suspended} />
        {
          const completed = activeStatus === 'finished' || activeStatus === 'error'
          const completionHeight = completed && height >= 10 ? 5 : 0
          return <Box key="transcript" width={box.width} height={height} flexDirection="column">
            <TranscriptPane {...common} height={height - completionHeight} mode={env.bufferMode} rows={transcript.rows} partials={partialRows(state, zoomFilter)} omitted={transcript.omitted} />
            {completionHeight ? <RunCompletion width={box.width} height={completionHeight} state={state} /> : null}
          </Box>
        }
      case 'plan':
        return <PlanPane key="plan" {...common} plan={planData} />
      case 'worktrees':
        return (
          <WorktreesPane
            key="worktrees"
            {...common}
            rows={worktreeData}
            onViewDiff={(row) => {
              session
                .worktreeDiff(row.branch)
                .then((d) => openText(`Changes on ${row.branch}`, `${d.stat}\n\n${d.patch}`))
                .catch((err: unknown) => notify(`Could not read the diff: ${errText(err)}`, 'danger'))
            }}
          />
        )
    }
  }

  const tray = !inline && cards.length === 0 && plan.tray.height > 0 && (isWorking(activeStatus) || activeStatus === 'finished')
    ? <RunActivity width={size.cols} rows={treeRows} status={activeStatus!} startedAt={state.activeRunId ? state.runs[state.activeRunId]?.summary.startedAt : undefined} endedAt={state.activeRunId ? state.runs[state.activeRunId]?.summary.endedAt : undefined} animated={!terminal.suspended} canInterrupt={!readOnly} />
    : cards.length || !inline ? (
      <DecisionTray
        width={plan.tray.width || size.cols}
        height={plan.tray.height || trayRows}
        focused={focus === 'tray'}
        variant={inline ? 'footer' : 'full'}
        cards={cards}
        resolved={state.resolved}
        onDecide={(_card, call) => session.decide(call)}
        onViewText={openText}
        onLeave={() => {
          setTrayFocusKey(undefined)
          setFocusState('composer')
        }}
        now={now}
        onHelp={() => openKeys('tray')}
        onNotice={(text, tone) => {
          // The drop notice ("Press the key again.") already told the user what happened to a key sent with Alt+D; the
          // swap guard's sentence about the same moment must not replace it (R2-L6).
          const last = session.getState().notices.at(-1)
          if ((text === GUARD_ARRIVED_NOTICE || text === GUARD_SWAPPED_NOTICE) && last?.text === KEY_DROPPED_NOTICE && now() - last.at < 2000) return
          notify(text, tone)
        }}
        {...(trayFocusKey ? { focusKey: trayFocusKey } : {})}
        {...(inline ? { printed: printedCards } : {})}
      />
    ) : null

  const composer = (
    <Composer
      width={plan.composer.width || size.cols}
      focused={focus === 'composer'}
      hidden={focus === 'palette'}
      mode={mode}
      placeholder={welcoming && mode === 'start' ? 'What would you like your team to work on?' : placeholderFor(mode, state, plan.composer.width || size.cols, env)}
      {...(state.readOnlyReason ? { disabledReason: state.readOnlyReason } : {})}
      onSubmit={submit}
      onOpenPalette={(initial) => {
        setPaletteQuery(initial)
        setFocusState('palette')
      }}
      onLeave={focusTray}
      onHelp={() => openKeys('composer')}
      onRows={onComposerRows}
      maxHeight={inline ? undefined : Math.max(1, size.rows - 2)}
      hints={inline ? undefined : focus === 'composer' ? hints : ['Esc prompt', 'Tab panes'].join(listSep)}
    />
  )

  const palette =
    focus === 'palette' ? (
      <SlashPalette
        width={paletteBox.width}
        height={paletteBox.height}
        focused
        query={paletteQuery}
        commands={SLASH_COMMANDS}
        state={state}
        onRun={(cmd, args) => {
          setFocusState('composer')
          Promise.resolve()
            .then(() => cmd.run(slashCtx, args))
            .catch((err: unknown) => notify(errText(err), 'danger'))
        }}
        onClose={() => setFocusState('composer')}
      />
    ) : null

  // Fullscreen keys live beside their control; keep the last line for run state and notices.
  const status = <StatusBar width={size.cols} summary={summary} {...(notice ? { notice } : {})} hints={inline || size.rows < 10 ? hints : ''} now={now} />

  const overlayNode = overlay ? (
    overlay.kind === 'runs' ? (
      <Box {...boxBorder} flexDirection="column" paddingX={1} height={inline ? undefined : Math.max(3, Math.min(bodyRows, overlay.rows.length + 4))}>
        <Text {...boldStyle}>Runs</Text>
        {runPickLines(overlay.rows, overlay.sel, overlayWidth, state.activeRunId, glyphs(env).ellipsis)
          .slice(Math.max(0, Math.min(overlay.sel - overlayRoom + 1, overlay.rows.length - overlayRoom)))
          .slice(0, overlayRoom)
          .map((l, i) => (
            <Text key={i} wrap="truncate-end" {...(l.startsWith('>') ? boldStyle : {})}>
              {l}
            </Text>
          ))}
        <Text wrap="truncate-end" {...dimStyle}>
          {['Up / Down select', 'Enter opens', 'c continues', 'r retrospective', 'Esc closes'].join(listSep)}
        </Text>
      </Box>
    ) : overlay.kind === 'confirm' ? (
      <Box {...boxBorder} flexDirection="column" paddingX={1}>
        <Text {...boldStyle}>{sanitizeTty(overlay.question)}</Text>
        <Text {...dimStyle}>{['y: yes', 'n or Esc: no'].join(listSep)}</Text>
      </Box>
    ) : (
      (() => {
        const wrapped = wrapOverlayLines(overlay.lines, overlayWidth)
        const offset = Math.min(overlay.offset, Math.max(0, wrapped.length - overlayRoom))
        const cue = overlayCue(offset, overlayRoom, wrapped.length, listSep)
        const hintParts = [...(cue ? [cue] : []), 'Up/Down PgUp/PgDn scroll', 'q or Esc closes']
        return (
          <Box {...boxBorder} flexDirection="column" paddingX={1} height={inline ? undefined : Math.max(3, bodyRows)}>
            <Text {...boldStyle}>{overlay.title}</Text>
            {wrapped.slice(offset, offset + overlayRoom).map((l, i) => (
              <Text key={i} wrap="truncate-end">
                {l || ' '}
              </Text>
            ))}
            <Text wrap="truncate-end" {...dimStyle}>
              {hintParts.join(listSep)}
            </Text>
          </Box>
        )
      })()
    )
  ) : null

  let body
  if (onboarding) {
    body = (
      <Box flexDirection="column" width={size.cols} height={inline ? undefined : size.rows}>
        <Onboarding folder={launch.onboarding?.folder ?? state.folder} check={check} width={size.cols} height={size.rows} checking={checkingFolder} busy={onboardingBusy} animated={!terminal.suspended} accessNotice={accessNotice} decisionsInDesktop={decisionsInDesktop} onChoose={(c) => void chooseOnboarding(c)} onCancel={() => doExit(0)} />
        {overlayNode}
      </Box>
    )
  } else if (inline) {
    body = (
      <Box flexDirection="column">
        <TranscriptPane mode="inline" width={size.cols} height={0} focused={focus === 'transcript'} rows={scrollback} partials={partialRows(state, zoomFilter)} omitted={transcript.omitted} />
        {overlayNode}
        {inspectorNode}
        {tray}
        {palette}
        {composer}
        {status}
      </Box>
    )
  } else {
    const col = (c: 0 | 1) => panes.filter((p) => p.column === c)
    body = (
      <Box flexDirection="column" width={size.cols} height={size.rows}>
        <Box width={size.cols} height={bodyRows} flexShrink={0}>
        {overlayNode ?? (
          <Box flexDirection={plan.mode === 'split' ? 'row' : 'column'} flexGrow={1}>
            {plan.mode === 'split' ? (
              <>
                <Box flexDirection="column">{col(0).map(paneNode)}</Box>
                <Box width={plan.gutter ?? 0} flexShrink={0} />
                <Box flexDirection="column" flexGrow={1}>
                  {inspectorNode ?? col(1).map(paneNode)}
                </Box>
              </>
            ) : (
              (inspectorNode ? [inspectorNode] : panes.map(paneNode))
            )}
          </Box>
        )}
        </Box>
        {tray}
        {palette}
        {composer}
        {status}
      </Box>
    )
  }

  return (
    <TuiEnvContext.Provider value={env}>
      <InputBusContext.Provider value={bus}>{body}</InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
}
