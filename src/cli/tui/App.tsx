/**
 * The TUI shell (cli-spec 5.3(1) focus model): composes the status bar, panes, Decision Tray, Composer and slash
 * palette over one InputBus. Every raw input event goes through `dispatch` below: a few global keys first (tray focus,
 * pane cycling, Ctrl+Z, Ctrl+C / Ctrl+D, Esc), then only the focused target's handler, so a character typed in the
 * Composer can never reach the tray. Quitting never stops runs, except on an in-process host after a confirmation.
 */
import { Box, Text } from 'ink'
import { basename } from 'node:path'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ProjectPathCheck, RunStatus } from '../../shared/types'
import { isOpenStatus } from '../../shared/view/runChains'
import { Composer } from './Composer'
import { InputBus, InputBusContext, TuiEnvContext } from './context'
import { DecisionTray } from './DecisionTray'
import { cardDetailLines } from './decisions'
import { isTrayFocusKey } from './input/keys'
import { computeLayout } from './layout'
import { Onboarding, type OnboardingChoice } from './Onboarding'
import { OrgTreePane } from './OrgTreePane'
import { showInPager } from './pager'
import { PlanPane } from './PlanPane'
import { sanitizeTty } from './sanitizeTty'
import { composerMode, orgTreeRows, partialRows, planView, statusSummary, topCard, transcriptRows, trayCards, worktreeRows } from './selectors'
import { SLASH_COMMANDS } from './slashCommands'
import { SlashPalette } from './SlashPalette'
import { StatusBar } from './StatusBar'
import type { TuiTerminal } from './terminal'
import { toneColor } from './theme'
import { TranscriptPane } from './TranscriptPane'
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
import { WorktreesPane } from './WorktreesPane'

/** Two Ctrl+C presses within this window quit. */
export const CTRL_C_QUIT_MS = 1500
export const COMPOSER_ROWS = 3
export const PANE_ORDER: readonly PaneId[] = ['tree', 'transcript', 'plan', 'worktrees']

export const NOTHING_NEEDS_YOU = 'Nothing needs you'
export const PRESS_AGAIN = 'Press Ctrl+C again to quit'

export interface ExitInfo {
  /** The session the App ended on (onboarding may have replaced the first one). */
  session: TuiSessionApi
  /** The followed run was still live and keeps going (a daemon or desktop host). */
  detachedLive: boolean
}

/** Raw input after KeyParser (runTui feeds it; tests push events directly). */
export interface InputSource {
  subscribe(fn: (e: InputEvent) => void): () => void
}

export interface AppProps {
  session: TuiSessionApi
  terminal: TerminalController & Partial<Pick<TuiTerminal, 'onResume' | 'stopSelf'>>
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
  | { kind: 'text'; title: string; lines: string[]; offset: number }

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

export function hintsFor(focus: FocusTarget, readOnly: boolean): string {
  switch (focus) {
    case 'composer':
      return readOnly
        ? 'Alt+D decisions · Tab panes · Ctrl+C twice quits'
        : 'Enter sends · / commands · Alt+D decisions · Tab panes · Esc interrupts · Ctrl+C twice quits'
    case 'tray':
      return 'Keys on the card · Esc back'
    case 'palette':
      return 'Enter runs · Esc closes'
    case 'onboarding':
      return 'Esc cancels'
    default:
      return 'Tab next pane · Shift+Tab previous · Esc composer'
  }
}

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
function useScrollback(enabled: boolean, rows: TranscriptRow[], card: TrayCard | undefined, cols: number): TranscriptRow[] {
  const ref = useRef<{ list: TranscriptRow[]; seen: Set<string> }>({ list: [], seen: new Set() })
  if (!enabled) return rows
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
      if (lines.length) {
        st.list.push({ key, runId: card.ref.runId, kind: 'system', text: lines.join('\n'), tone: 'warn' })
        changed = true
      }
    }
  }
  if (changed) st.list = [...st.list]
  return st.list
}

export function App(props: AppProps) {
  const { terminal, env, launch, conn } = props
  const processEnv = props.processEnv ?? process.env
  const now = props.now ?? Date.now
  const bus = useMemo(() => new InputBus(), [])
  const [session, setSession] = useState<TuiSessionApi>(props.session)
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState)
  const [onboarding, setOnboarding] = useState<boolean>(launch.onboarding !== undefined)
  const [check, setCheck] = useState<ProjectPathCheck | undefined>(undefined)
  const [quickEdits, setQuickEdits] = useState<boolean | undefined>(undefined)
  const [focus, setFocusState] = useState<FocusTarget>(launch.onboarding ? 'onboarding' : 'composer')
  const [visible, setVisible] = useState<Record<PaneId, boolean>>({ tree: true, transcript: true, plan: true, worktrees: true })
  const [size, setSize] = useState(() => terminal.size())
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined)
  const [, setRedraw] = useState(0)
  const lastCtrlC = useRef<number | undefined>(undefined)
  const exiting = useRef(false)
  const started = useRef(false)

  const notify = useCallback((text: string, tone?: Parameters<TuiSessionApi['notify']>[1]) => session.notify(text, tone), [session])

  const cards = trayCards(state)
  const top = topCard(state)
  const summary = statusSummary(state)
  const activeStatus = state.activeRunId ? state.runs[state.activeRunId]?.summary.status : undefined
  const inline = env.bufferMode === 'inline'
  const readOnly = state.readOnlyReason !== undefined
  const mode: ComposerMode = readOnly ? 'readOnly' : quickEdits !== undefined && !state.project && !state.activeRunId ? 'quick' : composerMode(state)

  const trayRows = cards.length ? (inline ? 3 : Math.min(12, Math.max(6, Math.floor(size.rows / 3)))) : inline ? 0 : 1
  const plan = computeLayout({ cols: size.cols, rows: size.rows, bufferMode: env.bufferMode, visible, trayRows, composerRows: COMPOSER_ROWS })
  const panes = plan.panes.filter((p) => visible[p.pane])

  const setFocus = useCallback((t: FocusTarget) => setFocusState(t), [])

  // Keep focus on something that exists.
  useEffect(() => {
    if (focus === 'tray' && cards.length === 0) setFocusState('composer')
    if (PANE_ORDER.includes(focus as PaneId) && !panes.some((p) => p.pane === focus)) setFocusState('composer')
  }, [focus, cards.length, panes])

  useEffect(() => terminal.onResize((cols, rows) => setSize({ cols, rows })), [terminal])
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
    (code: number) => {
      if (exiting.current) return
      exiting.current = true
      const s = session.getState()
      const active = s.activeRunId ? s.runs[s.activeRunId]?.summary.status : undefined
      const inproc = conn.inproc !== undefined || session.hostKind === 'inproc'
      props.onExit(code, { session, detachedLive: !inproc && isOpen(active) })
    },
    [session, conn, props]
  )

  const confirm = useCallback((question: string): Promise<boolean> => new Promise<boolean>((resolve) => setOverlay({ kind: 'confirm', question, resolve })), [])

  const requestQuit = useCallback(() => {
    const inproc = conn.inproc !== undefined || session.hostKind === 'inproc'
    const live = statusSummary(session.getState()).liveRuns
    if (inproc && live > 0) {
      void confirm(`Quitting stops ${live} live run${live === 1 ? '' : 's'} in this in-process host. Quit?`).then((yes) => {
        if (yes) doExit(0)
      })
      return
    }
    doExit(0)
  }, [conn, session, confirm, doExit])

  // ---------- Text views ----------

  const openText = useCallback(
    async (title: string, text: string): Promise<void> => {
      let shown: 'shown' | 'no-pager' = 'no-pager'
      try {
        shown = await showInPager(text, { env: processEnv, suspend: () => terminal.suspend(), resume: () => terminal.resume() })
      } catch (e) {
        notify(`Could not open the pager: ${errText(e)}`, 'warn')
      }
      if (shown === 'no-pager') setOverlay({ kind: 'text', title: sanitizeTty(title), lines: sanitizeTty(text).split('\n'), offset: 0 })
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
      if (mode === 'quick' && quickEdits !== undefined) {
        session
          .startQuick({ prompt: text, allowEdits: quickEdits, ...(launch.team ? { team: launch.team } : {}) })
          .then(() => setQuickEdits(undefined))
          .catch((e: unknown) => notify(errText(e), 'danger'))
        return
      }
      session.submitPrompt(text).catch((e: unknown) => notify(errText(e), 'danger'))
    },
    [mode, quickEdits, session, launch.team, notify]
  )

  const chooseOnboarding = useCallback(
    async (choice: OnboardingChoice): Promise<void> => {
      const folder = launch.onboarding?.folder ?? state.folder
      if (choice.kind === 'quick') {
        setOnboarding(false)
        setFocusState('composer')
        if (launch.prompt) {
          session.startQuick({ prompt: launch.prompt, allowEdits: choice.allowEdits, ...(launch.team ? { team: launch.team } : {}) }).catch((e: unknown) => notify(errText(e), 'danger'))
        } else {
          setQuickEdits(choice.allowEdits)
          notify(choice.allowEdits ? 'Quick run: edits allowed, each still asks. Type the first message.' : 'Quick run: read-only. Type the first message.')
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
      try {
        notify(choice.kind === 'architect' ? 'Creating the project and starting the Architect...' : 'Creating the project...')
        const project = await conn.createProject(input)
        if (choice.kind === 'architect') {
          const run = await conn.startSetup(project.id)
          await switchSession({ project, runId: run.id, folder })
        } else {
          const next = await switchSession({ project, folder })
          if (launch.prompt) next.submitPrompt(launch.prompt, launch.team ? { team: launch.team } : undefined).catch((e: unknown) => next.notify(errText(e), 'danger'))
        }
        setOnboarding(false)
        setFocusState('composer')
      } catch (e) {
        notify(`Could not create the project: ${errText(e)}`, 'danger')
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
      return
    }
    if (launch.prompt) session.submitPrompt(launch.prompt, launch.team ? { team: launch.team } : undefined).catch((e: unknown) => notify(errText(e), 'danger'))
    else if (launch.resumeText) session.submitPrompt(launch.resumeText).catch((e: unknown) => notify(errText(e), 'danger'))
  }, [launch, conn, session, notify])

  // ---------- Slash commands ----------

  const slashCtx: SlashContext = {
    session,
    state: () => session.getState(),
    notify,
    setFocus,
    togglePane: (p) => setVisible((v) => ({ ...v, [p]: !v[p] })),
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

  const ring = (): FocusTarget[] => ['composer', ...panes.map((p) => p.pane), ...(cards.length ? (['tray'] as const) : [])]
  const cycle = (dir: 1 | -1): void => {
    const r = ring()
    const i = r.indexOf(focus)
    setFocusState(r[(i < 0 ? 0 : i + dir + r.length) % r.length])
  }
  const focusTray = (): void => {
    if (cards.length) setFocusState('tray')
    else notify(NOTHING_NEEDS_YOU)
  }

  const overlayKey = (e: InputEvent): void => {
    if (!overlay || e.type !== 'key') return
    if (overlay.kind === 'confirm') {
      const ch = e.name === 'char' && !e.ctrl ? e.ch?.toLowerCase() : undefined
      if (ch === 'y' || ch === 'n' || named(e, 'escape') || ctrl(e, 'c')) {
        setOverlay(undefined)
        overlay.resolve(ch === 'y')
      }
      return
    }
    const page = Math.max(1, size.rows - 4)
    const max = Math.max(0, overlay.lines.length - page)
    let offset = overlay.offset
    if (named(e, 'escape') || ctrl(e, 'c') || (e.name === 'char' && !e.ctrl && e.ch === 'q')) {
      setOverlay(undefined)
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
      notify(PRESS_AGAIN)
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
      if (isWorking(activeStatus) && !readOnly) {
        notify('Interrupting the run...')
        session.interrupt().catch((err: unknown) => notify(`Could not interrupt: ${errText(err)}`, 'danger'))
      }
      return
    }
    bus.dispatch(e, focus)
  }

  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  useEffect(() => props.input?.subscribe((e) => dispatchRef.current(e)), [props.input])

  // ---------- Render ----------

  const transcript = transcriptRows(state)
  const scrollback = useScrollback(inline, transcript.rows, top, size.cols)
  const notice = state.notices.at(-1)
  const hints = hintsFor(focus, readOnly)
  const dim = toneColor('dim', env)

  const paneNode = (box: PaneBox) => {
    const common = { width: box.width, height: box.height, focused: focus === box.pane }
    switch (box.pane) {
      case 'tree':
        return <OrgTreePane key="tree" {...common} rows={orgTreeRows(state)} selectedId={selectedAgent} onSelect={setSelectedAgent} />
      case 'transcript':
        return <TranscriptPane key="transcript" {...common} mode={env.bufferMode} rows={transcript.rows} partials={partialRows(state)} omitted={transcript.omitted} />
      case 'plan':
        return <PlanPane key="plan" {...common} plan={planView(state)} />
      case 'worktrees':
        return (
          <WorktreesPane
            key="worktrees"
            {...common}
            rows={worktreeRows(state)}
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

  const tray =
    cards.length || !inline ? (
      <DecisionTray
        width={plan.tray.width || size.cols}
        height={plan.tray.height || trayRows}
        focused={focus === 'tray'}
        variant={inline ? 'footer' : 'full'}
        cards={cards}
        resolved={state.resolved}
        onDecide={(_card, call) => session.decide(call)}
        onViewText={openText}
        onLeave={() => setFocusState('composer')}
        now={now}
      />
    ) : null

  const composer = (
    <Composer
      width={plan.composer.width || size.cols}
      focused={focus === 'composer'}
      mode={mode}
      placeholder={PLACEHOLDERS[mode]}
      {...(state.readOnlyReason ? { disabledReason: state.readOnlyReason } : {})}
      onSubmit={submit}
      onOpenPalette={(initial) => {
        setPaletteQuery(initial)
        setFocusState('palette')
      }}
      onLeave={focusTray}
    />
  )

  const palette =
    focus === 'palette' ? (
      <SlashPalette
        width={size.cols}
        height={Math.min(10, Math.max(3, Math.floor(size.rows / 3)))}
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

  const status = <StatusBar width={size.cols} summary={summary} {...(notice ? { notice } : {})} hints={hints} />

  const overlayNode = overlay ? (
    overlay.kind === 'confirm' ? (
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Text bold>{sanitizeTty(overlay.question)}</Text>
        <Text color={dim}>y: yes · n or Esc: no</Text>
      </Box>
    ) : (
      <Box borderStyle="single" flexDirection="column" paddingX={1} height={inline ? undefined : Math.max(3, size.rows - 2)}>
        <Text bold>{overlay.title}</Text>
        {overlay.lines.slice(overlay.offset, overlay.offset + Math.max(1, size.rows - 4)).map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l}
          </Text>
        ))}
        <Text color={dim}>Up / Down / PgUp / PgDn scroll · q or Esc closes</Text>
      </Box>
    )
  ) : null

  let body
  if (onboarding) {
    body = (
      <Box flexDirection="column">
        <Onboarding folder={launch.onboarding?.folder ?? state.folder} check={check} onChoose={(c) => void chooseOnboarding(c)} onCancel={() => doExit(0)} />
        {overlayNode}
        {status}
      </Box>
    )
  } else if (inline) {
    body = (
      <Box flexDirection="column">
        <TranscriptPane mode="inline" width={size.cols} height={0} focused={focus === 'transcript'} rows={scrollback} partials={partialRows(state)} omitted={transcript.omitted} />
        {overlayNode}
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
        {status}
        {overlayNode ?? (
          <Box flexDirection={plan.mode === 'split' ? 'row' : 'column'} flexGrow={1}>
            {plan.mode === 'split' ? (
              <>
                <Box flexDirection="column">{col(0).map(paneNode)}</Box>
                <Box flexDirection="column" flexGrow={1}>
                  {col(1).map(paneNode)}
                </Box>
              </>
            ) : (
              panes.map(paneNode)
            )}
          </Box>
        )}
        {tray}
        {palette}
        {composer}
      </Box>
    )
  }

  return (
    <TuiEnvContext.Provider value={env}>
      <InputBusContext.Provider value={bus}>{body}</InputBusContext.Provider>
    </TuiEnvContext.Provider>
  )
}
