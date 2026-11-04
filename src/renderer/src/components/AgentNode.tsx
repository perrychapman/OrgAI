import type { CSSProperties, ReactElement } from 'react'
import { memo, useEffect, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { Handle, type Position, type Node, type NodeProps } from '@xyflow/react'
import { SIDES, msgHandleId } from '../lib/canvasShapes'
import { agentLabel, splitLabelTail } from '../lib/agentTree'
import { handlesFor, stationGeometry, stationHandleStyle, useCanvasOptions, useHandleRefresh } from '../lib/canvas'
import type { AgentInstance } from '@shared/types'
import { formatElapsed, formatTokens, initials } from '../lib/layout'
import { agentProducedNothing } from '@shared/defaults'
import { agentCostInput, costView } from '../lib/cost'
import { Cost } from './ui/Cost'
import { Icon } from './ui/Icon'
import { activeRun, useAppStore } from '../store/useAppStore'

export type AgentFlowNode = Node<{ agent: AgentInstance; color: string; isRoot: boolean }, 'agent'>

const WORKING = new Set(['starting', 'thinking', 'tool', 'delegating'])

/** A label that clips in the middle: the head takes the ellipsis, the last characters stay (see splitLabelTail). */
function ClippedLabel({ label }: { label: string }): ReactElement {
  const { head, tail } = splitLabelTail(label)
  if (!tail) return <>{label}</>
  return (
    <span className="clip-label">
      <span className="clip-head">{head}</span>
      <span className="clip-tail">{tail}</span>
    </span>
  )
}

/**
 * Hidden message handles on all four sides (ids `msg-out-top` ... `msg-in-left`, see msgHandleId): LiveRunView picks the
 * side of each end that faces the other node (messageSides), so a message never runs behind the bodies it joins.
 */
export function MessageHandles({ hs }: { hs: (side: string) => { style?: CSSProperties } }): ReactElement {
  return (
    <>
      {SIDES.map((side) => (
        <Handle key={`out-${side}`} id={msgHandleId('out', side)} type="source" position={side as Position} className="msg-handle" isConnectable={false} {...hs(side)} />
      ))}
      {SIDES.map((side) => (
        <Handle key={`in-${side}`} id={msgHandleId('in', side)} type="target" position={side as Position} className="msg-handle" isConnectable={false} {...hs(side)} />
      ))}
    </>
  )
}

const WORKTREE_LABEL: Record<NonNullable<AgentInstance['worktree']>['status'], string> = {
  active: 'isolated worktree',
  merging: 'merging…',
  merged: 'merged',
  empty: 'no changes',
  conflict: 'merge conflict',
  removed: 'worktree removed',
  review: 'awaiting your review',
  held: 'held for later',
  'waiting-children': 'waiting for its reports'
}

/** Nested reports merge into their parent's branch, not the main checkout. */
function worktreeLabel(wt: NonNullable<AgentInstance['worktree']>): string {
  if (wt.mergeTarget === 'parent' && wt.status === 'merged') return 'merged into parent'
  return WORKTREE_LABEL[wt.status]
}

function AgentNodeView({ id, data, selected }: NodeProps<AgentFlowNode>): ReactElement {
  const { agent, color, isRoot } = data
  const [, tick] = useState(0)
  const live = !agent.endedAt

  useEffect(() => {
    if (!live) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [live])

  const shortModel = agent.model ? agent.model.replace(/^claude-/, '').replace(/-\d{8}$/, '') : ''
  // While the agent streams text, its first words stand in for the activity line.
  const partial = useAppStore((s) => activeRun(s)?.partial[agent.id])
  const streaming = partial !== undefined
  const costInput = agentCostInput(agent)
  const hasCost = !costView(costInput).empty
  // Ended without result text: its tokens bought nothing. A quiet dim and a tooltip, no badge.
  // The root is the orchestrator: it speaks the answer, so it is never flagged.
  const noResult = !isRoot && agent.id !== 'root' && (!!agent.usage?.producedNothing || agentProducedNothing(agent))
  // An idle run is not a pending decision: the root waits for a reply, "Waiting for you" is for a card.
  const idleActivity = isRoot && agent.state === 'idle' && agent.activity === 'Waiting for you' ? 'Waiting for your reply' : agent.activity
  const activity = streaming ? partial.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Writing…' : noResult ? 'Ended without a result' : idleActivity

  const { layout, nodeStyle } = useCanvasOptions()
  useHandleRefresh(id, layout, nodeStyle)
  const sides = handlesFor(layout)
  const station = nodeStyle === 'station'
  const hex = nodeStyle === 'hex'
  // Every style but the card moves its details into the tooltip and the sr-only line.
  const compact = nodeStyle !== 'card'
  const geo = stationGeometry(layout)
  // Station handles sit on the circle's edge (flow.css centres them on the inline left / top).
  const hs = (side: string): { style?: CSSProperties } => (station ? { style: stationHandleStyle(geo, side as `${Position}`) } : {})
  const badges = (
    <>
      {agent.state === 'done' && <div className="badge">
          <Icon icon={Check} size="xs" label="Finished" />
        </div>}
      {agent.state === 'error' && <div className="badge">
          <Icon icon={TriangleAlert} size="xs" label="Failed" />
        </div>}
    </>
  )
  const tokensText = `${formatTokens(agent.inputTokens + agent.outputTokens)} tok`
  const tail = hasCost ? costView(costInput).text : formatElapsed(agent.startedAt, agent.endedAt)
  const worktreeText = agent.worktree
    ? worktreeLabel(agent.worktree) + (agent.worktree.changedFiles?.length ? ` · ${agent.worktree.changedFiles.length} file${agent.worktree.changedFiles.length === 1 ? '' : 's'}` : '')
    : ''
  // Name tags, stations and hexes show the agent's label (its handle, as the card names it; else the role name) so
  // three "Implementer" agents read apart. The tooltip leads with it, then the role name as a caption.
  const label = agentLabel(agent)
  const compactTip = [
    label,
    label === agent.name ? '' : agent.name,
    [agent.handle ? '' : agent.roleSlug, shortModel].filter(Boolean).join(' · '),
    activity,
    worktreeText,
    `${tokensText} · ${tail}`
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div
      className={`agent-node state-${agent.state} ${selected ? 'selected' : ''} ${noResult ? 'no-result' : ''} ${isRoot ? 'is-root' : ''}`}
      data-style={nodeStyle}
      data-label={station ? geo.label : undefined}
      style={{ ['--role' as string]: color, ...(station ? { width: geo.width, height: geo.height } : {}) }}
      title={compact ? compactTip : noResult ? 'Ended without a result: its tokens produced nothing' : undefined}
    >
      {!isRoot && <Handle type="target" position={sides.target as Position} {...hs(sides.target)} />}
      {station && (
        <>
          <div className="station" style={{ left: geo.cx - geo.r, top: geo.cy - geo.r }}>
            <div className="ring" />
            {badges}
          </div>
          <div className="station-name">
            <ClippedLabel label={label} />
          </div>
          <span className="sr-only">{[activity, worktreeText].filter(Boolean).join(', ')}</span>
        </>
      )}
      {hex && (
        <>
          <div className="hex-tile" aria-hidden="true">
            <div className="hex-fill" />
          </div>
          <div className="hex-content">
            <div className="avatar-wrap">
              <div className="avatar" aria-hidden="true">{initials(agent.name)}</div>
              <div className="ring" />
              {badges}
            </div>
            <div className="hex-name">{label}</div>
            <span className="sr-only">{[activity, worktreeText].filter(Boolean).join(', ')}</span>
          </div>
        </>
      )}
      {!station && !hex && <div className="head">
        <div className="avatar-wrap">
          <div className="avatar" aria-hidden={compact ? 'true' : undefined}>{initials(agent.name)}</div>
          <div className="ring" />
          {badges}
        </div>
        <div className="title">
          <div className="name" title={compact ? undefined : agent.name}>
            {compact ? <ClippedLabel label={label} /> : agent.name}
          </div>
          {/* The tooltip is not read by keyboard or screen-reader users: say what the card would show. */}
          {compact && <span className="sr-only">{[activity, worktreeText].filter(Boolean).join(', ')}</span>}
          {!compact && (
            <div className="sub">
              <span title={agent.handle ? `Handle ${agent.handle} (role ${agent.roleSlug})` : undefined}>{agent.handle ?? agent.roleSlug}</span>
              {shortModel && <span>· {shortModel}</span>}
            </div>
          )}
        </div>
      </div>}
      {!compact && (
        <>
          <div className={`activity ${streaming || WORKING.has(agent.state) ? 'working' : ''}`} title={activity}>
            {activity}
          </div>
          {agent.worktree && (
            <div className={`worktree wt-${agent.worktree.status}`} title={`${agent.worktree.branch} · ${agent.worktree.path}`}>
              {worktreeText}
            </div>
          )}
          <div className="foot">
            <span>{tokensText}</span>
            {hasCost ? <Cost value={costInput} labelled /> : <span>{formatElapsed(agent.startedAt, agent.endedAt)}</span>}
          </div>
        </>
      )}
      <Handle type="source" position={sides.source as Position} {...hs(sides.source)} />
      {/* Agent-to-agent messages attach on the side facing the other node, after the reporting-line handles so those stay the defaults. */}
      <MessageHandles hs={hs} />
    </div>
  )
}

export const AgentNode = memo(AgentNodeView)
