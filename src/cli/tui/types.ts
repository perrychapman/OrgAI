/**
 * The interactive terminal UI's shared contract (cli-spec 5, Wave 4). Every TUI module (state, selectors, session,
 * decisions, panes, input, shell) builds on these names; the parallel Wave 4 tasks must not change them (a task that
 * needs more adds a local type in its own file). No React import here: this file is loaded by pure modules and tests.
 *
 * INK_NOTES (ink 8.0.0, read from node_modules/ink/build; facts for the Wave 4 tasks):
 * - Exports: render, renderToString, Box, Text, Static, Transform, Newline, Spacer, useInput, usePaste, useApp,
 *   useStdin, useStdout, useStderr, useFocus, useFocusManager, useIsScreenReaderEnabled, useCursor, useAnimation,
 *   useWindowSize, useBoxMetrics, measureElement, kittyFlags / kittyModifiers. ESM only, engines node >= 22, peers
 *   react >= 19.3.0 (react-devtools-core is an optional peer and is NOT installed; never set DEV=true).
 * - render(node, options) options: stdout, stdin, stderr, debug, exitOnCtrlC (default true), patchConsole (default
 *   true), onRender, isScreenReaderEnabled (default env INK_SCREEN_READER === 'true'), maxFps (30),
 *   incrementalRendering, concurrent, kittyKeyboard (opt-in; omit it so Ink never queries the terminal), interactive
 *   (auto: false when is-in-ci detects CI or stdout is not a TTY, and then Ink writes ONLY the final frame at unmount,
 *   so pass `interactive: true` explicitly when stdout is a TTY, including the PTY e2e under CI) and alternateScreen
 *   (default false). Instance: rerender, unmount, waitUntilExit, waitUntilRenderFlush, cleanup, clear.
 * - Raw mode: Ink calls stdin.setRawMode(true) only while a useInput / usePaste hook is active AND stdin is a TTY with
 *   setRawMode (stream.js getRawModeStream). usePaste writes \x1b[?2004h / \x1b[?2004l itself. Ink also hides the
 *   cursor while interactive and listens to stdout 'resize'; it registers signal-exit (v3) to restore on exit.
 * - THE TUI MUST NOT USE useInput OR usePaste. It reads raw stdin itself (input/keys.ts KeyParser, fed by the shell in
 *   App.tsx / terminal.ts) and routes events through context.ts InputBus. Pass Ink a stdin that never reads and is not a
 *   TTY so Ink never sets raw mode or attaches a 'readable' listener, e.g.
 *     const inkStdin = Object.assign(new PassThrough(), { isTTY: false }) as unknown as NodeJS.ReadStream
 *     render(<App .../>, { stdin: inkStdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false,
 *       interactive: stdout.isTTY === true, alternateScreen: false, isScreenReaderEnabled: env.screenReader })
 *   terminal.ts owns raw mode, bracketed paste (\x1b[?2004h/l) and the alternate screen (\x1b[?1049h/l) so the buffer
 *   mode chosen at startup is restored exactly after SIGTSTP / SIGCONT and the pager (cli-spec 5.1); do not use Ink's
 *   alternateScreen or useApp().suspendTerminal for that.
 * - <Static items={...}>{(item, i) => <Box key=...>}</Static> writes each item once above the live frame (primary
 *   scrollback in inline mode); items already written are never re-rendered, so only append to its array.
 * - Text props: color, backgroundColor, dimColor, bold, italic, underline, strikethrough, inverse, wrap ('wrap' |
 *   'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end'). Box is flexbox (yoga-layout, wasm-in-JS, no
 *   native addon): width / height / flexDirection / flexGrow / borderStyle / overflow 'hidden' ...
 * - Ink sanitizes nothing we rely on: every untrusted string goes through sanitizeTty.ts before it reaches a <Text>.
 * - Tests: ink-testing-library 4.0.0 render(tree) -> { lastFrame(), frames, rerender, unmount, stdin, stdout };
 *   its stdout has 100 columns. Frames are plain text when colour is off (FORCE_COLOR=0 or chalk level 0).
 */
import type {
  AgentImportSource,
  AgentInstance,
  AgentState,
  CardKind,
  DecidedBy,
  DecisionOutcome,
  HostKind,
  McpInstallRequest,
  MergeReview,
  PendingCards,
  PermissionRequest,
  PermissionRuleRequest,
  Project,
  ProjectCreateInput,
  ProjectKind,
  ProjectPathCheck,
  Proposal,
  RpcHelloResult,
  RunPlan,
  RunSummary,
  RunTeam,
  TranscriptEntry,
  UserQuestion,
  WorktreeDiff,
  WorktreeStatus
} from '../../shared/types'
import type { HostClient, InprocHostHandle } from '../types'

// Re-exported for the onboarding props (Onboarding.tsx).
export type { AgentImportSource }

// ---------- Constants ----------

/** Full-screen (alternate buffer) needs at least this many columns at launch (cli-spec 5.1). */
export const FULLSCREEN_MIN_COLS = 100
/** ... and this many rows. */
export const FULLSCREEN_MIN_ROWS = 24
/** Two-column split layout from this width; stacked below. */
export const SPLIT_MIN_COLS = 110
/** Action keys are ignored this long after the top tray card changed (cli-spec 5.3(2)). */
export const CARD_SWAP_GUARD_MS = 750
/** Transcript entries kept per run in TUI state. */
export const TUI_TRANSCRIPT_MAX = 5000
/** Notices kept in state. */
export const TUI_NOTICE_MAX = 20
/** Resolved-card infos kept (for "Resolved in another window"). */
export const TUI_RESOLVED_MAX = 50

// ---------- Modes and environment ----------

export type BufferMode = 'fullscreen' | 'inline'
export type LayoutMode = 'split' | 'stacked'
export type PaneId = 'tree' | 'transcript' | 'plan' | 'worktrees'
export type FocusTarget = PaneId | 'composer' | 'tray' | 'palette' | 'onboarding'
export type Tone = 'ok' | 'warn' | 'danger' | 'dim' | 'accent' | 'running'
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'gone'

export interface TuiEnv {
  bufferMode: BufferMode
  screenReader: boolean
  color: boolean
  /** TERM=dumb: single-key decisions need Enter (cli-spec 5.3(1)). */
  dumbTerminal: boolean
  bracketedPaste: boolean
  unicode: boolean
}

// ---------- Input ----------

export type KeyName =
  | 'char'
  | 'enter'
  | 'escape'
  | 'tab'
  | 'backtab'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'f2'
  | 'unknown'

/**
 * One key press. Ctrl+letter = name 'char', ch the lowercase letter, ctrl true; Ctrl+. = 'char' '.' ctrl;
 * Alt+d = 'char' 'd' alt. `raw` is the bytes that produced it.
 */
export interface KeyEvent {
  type: 'key'
  name: KeyName
  ch?: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  raw: string
}

/** A bracketed paste; `text` is already sanitized. A paste never submits. */
export interface PasteEvent {
  type: 'paste'
  text: string
}

export type InputEvent = KeyEvent | PasteEvent

/** true = consumed. */
export type InputHandler = (e: InputEvent) => boolean

// ---------- Rows and views (every string already sanitized by the producer) ----------

export interface OrgTreeRow {
  id: string
  runId: string
  depth: number
  label: string
  role: string
  state: AgentState
  stateWord: string
  activity: string
  costText: string
  isRoot: boolean
  /** An agent of an earlier chain member. */
  earlier?: boolean
  worktree?: { branch: string; status: WorktreeStatus }
}

export type TranscriptRowKind = 'user' | 'text' | 'thinking' | 'tool' | 'result' | 'system' | 'harness' | 'divider' | 'error' | 'log'

export interface TranscriptRow {
  key: string
  runId: string
  agentId?: string
  agentLabel?: string
  kind: TranscriptRowKind
  text: string
  tone?: Tone
  at?: number
}

/** A streaming (agent.partial) row for one agent. */
export interface PartialRow {
  key: string
  runId: string
  agentId: string
  agentLabel: string
  text: string
}

export interface PlanStepView {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'
  owner?: string
  note?: string
}

export interface PlanView {
  goal: string
  statusWord: string
  done: number
  total: number
  steps: PlanStepView[]
}

export interface WorktreeRow {
  agentId: string
  runId: string
  label: string
  branch: string
  status: WorktreeStatus
  changedFiles: number
  mergeTarget: 'main' | 'parent'
  /** Open merge review for this worktree. */
  reviewId?: string
}

export interface StatusSummary {
  projectName?: string
  runTag?: string
  runTitle?: string
  statusWord?: string
  tone?: Tone
  costText?: string
  needsYou: number
  liveRuns: number
  hostKind?: HostKind
  connection: ConnectionState
  readOnlyReason?: string
}

// ---------- Decision cards ----------

/** What a tray keypress is bound to (cli-spec 5.3(2)). */
export interface CardRef {
  hostInstanceId: string
  runId: string
  requestId: string
  kind: CardKind
  revision: number
}

/** The tray's identity for a card: changes whenever the host, run, kind, request or revision does. */
export function cardKey(ref: CardRef): string {
  return `${ref.hostInstanceId}|${ref.runId}|${ref.kind}|${ref.requestId}|${ref.revision}`
}

export type TrayCard = {
  key: string
  ref: CardRef
  runTag: string
  runKind: RunSummary['kind']
  projectKind?: ProjectKind
  /** Arrival order (TuiState.cardSeq at arrival). */
  arrivedSeq: number
} & (
  | { kind: 'permission'; card: PermissionRequest }
  | { kind: 'rules'; card: PermissionRuleRequest }
  | { kind: 'proposal'; card: Proposal }
  | { kind: 'question'; card: UserQuestion }
  | { kind: 'merge'; card: MergeReview }
  | { kind: 'mcpInstall'; card: McpInstallRequest }
)

export interface ResolvedCardInfo {
  key: string
  ref: CardRef
  cancelled: boolean
  decidedBy?: DecidedBy
  at: number
}

export type DecisionChannel =
  | 'runs:decide'
  | 'permissions:decideRequest'
  | 'setup:decide'
  | 'setup:answer'
  | 'merges:decide'
  | 'mcp:answerInstall'

/** One host call answering a card (cli-spec 5.3(3) payloads). */
export interface DecisionCall {
  channel: DecisionChannel
  payload: Record<string, unknown>
}

// ---------- State ----------

export interface TuiRun {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  transcript: TranscriptEntry[]
  plan?: RunPlan
  /** Sanitized display text per agent id (agent.partial, cumulative). */
  partials: Record<string, string>
  cards: PendingCards
  /** Oldest transcript entries left out (snapshot cap or TUI_TRANSCRIPT_MAX). */
  omitted?: number
  /** The run's full record (runs:get / snapshot activeRun) has been applied. */
  recordLoaded: boolean
}

export interface TuiNotice {
  id: number
  text: string
  tone?: Tone
  at: number
}

export type ComposeTarget = 'active' | 'new'

export interface TuiState {
  hostInstanceId?: string
  hostKind?: HostKind
  connection: ConnectionState
  project?: Project
  folder: string
  runs: Record<string, TuiRun>
  /** Project runs oldest first, for R# tags. */
  runOrder: string[]
  /** Followed chain, oldest first. */
  activeChain: string[]
  /** Newest member of activeChain. */
  activeRunId?: string
  composeTarget: ComposeTarget
  readOnlyReason?: string
  notices: TuiNotice[]
  resolved: ResolvedCardInfo[]
  cardSeq: number
  lastSeq?: number
}

// ---------- Session ----------

/** An authenticated host connection for the TUI (session.ts connectTuiHost). */
export interface TuiHostConnection {
  readonly client: HostClient
  readonly hello: RpcHelloResult
  /** Set when the TUI started a `--host inproc` host. */
  readonly inproc?: InprocHostHandle
  /** This TUI started the host. */
  readonly started: boolean
  projects(): Promise<Project[]>
  checkPath(path: string): Promise<ProjectPathCheck>
  /** Reconnects with the 'configure' scope (onboarding only). */
  createProject(input: ProjectCreateInput): Promise<Project>
  startSetup(projectId: string): Promise<RunSummary>
  close(opts?: { stopInproc?: boolean }): Promise<void>
}

export interface OpenTuiSessionOptions {
  project?: Project
  runId?: string
  folder: string
  readOnlyReason?: string
}

export interface TuiSessionApi {
  getState(): TuiState
  subscribe(listener: () => void): () => void
  readonly hostKind: HostKind
  readonly hostInstanceId: string
  focusRun(runId: string): Promise<void>
  setComposeTarget(t: ComposeTarget): void
  /** Start, send or continue per the state; undefined when nothing was started. */
  submitPrompt(text: string, opts?: { team?: RunTeam }): Promise<RunSummary | undefined>
  startQuick(input: { prompt: string; allowEdits: boolean; team?: RunTeam }): Promise<RunSummary>
  interrupt(): Promise<void>
  stop(): Promise<void>
  decide(call: DecisionCall): Promise<DecisionOutcome>
  worktreeDiff(branch: string): Promise<WorktreeDiff>
  listRuns(): Promise<RunSummary[]>
  openInDesktop(runId?: string): Promise<void>
  /** Re-subscribe after SIGCONT or a reconnect. */
  resync(): Promise<void>
  notify(text: string, tone?: Tone): void
  /** Closes this session's run stream only; the shared TuiHostConnection stays open (runTui closes it). */
  close(): Promise<void>
}

// ---------- Layout ----------

export interface LayoutInput {
  cols: number
  rows: number
  bufferMode: BufferMode
  visible: Record<PaneId, boolean>
  trayRows: number
  composerRows: number
}

export interface PaneBox {
  pane: PaneId
  column: 0 | 1
  width: number
  height: number
}

export interface LayoutPlan {
  mode: LayoutMode
  statusRows: number
  panes: PaneBox[]
  tray: { width: number; height: number }
  composer: { width: number; height: number }
}

// ---------- Terminal ----------

export interface TerminalController {
  readonly bufferMode: BufferMode
  readonly bracketedPaste: boolean
  enter(): void
  suspend(): void
  resume(): void
  /** Final, synchronous, idempotent. */
  restore(): void
  size(): { cols: number; rows: number }
  onResize(fn: (cols: number, rows: number) => void): () => void
}

// ---------- Component props ----------

export interface PaneProps {
  width: number
  height: number
  focused: boolean
}

export interface OrgTreePaneProps extends PaneProps {
  rows: OrgTreeRow[]
  selectedId?: string
  onSelect?(id: string): void
}

export interface TranscriptPaneProps extends PaneProps {
  rows: TranscriptRow[]
  partials: PartialRow[]
  omitted?: number
}

export interface PlanPaneProps extends PaneProps {
  plan?: PlanView
}

export interface WorktreesPaneProps extends PaneProps {
  rows: WorktreeRow[]
  onViewDiff?(row: WorktreeRow): void
}

export interface StatusBarProps {
  width: number
  summary: StatusSummary
  notice?: TuiNotice
  hints: string
}

export interface DecisionTrayProps {
  width: number
  height: number
  focused: boolean
  variant: 'full' | 'footer'
  cards: TrayCard[]
  resolved: ResolvedCardInfo[]
  onDecide(card: TrayCard, call: DecisionCall): Promise<DecisionOutcome>
  onViewText(title: string, text: string): Promise<void>
  onLeave(): void
  now?: () => number
}

export type ComposerMode = 'start' | 'send' | 'continue' | 'quick' | 'readOnly'

export interface ComposerProps {
  width: number
  focused: boolean
  mode: ComposerMode
  placeholder: string
  disabledReason?: string
  onSubmit(text: string): void
  onOpenPalette(initial: string): void
  onLeave(): void
}

export interface SlashContext {
  session: TuiSessionApi
  state(): TuiState
  notify(text: string, tone?: Tone): void
  setFocus(t: FocusTarget): void
  togglePane(p: PaneId): void
  newRun(opts: { prompt?: string; team?: RunTeam }): Promise<void>
  switchRun(ref: string): Promise<void>
  confirm(question: string): Promise<boolean>
  openText(title: string, text: string): Promise<void>
  quit(): void
}

export interface SlashCommand {
  name: string
  aliases?: readonly string[]
  args?: string
  summary: string
  available?(s: TuiState): boolean
  run(ctx: SlashContext, args: string): void | Promise<void>
}

export interface SlashPaletteProps {
  width: number
  height: number
  focused: boolean
  query: string
  commands: readonly SlashCommand[]
  state: TuiState
  onRun(cmd: SlashCommand, args: string): void
  onClose(): void
}

/** What the TUI was started for (commands/tui.ts -> runTui). */
export interface TuiLaunch {
  project?: Project
  runId?: string
  prompt?: string
  team?: RunTeam
  resumeText?: string
  readOnlyReason?: string
  /** No project for the folder: show onboarding. */
  onboarding?: { folder: string }
  /**
   * Wave 5 (commands/interactive.ts runInteractiveRun): exit the TUI once the launched run's chain ends, with exit code
   * 0 when it ended finished and 1 when it ended in error.
   */
  exitWhenEnded?: boolean
  /** Wave 5: quitting (Ctrl+C) stops the open run (runs:stop) first, then the TUI exits 130. */
  stopOnQuit?: boolean
  /** Wave 5: a heading for the launched session (e.g. "Setup interview", "MCP assistant"). */
  title?: string
}
