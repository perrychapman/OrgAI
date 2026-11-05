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
import { toneColor } from './theme'
import type { AgentImportSource, InputEvent } from './types'

export type OnboardingChoice =
  | { kind: 'quick'; allowEdits: boolean }
  | { kind: 'architect' }
  | { kind: 'default' }
  | { kind: 'import'; sources: AgentImportSource[] }

export const QUICK_NOTE = 'No .orgai project files added; read-only unless you enable edits'

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
      setAllowEdits((v) => !v)
      return true
    }
    if (ch === '1' || ch === '2' || ch === '3' || (ch === 'i' && canImport)) {
      if (env.dumbTerminal) setPending(ch)
      else choose(ch)
      return true
    }
    return true
  })

  const dim = toneColor('dim', env)
  const accent = toneColor('accent', env)
  const mark = (k: Key): string => (pending === k ? '>' : ' ')
  const folder = sanitizeTty(props.folder)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>This folder is not an OrgAI project yet.</Text>
      <Text color={dim}>{folder}</Text>
      <Text> </Text>
      <Text>
        {mark('1')}
        <Text color={accent}>[1]</Text> Quick run in this folder
      </Text>
      <Text color={dim}>
        {'      '}
        {QUICK_NOTE}
      </Text>
      <Text color={dim}>
        {'      '}[e] Edits: {allowEdits ? 'on (each edit still asks)' : 'off'}
      </Text>
      <Text>
        {mark('2')}
        <Text color={accent}>[2]</Text> Set up project with the Architect
      </Text>
      <Text>
        {mark('3')}
        <Text color={accent}>[3]</Text> Create project with default team
      </Text>
      {canImport ? (
        <Text>
          {mark('i')}
          <Text color={accent}>[i]</Text> Import {imp.count} detected agent definition{imp.count === 1 ? '' : 's'}
          {imp.labels.length ? ` (${imp.labels.join(', ')})` : ''}
        </Text>
      ) : null}
      <Text> </Text>
      <Text color={dim}>{env.dumbTerminal ? 'Type a choice, then Enter. Esc or q cancels.' : 'Press a key to choose. Esc or q cancels.'}</Text>
    </Box>
  )
}
