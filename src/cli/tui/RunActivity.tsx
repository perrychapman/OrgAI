import { Box, Text } from 'ink'
import type { RunStatus } from '../../shared/types'
import { elapsedLabel, isWorkingAgentState, motionEnabled, useActivityTick } from './activity'
import { useTuiEnv } from './context'
import { Shimmer } from './Motion'
import { alignSegs, styleFor, type Seg } from './panes/lines'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, glyphs } from './theme'
import type { OrgTreeRow, TuiEnv } from './types'

export interface WorkLabelParts {
  prefix: string
  details: string[]
}

export function workLabelParts(rows: readonly OrgTreeRow[], status: RunStatus): WorkLabelParts {
  const current = rows.filter(row => !row.earlier && isWorkingAgentState(row.state))
  const lead = current.find(row => row.isRoot) ?? current[0]
  const base = lead?.stateWord || (status === 'starting' ? 'Starting the run' : status === 'stopping' ? 'Stopping the run' : 'Working')
  const detail = lead?.activity || ''
  const team = current.length > 1 ? `${current.length} agents working` : ''
  return {
    prefix: sanitizeTty(base).replace(/\s+/g, ' ').trim(),
    details: [team, detail].filter(Boolean).map(value => sanitizeTty(value).replace(/\s+/g, ' ').trim()).filter(Boolean)
  }
}

export function workLabel(rows: readonly OrgTreeRow[], status: RunStatus): string {
  const parts = workLabelParts(rows, status)
  return [parts.prefix, ...parts.details].filter(Boolean).join(' · ')
}

/** Label segments keep team/activity detail static while allowing only a thinking lead's short state prefix to shimmer. */
export function activityLabelSegments(rows: readonly OrgTreeRow[], status: RunStatus, env: TuiEnv, animated = true): Seg[] {
  const parts = workLabelParts(rows, status)
  const lead = rows.find(row => !row.earlier && isWorkingAgentState(row.state) && row.isRoot) ?? rows.find(row => !row.earlier && isWorkingAgentState(row.state))
  const thinking = status === 'running' && lead?.state === 'thinking' && animated && motionEnabled(env)
  const separator = asciiOnly(env) ? ' | ' : ' · '
  return [
    { text: parts.prefix, shimmer: thinking, bold: true },
    ...(parts.details.length ? [{ text: `${separator}${parts.details.join(separator)}`, bold: true }] : [])
  ]
}

/** Actual work in the already-reserved tray row. Decisions always take precedence over this display. */
export function RunActivity(props: {
  width: number
  rows: readonly OrgTreeRow[]
  status: RunStatus
  startedAt?: number
  endedAt?: number
  animated?: boolean
  canInterrupt?: boolean
}) {
  const env = useTuiEnv()
  const working = props.status === 'starting' || props.status === 'running' || props.status === 'stopping'
  const width = Math.max(0, Math.floor(props.width))
  const tick = useActivityTick(working && props.animated !== false && width > 0, env)
  const inset = width >= 20 ? 2 : 0
  const inner = Math.max(0, width - inset * 2)
  const g = glyphs(env)
  const labelSegments = working
    ? activityLabelSegments(props.rows, props.status, env, props.animated !== false)
    : [{ text: props.status === 'finished' ? 'Run finished' : 'Ready', bold: true }]
  const marker = env.screenReader ? '' : `${working ? g.spinner[tick % g.spinner.length] : g.check} `
  const elapsed = props.startedAt === undefined ? '' : elapsedLabel(props.startedAt, props.endedAt ?? Date.now())
  const meta = [elapsed, working && props.canInterrupt ? 'Esc Esc interrupts' : ''].filter(Boolean).join(asciiOnly(env) ? ' | ' : ' · ')
  const segments = alignSegs([
    { text: marker, tone: working ? 'accent' : 'ok', bold: true },
    ...labelSegments
  ], meta ? { text: meta, dim: true } : undefined, inner, env)
  return <Box width={width} height={1} paddingX={inset} overflow="hidden"><Text wrap="truncate-end">{segments.map((seg: Seg, i) => <Text key={i} {...styleFor(seg, env)}>{seg.shimmer ? <Shimmer text={seg.text} phase={tick} active={false} /> : seg.text}</Text>)}</Text></Box>
}
