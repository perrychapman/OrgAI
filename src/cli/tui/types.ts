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
  Effort,
  HostKind,
  McpInstallRequest,
  MergeReview,
  ModelTier,
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
  RunStaffing,
  UsageStatus,
  RunStatus,
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

/**
 * Full-screen (alternate buffer) needs at least this many columns at launch (cli-spec 5.1). Below SPLIT_MIN_COLS the
 * body is the stacked layout; 70 keeps the common 80x24 window full-screen (ux-review-tui.md H3, issue #27).
 */
export const FULLSCREEN_MIN_COLS = 70
/** ... and this many rows. */
export const FULLSCREEN_MIN_ROWS = 24
/** A status-line notice shows this long, then the key hint comes back (issue #26). */
export const TUI_NOTICE_TTL_MS = 5000
/** Esc on the composer interrupts a working run only when pressed twice within this window (issue #31). */
export const ESC_INTERRUPT_MS = 1500
/** Two-column split layout from this width; stacked below. */
export const SPLIT_MIN_COLS = 110
/** Action keys are ignored this long after the top tray card changed (cli-spec 5.3(2)). */
export const CARD_SWAP_GUARD_MS = 750
/** Transcript entries kept per run in TUI state. */
export const TUI_TRANSCRIPT_MAX = 5000
/** Notices kept in state. */
export const TUI_NOTICE_MAX = 20
/** Log lines kept per run for /logs. */
export const TUI_LOGS_MAX = 1000
/** Resolved-card infos kept (for "Resolved by ..."). */
export const TUI_RESOLVED_MAX = 50
/** Agent-to-agent messages kept per run (counts only, never the text). */
export const TUI_MESSAGES_MAX = 200
/** A row whose agent sent or got a message this recently shows the traffic mark. */
export const TUI_TRAFFIC_MS = 10_000

// ---------- Modes and environment ----------

export type BufferMode = 'fullscreen' | 'inline'
export type LayoutMode = 'split' | 'stacked'
export type PaneId = 'tree' | 'transcript' | 'plan' | 'worktrees'
export type FocusTarget = PaneId | 'composer' | 'tray' | 'palette' | 'onboarding' | 'inspector'
export type Tone = 'ok' | 'warn' | 'danger' | 'dim' | 'accent' | 'running' | 'identity' | 'identityCyan' | 'identityGreen' | 'identityAmber' | 'identityPink' | 'identityBlue' | 'message' | 'code' | 'muted'
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'gone'

export interface TuiEnv {
  bufferMode: BufferMode
  screenReader: boolean
  color: boolean
  /** TERM=dumb: single-key decisions need Enter (cli-spec 5.3(1)). */
  dumbTerminal: boolean
  bracketedPaste: boolean
  unicode: boolean
  /** Resolved terminal appearance for filled input surfaces. */
  terminalTheme?: 'dark' | 'light'
  /** Opt out of decorative motion (ORGAI_REDUCED_MOTION=1). */
  reducedMotion?: boolean
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
  identityTone?: Tone
  id: string
  runId: string
  depth: number
  label: string
  role: string
  state: AgentState
  stateWord: string
  activity: string
  /** Raw activity was compound or shortened; do not infer a specific command category. */
  activityIsCompound?: boolean
  costText: string
  isRoot: boolean
  /** An agent of an earlier chain member. */
  earlier?: boolean
  worktree?: { branch: string; status: WorktreeStatus }
  // ---- Fold (F1) and row facts (F2, F5, F10); every field optional so plain rows stay valid ----
  /** 'group' is a folded "N done" row (default 'agent'). */
  kind?: 'agent' | 'group' | 'role'
  /** Configured role that has no agent in this run. */
  configuredRoleId?: string
  /** The role name adds nothing beside the label (false: drop it from the row). Default true. */
  roleShown?: boolean
  /** Row id of the visible parent (agent rows). */
  parentId?: string
  /** Group: how many agents it folds, and how many of those failed. */
  count?: number
  failed?: number
  /** Group: the key `expanded` uses (a visible agent's id, or an earlier-session key) and the folded agent ids (direct reports first). */
  groupKey?: string
  members?: string[]
  /** Agent row of an earlier session: the key of its session group (to fold it back). */
  earlierKey?: string
  /** Open decision cards of this agent. */
  waiting?: number
  /** Worktree chip text ("2f", "review", "conflict", "held"). */
  worktreeChip?: string
  /** Required-delegation badge: 'skipped reports' | 'corrected' | 'native agents' (the most serious one the agent earned). */
  delegationBadge?: string
  /** Messages this agent sent / got (F6): per peer, counted over the kept messages. */
  msgOut?: PeerCount[]
  msgIn?: PeerCount[]
  /** A message to or from this agent in the last TUI_TRAFFIC_MS. */
  traffic?: boolean
  /**
   * Resolved staffing from the newest assignment for this agent, without the model id ("everyday / medium"),
   * sanitized. With `model` the row reads "everyday (claude-sonnet-5-5) / medium"; the id is cut first when narrow,
   * then the whole text goes.
   */
  staffing?: string
  /** The newest assignment's tier and effort, so the row can rebuild the label around a cut model id. */
  staffingPick?: { tier?: ModelTier; effort?: Effort }
  /** The model this agent runs on (the assignment's model, else its live model), sanitized. */
  model?: string
  /** The connection the agent ran on, only when the run spans more than one connection. Sanitized. */
  connection?: string
}

/** One peer of an agent's message traffic: its sanitized label and how many messages. */
export interface PeerCount {
  label: string
  count: number
}

/** One live message; a sanitized preview accompanies the traffic facts. */
export interface RunMessageRec {
  from: string
  to: string | null
  toHandle: string
  at: number
  text?: string
}

/** The agent inspector's facts (every field sanitized; missing facts are left out). */
export interface InspectorView {
  id: string
  runId: string
  label: string
  role: string
  state: AgentState
  stateWord: string
  model?: string
  /** Every model the agent used (usage.models plus its live model), when more than one. */
  models?: string[]
  /** The connection it ran on, when the run spans more than one. */
  connection?: string
  wall?: string
  tokensIn?: string
  tokensOut?: string
  cost?: string
  turns?: number
  toolCalls?: number
  activity?: string
  worktree?: { branch: string; status: WorktreeStatus; files: number; mergeTarget: 'main' | 'parent' }
  waiting: number
  msgOut: PeerCount[]
  msgIn: PeerCount[]
  /** Staffing of this agent (newest assignment): the pick, why, and the model it resolved to; sanitized. */
  staffing?: { label: string; reason: string; model: string }
}

/** A live run as a status-bar chip (F8). */
export interface RunChip {
  tag: string
  runId: string
  followed: boolean
  needsYou: boolean
}

export type TranscriptRowKind = 'user' | 'text' | 'thinking' | 'tool' | 'result' | 'system' | 'harness' | 'divider' | 'error' | 'log'

export interface TranscriptRow {
  identityTone?: Tone
  key: string
  runId: string
  agentId?: string
  agentLabel?: string
  kind: TranscriptRowKind
  text: string
  tone?: Tone
  at?: number
  /** Concise display label and expanded detail, already sanitized. */
  summary?: string
  pendingSummary?: string
  detail?: string
  /** Correlates tool calls and results before compacting completed activity. */
  toolUseId?: string
}

/** A streaming (agent.partial) row for one agent. */
export interface PartialRow {
  identityTone?: Tone
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
  /** Plans that use the graph only, open steps only: running, ready, or waiting on these step titles (sanitized, in plan order). */
  flow?: { state: 'running' | 'ready' | 'waiting'; on?: string[] }
  /** The orchestrator's pick for the step: "engineer (everyday / medium)", sanitized. */
  staff?: string
}

export interface PlanView {
  runId?: string
  continued?: boolean
  status?: 'active' | 'done' | 'blocked'
  startedAt?: number
  runStatus?: RunStatus
  waiting?: boolean
  goal: string
  statusWord: string
  done: number
  total: number
  steps: PlanStepView[]
  /** Some step has after, paths or staff: the steps carry `flow`. */
  graph?: boolean
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
  /** TuiLaunch.title (sanitized), shown first. */
  title?: string
  projectName?: string
  runTag?: string
  runTitle?: string
  statusWord?: string
  tone?: Tone
  costText?: string
  /** The followed run's root model now (run.model / RunSummary.modelSelection, else the root agent's model). */
  rootModel?: string
  needsYou: number
  liveRuns: number
  /** Agents working now and steps ready to start; only set (above zero) for runs with staffing data or a graph plan. */
  working?: number
  readySteps?: number
  /** Auto-continues used and the cap ("auto 3/40"), while the followed run has a plan. */
  autoText?: string
  /** Plan windows, "5h 42% · 7d 18%"; the first thing to give way when narrow. */
  windowText?: string
  /** Live runs of the project as chips (R1* R2!), oldest first. */
  runChips?: RunChip[]
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
  /** The agent the card is about (every card kind carries one) and its sanitized label. */
  agentId?: string
  agentLabel?: string
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
  /** Latest staffing record (staffing.updated, or the run record). Shown on agent rows, the inspector and the status bar. */
  staffing?: RunStaffing
  /** Sanitized display text per agent id (agent.partial, cumulative). */
  partials: Record<string, string>
  cards: PendingCards
  /** Oldest transcript entries left out (snapshot cap or TUI_TRANSCRIPT_MAX). */
  omitted?: number
  /** The run's full record (runs:get / snapshot activeRun) has been applied. */
  recordLoaded: boolean
  /** Newest TUI_MESSAGES_MAX agent.message events (TUI-local). */
  messages?: RunMessageRec[]
  /** The run's harness log, every level, newest TUI_LOGS_MAX (record logs plus `log` events); /logs reads it. */
  logs?: { at: number; level: 'info' | 'warn' | 'error'; message: string }[]
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
  /** The newest plan-window report (usage.status): the status bar's 5-hour and 7-day figures. */
  planUsage?: UsageStatus
}

// ---------- Session ----------

/** An authenticated host connection for the TUI (session.ts connectTuiHost). */
export interface TuiHostConnection {
  readonly client: HostClient
  readonly hello: RpcHelloResult
  /** The host this TUI started in its own process. */
  readonly inproc: InprocHostHandle
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
  /** An Org retrospective of an ended work run (setup:retro, operate scope); follows the new run. */
  startRetro(runId?: string): Promise<RunSummary>
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
  /** Rows the tree would like (title, rows, footer line); the stacked layout gives it that much up to half the body. */
  treeRows?: number
  /** Rows the worktrees pane would like (split layout: it takes no more than that). */
  worktreeRows?: number
  /** Rows the open slash palette takes (0 or absent = closed); reserved above the composer (issue #28). */
  paletteRows?: number
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
  /** The slash palette's box (height 0 when closed). Optional until layout.ts fills it (issue #28). */
  palette?: { width: number; height: number }
  /** Blank columns between the split's two columns (1 in split mode, 0 stacked; issue #28 M2). */
  gutter?: number
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
  /** Right / Enter on a folded group. */
  onExpand?(row: OrgTreeRow): void
  /** Left: fold back the group the row (or its nearest expanded ancestor) opened. */
  onCollapse?(row: OrgTreeRow): void
  /** `h`: Hide finished agents on / off. */
  onToggleFold?(): void
  /** `z`: root the tree at this agent; `Z` / Backspace: back one level. */
  onZoom?(row: OrgTreeRow): void
  onUnzoom?(): void
  /** The tree is rooted at an agent (breadcrumb in the title). */
  zoomPath?: string
  /** Whether finished agents are folded (hint text). */
  folded?: boolean
  /** Enter on a row whose agent has an open card: focus the tray on that agent's card. */
  onFocusCard?(row: OrgTreeRow): void
  /** Enter on any other agent row (hook for the inspector; a no-op until it exists). */
  onActivate?(row: OrgTreeRow): void
  /** A one-line notice (nothing to jump to ...). */
  onNotice?(text: string): void
  /** "Plan 2/5" while the plan pane is hidden. */
  planChip?: string
}

export interface TranscriptPaneProps extends PaneProps {
  compact?: boolean
  detailsExpanded?: boolean
  onToggleDetails?(): void
  rows: TranscriptRow[]
  partials: PartialRow[]
  omitted?: number
  /** The focus target the scroll keys register under (default 'transcript'; the inspector uses 'inspector'). */
  focusTarget?: FocusTarget
  /** Keys the host pane handles first (the inspector's d / w / t / u). */
  extraKeys?(e: InputEvent): boolean
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
  /** Clock for notice expiry (TUI_NOTICE_TTL_MS); Date.now when absent. */
  now?: () => number
}

export interface DecisionTrayProps {
  width: number
  height: number
  focused: boolean
  variant: 'full' | 'footer'
  focusHint?: string
  cards: TrayCard[]
  resolved: ResolvedCardInfo[]
  onDecide(card: TrayCard, call: DecisionCall): Promise<DecisionOutcome>
  onViewText(title: string, text: string): Promise<void>
  onLeave(): void
  now?: () => number
  /** Card key to show first (Enter on an agent row): the tray shows that card on top while it is open. */
  focusKey?: string
  /** `?` on the focused tray (not while a text field is open): the shell opens the tray's which-key overlay. */
  onHelp?(): void
  /** A one-line status notice (a rejected key, a gated decision key; issue #25 / #31 L2). */
  onNotice?(text: string, tone?: Tone): void
  /** Footer variant: the keys of the cards whose body was printed into scrollback (absent = every card counts as printed). */
  printed?: ReadonlySet<string>
}

export type ComposerMode = 'start' | 'send' | 'continue' | 'quick' | 'readOnly'

export interface ComposerProps {
  width: number
  focused: boolean
  mode: ComposerMode
  placeholder: string
  disabledReason?: string
  /** The slash palette is open and shows the one input line: keep the rows, draw nothing. */
  hidden?: boolean
  onSubmit(text: string): void
  onOpenPalette(initial: string): void
  onLeave(): void
  /** A lone `?` on an empty composer: the shell opens the composer's which-key overlay (issue #30 L5). */
  onHelp?(): void
  /** The rows the composer draws now (text rows plus the reason line), so the layout can reserve them (issue #28). */
  onRows?(rows: number): void
}

export interface SlashContext {
  session: TuiSessionApi
  state(): TuiState
  notify(text: string, tone?: Tone): void
  setFocus(t: FocusTarget): void
  togglePane(p: PaneId): void
  /** Maximise the transcript (hide every other pane), or bring the panes back. */
  toggleFocusMode?(): void
  /** A selectable runs list (Enter opens, c continues, r retro); without it /runs prints a table. */
  openRuns?(runs: RunSummary[]): void
  /** /retro: confirm, start the Org retrospective of the active run and follow it. */
  startRetro?(): Promise<void>
  /** /agent <name>: open that agent's inspector. */
  openAgent?(arg: string): void
  /** Hide finished agents on / off (optional: older test contexts lack it). */
  toggleFold?(): void
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
  /** Why the command is unavailable right now (shown instead of "No matching command"; issue #29 M6). */
  unavailableReason?(s: TuiState): string | undefined
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
   * 0 when it ended finished and 1 when it ended in error (or paused), 130 when the user stopped it from elsewhere. A
   * setup run (kind 'setup') whose project's setup completes (complete_setup) is ended (runs:stop) once it is idle with
   * no open card, then exits 0.
   */
  exitWhenEnded?: boolean
  /** Wave 5: quitting (Ctrl+C) stops the open run (runs:stop) first, then the TUI exits 130. */
  stopOnQuit?: boolean
  /** Wave 5: a heading for the launched session (e.g. "Setup interview", "MCP assistant"). */
  title?: string
}
