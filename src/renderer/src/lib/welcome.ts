import type { ConnectionId, ConnectionInfo, PermissionMode, ProjectKind } from '@shared/types'
import { connectionLabel } from './connectionLabel'

/** First launch (ui-overhaul Welcome board): the steps before the start choice. 'start' is the choice and form itself. */
export type WelcomeStage = 1 | 2 | 3 | 'start'
export type WorkKind = ProjectKind | 'chat'

/** Set once setup is finished or skipped; the next first launch opens on the start choice. Renderer-only memory. */
export const WELCOME_DONE_KEY = 'orgai.welcome.done'

type Store = Pick<Storage, 'getItem' | 'setItem'> | null
const storage = (): Store => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
export function readWelcomeDone(s: Store = storage()): boolean {
  try {
    return s?.getItem(WELCOME_DONE_KEY) === '1'
  } catch {
    return false
  }
}
export function writeWelcomeDone(s: Store = storage()): void {
  try {
    s?.setItem(WELCOME_DONE_KEY, '1')
  } catch {
    /* storage unavailable: setup shows again next time */
  }
}

export interface ConnectOption {
  id: ConnectionId
  name: string
  /** One plain line: connected as whom, or what is missing. */
  sub: string
  connected: boolean
}

/** Step 1's choices: every enabled connection, the effective default first, then connected ones, in list order. */
export function connectOptions(list: readonly ConnectionInfo[] | null, defaultId: ConnectionId | null): ConnectOption[] {
  if (!list) return []
  const rows = list
    .filter((c) => c.connection.enabled !== false)
    .map((c, i) => {
      const connected = c.status.state === 'connected'
      const sub = connected
        ? c.status.account
          ? `Connected as ${c.status.account}.`
          : 'Connected.'
        : c.status.state === 'connecting'
          ? 'Connecting…'
          : c.status.state === 'error'
            ? 'Not working right now. Sign in again in Settings.'
            : 'Not connected yet. Sign in once and every team can use it.'
      const isDefault = c.isDefault || c.connection.id === defaultId
      return { opt: { id: c.connection.id, name: connectionLabel(c.connection.id), sub, connected }, rank: (isDefault ? 0 : 2) + (connected ? 0 : 1), i }
    })
  return rows.sort((a, b) => a.rank - b.rank || a.i - b.i).map((r) => r.opt)
}

export interface AskOption {
  mode: PermissionMode
  name: string
  sub: string
}

/** Step 3's choices: three real permission modes in plain words, most careful first. */
export const ASK_OPTIONS: readonly AskOption[] = [
  { mode: 'default', name: 'Ask about everything', sub: 'Every file change and command waits for you.' },
  { mode: 'acceptEdits', name: 'Ask before risky actions', sub: 'File changes inside the project go ahead. Commands wait unless a rule allows them.' },
  { mode: 'auto', name: 'Go ahead within the rules', sub: 'A safety check approves routine actions and asks when it is unsure. Fewest questions.' }
]

/** The option to preselect for a saved mode; a mode outside the three keeps no preselection. */
export function askChoiceFor(mode: PermissionMode | undefined): PermissionMode | null {
  return ASK_OPTIONS.some((o) => o.mode === mode) ? (mode as PermissionMode) : null
}

export const WORK_OPTIONS: readonly { kind: WorkKind; name: string; sub: string }[] = [
  { kind: 'code', name: 'Software in a repository', sub: 'A team that writes, reviews and tests code.' },
  { kind: 'engagement', name: 'Work that is not code', sub: 'A team that researches, analyses and writes documents.' },
  { kind: 'chat', name: 'Just look around', sub: 'Start with Chat. No project yet.' }
]

export const STAGE_TITLES: Record<1 | 2 | 3, { label: string; title: string; sub: string; foot: string }> = {
  1: {
    label: 'Connect an AI',
    title: 'Connect the AI your teams will use',
    sub: 'OrgAI does not come with its own AI. It runs teams on a provider you already have.',
    foot: 'Sign-in happens in Settings and opens in your browser. OrgAI never sees your password.'
  },
  2: {
    label: 'Your first work',
    title: 'What will you work on first?',
    sub: 'This decides what kind of team you start with. You can add the other kind any time.',
    foot: 'Your files stay on this computer. Teams only touch the folders you pick.'
  },
  3: {
    label: 'How much to ask',
    title: 'How much should the team ask you?',
    sub: 'This is the default for new projects. You can change it per project once you trust a team.',
    foot: 'Whatever you pick, a team never leaves the folders you gave it.'
  }
}

/** Where Next goes. Chat skips the asking step: it has no project to apply a default to yet. */
export function nextStage(stage: 1 | 2 | 3, work: WorkKind): WelcomeStage {
  if (stage === 1) return 2
  if (stage === 2) return work === 'chat' ? 'start' : 3
  return 'start'
}
export function prevStage(stage: 2 | 3): 1 | 2 {
  return stage === 3 ? 2 : 1
}
