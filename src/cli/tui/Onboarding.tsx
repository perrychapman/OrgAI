/** First-run choices in the terminal flow; InputBus owns all keyboard and paste handling. */
import { Box } from 'ink'
import { useRef, useState } from 'react'
import { CLI_VERSION } from '../version'
import type { ProjectPathCheck } from '../../shared/types'
import { Brand, brandHeight } from './Brand'
import { Spinner } from './Motion'
import { useFocusHandler, useTuiEnv } from './context'
import { PaneLines, type PaneLine } from './panes/lines'
import { textWidth, wrapText } from './panes/text'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, glyphs } from './theme'
import type { AgentImportSource, InputEvent, TuiEnv } from './types'

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
export const DESKTOP_DECISIONS_NOTICE = 'Approvals and questions are answered in the desktop app. To answer here: App settings > Terminal access > What terminals may do > Full control.'

/** The import line's count and sources, deduplicated in scan order. */
export function importSummary(check: ProjectPathCheck | undefined): { count: number; sources: AgentImportSource[]; labels: string[] } {
  const list = check?.agentSources ?? []
  const sources: AgentImportSource[] = []
  for (const s of list) if (!sources.includes(s.source)) sources.push(s.source)
  const count = list.reduce((n, s) => n + (Number.isFinite(s.agentCount) && s.agentCount > 0 ? Math.floor(s.agentCount) : 0), 0)
  return { count, sources, labels: list.map((s) => safeInline(s.label, '')).filter(Boolean) }
}

type Key = '1' | '2' | '3' | 'i'
type LineStyle = Pick<PaneLine['segs'][number], 'tone' | 'dim' | 'bold'>

function safeInline(value: unknown, fallback: string): string {
  return sanitizeTty(String(value ?? '')).replace(/\s+/g, ' ').trim() || fallback
}

function folderLabel(folder: string, width: number, ellipsis: string): string {
  if (textWidth(folder) <= width) return folder
  let suffix = ''
  for (const ch of Array.from(folder).reverse()) {
    if (textWidth(ellipsis + ch + suffix) > width) break
    suffix = ch + suffix
  }
  return ellipsis + suffix
}

function line(key: string, text: string, style: LineStyle = {}): PaneLine {
  return { key, segs: text ? [{ text, ...style }] : [] }
}

function focusPrefix(selected: boolean, env: TuiEnv): string {
  return selected ? env.screenReader ? 'Selected: ' : asciiOnly(env) ? '> ' : '› ' : '  '
}

export function Onboarding(props: {
  folder: string
  check?: ProjectPathCheck
  onChoose(choice: OnboardingChoice): void
  onCancel(): void
  width?: number
  height?: number
  accessNotice?: string
  decisionsInDesktop?: boolean
  busy?: string
  checking?: boolean
  animated?: boolean
}) {
  const env = useTuiEnv()
  const [allowEdits, setAllowEdits] = useState(false)
  const [selected, setSelected] = useState<Key>('1')
  const [pending, setPending] = useState<Key | undefined>(undefined)
  const [rejected, setRejected] = useState<string | undefined>(undefined)
  const allowEditsRef = useRef(false)
  const selectedRef = useRef<Key>('1')
  const imp = importSummary(props.check)
  const canImport = imp.sources.length > 0
  const keys: Key[] = canImport ? ['1', '2', '3', 'i'] : ['1', '2', '3']
  const activeSelected = keys.includes(selected) ? selected : '1'
  const busy = Boolean(props.busy || props.checking)

  const choose = (key: Key): void => {
    if (key === '1') props.onChoose({ kind: 'quick', allowEdits: allowEditsRef.current })
    else if (key === '2') props.onChoose({ kind: 'architect' })
    else if (key === '3') props.onChoose({ kind: 'default' })
    else if (canImport) props.onChoose({ kind: 'import', sources: imp.sources })
  }

  useFocusHandler('onboarding', (e: InputEvent): boolean => {
    // Pasted text is always inert. Never replay pasted characters as choices or cancellation keys.
    if (e.type !== 'key') return true
    if (busy) return true
    if (e.name === 'escape') {
      props.onCancel()
      return true
    }
    if (e.name === 'enter') {
      choose(env.dumbTerminal && pending ? pending : keys.includes(selectedRef.current) ? selectedRef.current : '1')
      return true
    }
    if (e.name === 'up' || e.name === 'down') {
      if (e.ctrl || e.alt) return true
      const current = keys.includes(selectedRef.current) ? selectedRef.current : '1'
      const index = keys.indexOf(current)
      const next = e.name === 'up' ? Math.max(0, index - 1) : Math.min(keys.length - 1, index + 1)
      const nextKey = keys[next] ?? '1'
      selectedRef.current = nextKey
      setSelected(nextKey)
      if (env.dumbTerminal) setPending(nextKey)
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
      const next = !allowEditsRef.current
      allowEditsRef.current = next
      setAllowEdits(next)
      return true
    }
    if (ch === '1' || ch === '2' || ch === '3' || (ch === 'i' && canImport)) {
      setRejected(undefined)
      selectedRef.current = ch
      setSelected(ch)
      if (env.dumbTerminal) setPending(ch)
      else choose(ch)
      return true
    }
    setRejected(sanitizeTty(e.ch).slice(0, 8))
    return true
  })

  const width = Math.max(0, Math.floor(props.width ?? 80))
  const height = Math.max(0, Math.floor(props.height ?? 24))
  const inset = width >= 48 ? 2 : width >= 20 ? 1 : 0
  const inner = Math.max(0, width - inset * 2)
  const g = glyphs(env)
  const folder = safeInline(props.folder, 'Current folder')
  const rawNotice = safeInline(props.accessNotice, '')
  const accessNotice = props.decisionsInDesktop && !rawNotice.includes(DESKTOP_DECISIONS_NOTICE)
    ? [rawNotice, DESKTOP_DECISIONS_NOTICE].filter(Boolean).join(' ')
    : rawNotice
  const importText = `Import ${imp.count} detected agent definition${imp.count === 1 ? '' : 's'}${imp.labels.length ? ` (${imp.labels.join(', ')})` : ''}`
  const activity = props.busy || (props.checking ? 'Checking folder' : undefined)
  const edits = `Edits: ${allowEdits ? 'allowed (each still asks)' : 'read-only start (an edit or command asks)'}${props.decisionsInDesktop && allowEdits ? ' (approvals in desktop)' : ''}`
  const choices = [
    { key: '1' as const, title: 'Quick run in this folder', description: QUICK_NOTE, action: 'Start a quick run' },
    { key: '2' as const, title: 'Set up project with the Architect', description: ARCHITECT_NOTE, action: 'Meet the Architect' },
    { key: '3' as const, title: 'Create project with default team', description: 'Start with a ready-to-run team and adjust it as you go.', action: 'Create your project' },
    ...(canImport ? [{ key: 'i' as const, title: importText, description: 'Bring your existing agent definitions into this project.', action: 'Import your agents' }] : [])
  ]
  const selectedChoice = choices.find((choice) => choice.key === activeSelected) ?? choices[0]!
  const noticeRows = accessNotice ? wrapText(`Before you begin: ${accessNotice}`, Math.max(1, inner)).map((text, i) => line(`notice-${i}`, text)) : []
  const leaveText = env.dumbTerminal ? LEAVE_DUMB : LEAVE_NOTE
  const leaveRows = wrapText(leaveText, Math.max(1, inner)).map((text, i) => line(`leave-${i}`, text, { tone: 'muted' }))
  const rejectedRows = rejected === undefined ? [] : [line('rejected', `"${rejected}" is not a choice. Keys: ${canImport ? '1, 2, 3, i, ' : '1, 2 or 3, '}e (edits), Esc or q (leave).`, { tone: 'warn' })]

  const menu = (detailed: boolean): PaneLine[] => choices.flatMap((choice, i) => {
    const isSelected = choice.key === activeSelected
    return [
      line(`choice-${choice.key}`, `${focusPrefix(isSelected, env)}[${choice.key}] ${choice.title}`, { bold: isSelected }),
      ...(detailed ? wrapText(choice.description, Math.max(1, inner)).map((text, j) => line(`description-${choice.key}-${j}`, text, { tone: 'muted' })) : []),
      ...(choice.key === '1' ? [line('edits', `      ${edits}`, { tone: 'muted' })] : []),
      ...(detailed && i < choices.length - 1 ? [line(`gap-${i}`, '')] : [])
    ]
  })
  const header = [
    line('folder', `Folder: ${folderLabel(folder, Math.max(0, inner - 8), g.ellipsis)}`, { tone: 'muted' }),
    line('gap-header', ''),
    line('tagline', 'Your team starts here.', { bold: true }),
    line('instructions', 'Choose how to begin', { tone: 'muted' }),
    line('gap-menu', '')
  ]
  const footerRows = noticeRows.length + (noticeRows.length ? 1 : 0) + 3 + leaveRows.length + rejectedRows.length
  let main = [...header, ...menu(true)]
  let headerHeight = brandHeight(inner, env, height >= 24)
  let top = height >= 24 && headerHeight === 1 ? 1 : 0
  const activityRows = activity ? 1 : 0
  const availableMain = height - top - headerHeight - activityRows - footerRows
  if (main.length > availableMain) main = [...header, ...menu(false)]
  if (main.length > availableMain) main = [header[0]!, ...menu(false)]
  let tiny = false
  if (main.length > availableMain) {
    tiny = true
    headerHeight = 1
    top = 0
    main = menu(false)
  }
  const mainCapacity = Math.max(0, height - top - headerHeight - activityRows)
  main = main.slice(0, mainCapacity)
  const footerCapacity = Math.max(0, mainCapacity - main.length)
  const footer: PaneLine[] = []
  if (!tiny) {
    footer.push(...noticeRows)
    if (noticeRows.length) footer.push(line('notice-gap', ''))
    footer.push(line('action-top', g.h.repeat(inner), { dim: true }))
  } else if (noticeRows.length && footerCapacity >= 2) {
    footer.push(...noticeRows.slice(0, Math.max(1, footerCapacity - 2)))
  }
  const action: PaneLine = {
    key: 'action',
    segs: [
      { text: env.screenReader ? '' : `${asciiOnly(env) ? '> ' : '› '}`, tone: 'accent', bold: true },
      { text: activity ?? selectedChoice.action, bold: true },
      { text: activity ? '  Please wait' : '  Enter to continue', tone: 'muted' }
    ]
  }
  if (footer.length < footerCapacity) footer.push(action)
  if (!tiny && footer.length < footerCapacity) footer.push(line('action-bottom', g.h.repeat(inner), { dim: true }))
  if (rejectedRows.length && footer.length < footerCapacity) footer.push(...rejectedRows.slice(0, footerCapacity - footer.length))
  if (footer.length < footerCapacity) {
    const trailing = activity ? [line('hints', 'Setup is in progress.', { tone: 'muted' })] : leaveRows
    footer.push(...trailing.slice(0, footerCapacity - footer.length))
  }
  const bodyHeight = top + headerHeight + activityRows + main.length + footer.length
  const renderHeight = env.bufferMode === 'inline' ? Math.min(height, bodyHeight) : height
  const spacer = Math.max(0, renderHeight - bodyHeight)
  if (!width || !height) return <Box width={width} height={height} />

  return (
    <Box width={width} height={renderHeight} flexDirection="column" paddingX={inset} paddingTop={top} overflow="hidden">
      <Box width={inner} height={headerHeight} flexShrink={0} overflow="hidden">
        <Brand width={inner} version={tiny ? folderLabel(folder, Math.max(0, inner - 9), g.ellipsis) : `v${CLI_VERSION}`} prominent={headerHeight > 1} animated={props.animated !== false} />
      </Box>
      {activity ? <Box height={1} flexShrink={0}><Spinner label={activity} active={props.animated !== false} shimmer={false} /></Box> : null}
      <PaneLines width={inner} height={main.length} env={env} lines={main} />
      {spacer ? <Box height={spacer} flexShrink={0} /> : null}
      <Box height={footer.length} width={inner} flexDirection="column" flexShrink={0}>
        {footer.map((row) => <PaneLines key={row.key} width={inner} height={1} env={env} lines={[row]} />)}
      </Box>
    </Box>
  )
}
