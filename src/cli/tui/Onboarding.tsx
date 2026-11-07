/**
 * Folder onboarding (cli-spec 4.3): shown when the folder is not a project and no run was asked for. Option [2] uses
 * projects:create plus setup:start (ahead of Wave 5 `orgai init`); the shell (App.tsx) carries the choice out.
 * Input arrives through the InputBus for the 'onboarding' target only. On TERM=dumb a key picks and Enter confirms.
 */
import { Box, Text } from 'ink'
import { useState } from 'react'
import type { ProjectPathCheck } from '../../shared/types'
import { useFocusHandler, useTuiEnv } from './context'
import { sanitizeTty } from './sanitizeTty'
import { styleFor, type Seg } from './panes/lines'
import type { AgentImportSource, InputEvent } from './types'

export type OnboardingChoice =
  | { kind: 'quick'; allowEdits: boolean }
  | { kind: 'architect' }
  | { kind: 'default' }
  | { kind: 'import'; sources: AgentImportSource[] }

export const QUICK_NOTE = 'No .orgai project files added; read-only start: an edit or command asks'
/** What "Architect" means (issue #30 L8). */
export const ARCHITECT_NOTE = 'The Architect is the built-in setup assistant: it interviews you and proposes a team. It uses tokens.'
export const LEAVE_NOTE = 'Press a key to choose. Esc or q leaves without creating a project.'
export const LEAVE_DUMB = 'Type a choice, then Enter. Esc or q leaves without creating a project.'

/** The import line's count and the sources it imports (deduplicated, in scan order). */
export function importSummary(check: ProjectPathCheck | undefined): { count: number; sources: AgentImportSource[]; labels: string[] } {
  const list = check?.agentSources ?? []
  const sources: AgentImportSource[] = []
  for (const s of list) if (!sources.includes(s.source)) sources.push(s.source)
  const count = list.reduce((n, s) => n + (Number.isFinite(s.agentCount) && s.agentCount > 0 ? Math.floor(s.agentCount) : 0), 0)
  return { count, sources, labels: list.map((s) => sanitizeTty(String(s.label ?? '')).replace(/\s+/g, ' ').trim()).filter(Boolean) }
}

type Key = '1' | '2' | '3' | 'i'

export function Onboarding(props: {
  folder: string
  check?: ProjectPathCheck
  onChoose(choice: OnboardingChoice): void
  onCancel(): void
}) {
  const env = useTuiEnv()
  const [allowEdits, setAllowEdits] = useState(false)
  const [pending, setPending] = useState<Key | undefined>(undefined)
  const [rejected, setRejected] = useState<string | undefined>(undefined)
  const imp = importSummary(props.check)
  const canImport = imp.sources.length > 0

  const choose = (k: Key): void => {
    if (k === '1') props.onChoose({ kind: 'quick', allowEdits })
    else if (k === '2') props.onChoose({ kind: 'architect' })
    else if (k === '3') props.onChoose({ kind: 'default' })
    else if (canImport) props.onChoose({ kind: 'import', sources: imp.sources })
  }

  useFocusHandler('onboarding', (e: InputEvent): boolean => {
    if (e.type !== 'key') return true
    if (e.name === 'escape') {
      props.onCancel()
      return true
    }
    if (e.name === 'enter') {
      if (pending) choose(pending)
      return true
    }
    if (e.name !== 'char' || e.ctrl || e.alt || !e.ch) return false
    const ch = e.ch.toLowerCase()
    if (ch === 'q') {
      props.onCancel()
      return true
    }
    if (ch === 'e') {
      setRejected(undefined)
      setAllowEdits((v) => !v)
      return true
    }
    if (ch === '1' || ch === '2' || ch === '3' || (ch === 'i' && canImport)) {
      setRejected(undefined)
      if (env.dumbTerminal) setPending(ch)
      else choose(ch)
      return true
    }
    // A key that is not a choice: say which ones are (issue #30 L2).
    setRejected(sanitizeTty(e.ch).slice(0, 8))
    return true
  })

  const mark = (k: Key): string => (pending === k ? '>' : ' ')
  const folder = sanitizeTty(props.folder)
  const keys = `${canImport ? '1, 2, 3, i' : '1, 2 or 3'}, e (edits), Esc or q (leave)`
  const line = (key: string, segs: Seg[]) => (
    <Text key={key}>
      {segs.map((s, i) => (
        <Text key={i} {...styleFor(s, env)}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
  return (
    <Box flexDirection="column" paddingX={1}>
      {line('t', [{ text: 'This folder is not an OrgAI project yet.', bold: true }])}
      {line('f', [{ text: folder, tone: 'dim' }])}
      {line('b0', [{ text: ' ' }])}
      {line('1', [{ text: mark('1') }, { text: '[1]', tone: 'accent' }, { text: ' Quick run in this folder' }])}
      {line('1n', [{ text: `      ${QUICK_NOTE}`, tone: 'dim' }])}
      {line('1e', [{ text: `      [e] Edits: ${allowEdits ? 'allowed (each still asks)' : 'read-only start (an edit or command asks)'}`, tone: 'dim' }])}
      {line('2', [{ text: mark('2') }, { text: '[2]', tone: 'accent' }, { text: ' Set up project with the Architect' }])}
      {line('2n', [{ text: `      ${ARCHITECT_NOTE}`, tone: 'dim' }])}
      {line('3', [{ text: mark('3') }, { text: '[3]', tone: 'accent' }, { text: ' Create project with default team' }])}
      {canImport
        ? line('i', [
            { text: mark('i') },
            { text: '[i]', tone: 'accent' },
            { text: ` Import ${imp.count} detected agent definition${imp.count === 1 ? '' : 's'}${imp.labels.length ? ` (${imp.labels.join(', ')})` : ''}` }
          ])
        : null}
      {line('b1', [{ text: ' ' }])}
      {line('h', [{ text: env.dumbTerminal ? LEAVE_DUMB : LEAVE_NOTE, tone: 'dim' }])}
      {rejected !== undefined ? line('r', [{ text: `"${rejected}" is not a choice. Keys: ${keys}.`, tone: 'warn' }]) : null}
    </Box>
  )
}
