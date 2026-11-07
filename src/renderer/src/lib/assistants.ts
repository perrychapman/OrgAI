/**
 * Assistants (virtual projects): labels, the display project, and the Chat helpers. Pure: no IPC, no store.
 * The ids and labels come from the shared contract; this file only turns them into renderer copy.
 */
import type { Project, QuickRunInfo, RunSummary, VirtualProjectId } from '@shared/types'
import { QUICK_PROJECT_ID, RUN_KIND_LABELS, VIRTUAL_PROJECT_LABELS, isVirtualProjectId } from '@shared/types'
import { newProject } from '@shared/defaults'
import { folderName } from './paths'
import { showHidden } from './hiddenChars'

/** The sidebar order of the Assistants group. */
export const ASSISTANT_ORDER: VirtualProjectId[] = ['quick', 'harness', 'skills']

/** Composer mode label of a virtual project's run while it is idle. */
export const ASSISTANT_IDLE_LABEL = 'Your turn. Reply, ask a follow-up, or end the session.'
/** Composer mode label while an assistant's question or proposal card is open: the card is the thing to answer. */
export const ASSISTANT_WAITING_LABEL = 'Waiting for your answer'
/** Composer mode label and placeholder lead of a single-agent / assistant run that is open for a reply. */
export const ASSISTANT_REPLY_LABEL = 'Reply to the assistant'

/** The composer's mode label for an open assistant session: the card to answer, else your turn while idle, else the reply label. */
export function assistantModeLabel(i: { status: RunSummary['status']; openCards: number }): string {
  if (i.openCards > 0) return ASSISTANT_WAITING_LABEL
  return i.status === 'idle' ? ASSISTANT_IDLE_LABEL : ASSISTANT_REPLY_LABEL
}

/** Whether the composer says "assistant": virtual projects, and the single-agent runs (including Skill assist on a real project). */
export function speaksAsAssistant(summary: Pick<RunSummary, 'kind' | 'quick' | 'projectId'> & Partial<Pick<RunSummary, 'team'>>): boolean {
  return isVirtualProjectId(summary.projectId) || isSingleAgentRun(summary)
}

export const assistantLabel = (id: VirtualProjectId): string => VIRTUAL_PROJECT_LABELS[id]

/** Where a run lives, in words: the virtual label, else the project's name, else "Project". */
export function locationLabel(projectId: string, projects: readonly Pick<Project, 'id' | 'name'>[]): string {
  if (isVirtualProjectId(projectId)) return VIRTUAL_PROJECT_LABELS[projectId]
  return projects.find((p) => p.id === projectId)?.name ?? 'Project'
}

/** A project to render for a virtual id when the main process has none to give: label, no folder, no roles. */
export function displayProject(id: VirtualProjectId): Project {
  const base = newProject({ name: VIRTUAL_PROJECT_LABELS[id], path: '', brief: '' })
  return { ...base, id, roles: [] }
}

/** The kind word of a run: "Chat" for a quick run, else the shared kind label ("Run", "Setup", ...). */
export function runKindLabel(summary: Pick<RunSummary, 'kind' | 'quick'> & Partial<Pick<RunSummary, 'team'>>): string {
  if (summary.quick) return 'Chat'
  if (summary.kind === 'work' && summary.team === 'single') return 'Ask'
  return RUN_KIND_LABELS[summary.kind]
}

/** "Scratch" or the folder's name. */
export function quickFolderLabel(quick: QuickRunInfo | undefined): string {
  if (!quick || quick.scratch) return 'Scratch'
  return folderName(quick.folder)
}

const PROMOTE_NAME_MAX = 80

/** The name proposed in "Save as project": the folder's name, else the run title, else "Chat". */
export function promoteName(summary: Pick<RunSummary, 'quick' | 'title'>): string {
  const q = summary.quick
  const raw = q && !q.scratch ? folderName(q.folder) : (summary.title ?? '').replace(/\s+/g, ' ').trim()
  return (raw || 'Chat').slice(0, PROMOTE_NAME_MAX)
}

export const SCRATCH_PROMOTE_REASON = 'A scratch chat cannot become a project'

export function canPromote(summary: Pick<RunSummary, 'quick'>): { ok: boolean; reason?: typeof SCRATCH_PROMOTE_REASON } {
  if (!summary.quick || summary.quick.scratch) return { ok: false, reason: SCRATCH_PROMOTE_REASON }
  return { ok: true }
}

export interface ChatSummaryInput {
  scratch: boolean
  folderName?: string
  allowEdits: boolean
  /** Display name of the Chat model ("Everyday tier"); empty until settings load. */
  model: string
  /** Effective default connection name ("Anthropic"); empty only until the connection list loads. */
  connection?: string
  mock?: boolean
}

/** The muted line on the Chat start page: where it works, what it may do, what runs it, and what it costs. */
export function chatSummaryLine(i: ChatSummaryInput): string {
  const scratch = i.scratch || !i.folderName
  const where = scratch ? 'Works in a private scratch area' : `Works in ${showHidden(i.folderName ?? '')}`
  const model = i.model || 'the configured model'
  const runs = `Runs on ${model}${i.connection ? ` via ${i.connection}` : ''}`
  const tail = [runs, i.mock ? 'Mock run, no tokens' : 'Counts toward your usage'].map((s) => `${s}.`).join(' ')
  const what = i.allowEdits
    ? `${where}. Ready to make changes; asks before each edit and command.`
    : scratch
      ? `${where}. Asks before it changes a file or runs a command.`
      : `${where}. Reads freely, asks before it changes a file or runs a command.`
  return `${what} ${tail}`
}

/** Start-page titles and descriptions. */
export const START_PAGE_COPY: Record<VirtualProjectId, { title: string; description: string }> = {
  quick: { title: 'Chat with an assistant', description: 'Ask a question or hand over a task. Nothing becomes a project unless you save it.' },
  harness: { title: 'Set up MCP servers with the assistant', description: 'Describe what your agents should be able to do. The assistant finds, connects and tests servers for your library.' },
  skills: { title: 'Improve your skills with the assistant', description: 'Review the skills in your library and write new ones. Skills for one project start from that project’s Skills section.' }
}

/** Button label of the ended-run replacement: "New chat" for Chat, else "New session". */
export const newSessionLabel = (id: VirtualProjectId): string => (id === 'quick' ? 'New chat' : 'New session')

/** Whether a run offers the Org retrospective: a finished work run of a real project, never a Chat or assistant run. */
export function offersRetro(summary: Pick<RunSummary, 'kind' | 'quick' | 'projectId' | 'status'> & Partial<Pick<RunSummary, 'team'>>): boolean {
  return summary.kind === 'work' && summary.team !== 'single' && !summary.quick && !isVirtualProjectId(summary.projectId) && (summary.status === 'finished' || summary.status === 'error')
}

/** Trimmed project name for Save as project, or an error message when it is empty or too long. */
export function promoteNameError(name: string): string | null {
  const t = name.trim()
  if (!t) return 'Enter a name.'
  if (t.length > PROMOTE_NAME_MAX) return `Use at most ${PROMOTE_NAME_MAX} characters.`
  return null
}

export const PROMOTE_NAME_LIMIT = PROMOTE_NAME_MAX

/** How the Live view shows a run: the transcript as the stage ('conversation') or the agent canvas ('canvas'). */
export type RunLayout = 'conversation' | 'canvas'

/**
 * Whether a run is single-agent by design: a Chat with team 'single', an MCP assistant or a Skill assistant run.
 * A Chat on the default team, work runs and setup runs are team runs.
 */
export function isSingleAgentRun(summary: Pick<RunSummary, 'kind' | 'quick'> & Partial<Pick<RunSummary, 'team'>>): boolean {
  if (summary.team === 'single') return true
  if (summary.quick) return summary.quick.team === 'single'
  return summary.kind === 'mcp-assist' || summary.kind === 'skill-assist'
}

/** The layout a run gets: the user's choice for that run, else conversation for single-agent runs, else canvas. */
export function runLayoutFor(summary: Pick<RunSummary, 'kind' | 'quick'> & Partial<Pick<RunSummary, 'team'>>, chosen?: RunLayout, opts?: { endedNarrow?: boolean }): RunLayout {
  // `endedNarrow` (M6): an ended, continuable work run opened in a window under 1100 px reads as a conversation, so the
  // composer and the feed fit; the user's own choice always wins.
  return chosen ?? (isSingleAgentRun(summary) || opts?.endedNarrow ? 'conversation' : 'canvas')
}

/**
 * Whether "Save as project" is offered at all: only while the run still belongs to the Chat project. After run.moved
 * the run lives in a real project and the action is gone (its quick info stays on the summary).
 */
export function offersSaveAsProject(summary: Pick<RunSummary, 'quick' | 'projectId'>): boolean {
  return !!summary.quick && summary.projectId === QUICK_PROJECT_ID
}

/** "What next?" + "Enter to send..." without doubled punctuation. */
export function composerPlaceholder(base: string): string {
  const t = base.trim().replace(/\.+$/, '')
  return `${t}${/[?!]$/.test(t) ? '' : '.'} Enter to send, Shift+Enter for a new line.`
}
