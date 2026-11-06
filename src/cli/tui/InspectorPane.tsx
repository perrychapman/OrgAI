/**
 * The agent inspector (ux-review-tui-org.md F4, F6): Enter on an agent row opens it over the right column (split) or the
 * whole body (stacked, inline). A header (handle, role, state), the facts the agent has (model, wall time, tokens in /
 * out, cost, turns, tool calls; a missing one is left out), what it is doing now, its worktree, its message counts, then
 * that agent's own transcript, scrollable. Keys: d its decision card, w its worktree diff in the pager, t thinking rows,
 * u the usage tables in the pager, Up / Down / PgUp / PgDn / Home / End scroll; Esc (handled by the App) closes it. Every
 * string arrives sanitized from selectors.ts `agentDetail` / `transcriptRows`; nothing here reads the host.
 */
import { Box } from 'ink'
import { useTuiEnv } from './context'
import { glyphs, stateGlyph, stateTone } from './theme'
import { TranscriptPane } from './TranscriptPane'
import type { InputEvent, InspectorView, PartialRow, PaneProps, PeerCount, TranscriptRow, TuiEnv } from './types'
import { PaneLines, alignSegs, cutSegs, type PaneLine, type Seg } from './panes/lines'
import { paneHint } from './keymap'

export interface InspectorPaneProps extends PaneProps {
  view: InspectorView
  rows: TranscriptRow[]
  partials: PartialRow[]
  omitted?: number
  showThinking: boolean
  onDecide?(): void
  onDiff?(): void
  onToggleThinking?(): void
  onUsage?(): void
  onNotice?(text: string): void
}

const total = (peers: readonly PeerCount[]): number => peers.reduce((n, p) => n + p.count, 0)

function peerNames(peers: readonly PeerCount[]): string {
  const names = peers.slice(0, 2).map((p) => p.label)
  if (peers.length > 2) names.push(`+${peers.length - 2}`)
  return names.join(', ')
}

/** The fact lines in priority order (the last ones are dropped first in a short pane). */
export function inspectorFacts(v: InspectorView, env: TuiEnv): string[][] {
  const g = glyphs(env)
  const sep = ` ${g.bullet} `
  const out: string[][] = []
  const stats: string[] = []
  if (v.model) stats.push(`model ${v.model}`)
  if (v.wall) stats.push(v.wall)
  if (v.tokensIn !== undefined && v.tokensOut !== undefined) stats.push(`${v.tokensIn} in / ${v.tokensOut} out`)
  if (v.cost) stats.push(v.cost)
  if (v.turns !== undefined) stats.push(`${v.turns} turn${v.turns === 1 ? '' : 's'}`)
  if (v.toolCalls !== undefined) stats.push(`${v.toolCalls} tool call${v.toolCalls === 1 ? '' : 's'}`)
  if (stats.length > 0) out.push([stats.join(sep)])
  if (v.activity || v.waiting > 0) {
    const act = v.activity || 'Waiting for you'
    out.push([`now      ${act}`, v.waiting > 0 ? `${g.arrow} d: decide${v.waiting > 1 ? ` (${v.waiting} cards)` : ''}` : ''])
  }
  if (v.worktree) {
    const w = v.worktree
    out.push([`worktree ${w.branch}  ${w.status}  ${w.files} file${w.files === 1 ? '' : 's'} ${g.arrow} ${w.mergeTarget}`, `${g.arrow} w: diff`])
  }
  if (v.msgOut.length > 0 || v.msgIn.length > 0) {
    const parts: string[] = []
    if (v.msgOut.length > 0) parts.push(`sent ${total(v.msgOut)} (to ${peerNames(v.msgOut)})`)
    if (v.msgIn.length > 0) parts.push(`got ${total(v.msgIn)} (from ${peerNames(v.msgIn)})`)
    out.push([`messages ${parts.join(sep)}`])
  }
  return out
}

export function InspectorPane(props: InspectorPaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const v = props.view
  const g = glyphs(env)

  const header: Seg[] = [
    { text: v.label, bold: true },
    ...(v.role && v.role !== v.label ? [{ text: ` (${v.role})`, dim: true } as Seg] : []),
    { text: '  ' },
    ...(env.screenReader ? [] : [{ text: `${stateGlyph(v.state, env)} `, tone: stateTone(v.state) } as Seg]),
    { text: v.stateWord, tone: stateTone(v.state) }
  ]

  const facts = inspectorFacts(v, env)
  const hintLine = props.focused ? paneHint('inspector', v.waiting > 0 ? 'waiting' : v.worktree ? 'agent' : 'bare', 5, width) : ''
  // Fixed lines: header, facts, rule and the hint; the transcript keeps at least three rows or the facts give way.
  let shownFacts = facts.length
  const fixed = (n: number): number => 1 + n + 1 + (hintLine ? 1 : 0)
  while (shownFacts > 0 && height - fixed(shownFacts) < 3) shownFacts--
  const transcriptH = Math.max(0, height - fixed(shownFacts))

  const lines: PaneLine[] = [{ key: 'head', segs: cutSegs(header, width, env) }]
  facts.slice(0, shownFacts).forEach(([left, right], i) => {
    lines.push({ key: `fact${i}`, segs: alignSegs([{ text: left }], right ? { text: right, tone: 'accent' } : undefined, width, env) })
  })
  const label = props.showThinking ? ' transcript (this agent) ' : ' transcript (this agent, thinking hidden: t) '
  const rule = `${g.h}${g.h}${label}`
  lines.push({ key: 'rule', segs: cutSegs([{ text: rule + g.h.repeat(Math.max(0, width - rule.length)), dim: true }], width, env) })

  const empty = props.rows.length === 0 && props.partials.length === 0
  const rows: TranscriptRow[] = empty ? [{ key: 'inspector-empty', runId: v.runId, kind: 'system', text: 'Nothing from this agent yet.', tone: 'dim' }] : props.rows

  const extraKeys = (e: InputEvent): boolean => {
    if (e.type !== 'key' || e.name !== 'char' || e.ctrl || e.alt) return false
    switch (e.ch) {
      case 'd':
        if (v.waiting > 0) props.onDecide?.()
        else props.onNotice?.('This agent has no decision open.')
        return true
      case 'w':
        if (v.worktree) props.onDiff?.()
        else props.onNotice?.('This agent has no worktree.')
        return true
      case 't':
        props.onToggleThinking?.()
        return true
      case 'u':
        props.onUsage?.()
        return true
      default:
        return false
    }
  }

  const hintSegs: PaneLine[] = hintLine ? [{ key: 'hint', segs: cutSegs([{ text: hintLine, dim: true }], width, env) }] : []
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <PaneLines width={width} height={Math.min(height, lines.length)} lines={lines} env={env} />
      {
        <TranscriptPane mode="fullscreen" width={width} height={transcriptH} focused={props.focused} focusTarget="inspector" extraKeys={extraKeys} rows={rows} partials={props.partials} omitted={props.omitted ?? 0} />
      }
      {hintSegs.length > 0 && height > lines.length + transcriptH ? <PaneLines width={width} height={1} lines={hintSegs} env={env} /> : null}
    </Box>
  )
}
