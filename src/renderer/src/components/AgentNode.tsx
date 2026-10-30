import type { ReactElement } from 'react'
import { memo, useEffect, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { AgentInstance } from '@shared/types'
import { costLabel, formatElapsed, formatTokens, initials } from '../lib/layout'
import { Icon } from './ui/Icon'
import { activeRun, useAppStore } from '../store/useAppStore'

export type AgentFlowNode = Node<{ agent: AgentInstance; color: string; isRoot: boolean }, 'agent'>

const WORKING = new Set(['starting', 'thinking', 'tool', 'delegating'])

/** Handle ids message edges use (see LiveRunView). */
export const MSG_OUT = 'msg-out'
export const MSG_IN = 'msg-in'

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

function AgentNodeView({ data, selected }: NodeProps<AgentFlowNode>): ReactElement {
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
  const authMode = useAppStore((s) => s.usage?.authMode ?? 'unknown')
  const cost = costLabel(agent.costUsd, authMode)
  const activity = streaming ? partial.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Writing…' : agent.activity

  return (
    <div className={`agent-node state-${agent.state} ${selected ? 'selected' : ''}`} style={{ ['--role' as string]: color }}>
      {!isRoot && <Handle type="target" position={Position.Top} />}
      <div className="head">
        <div className="avatar-wrap">
          <div className="avatar">{initials(agent.name)}</div>
          <div className="ring" />
          {agent.state === 'done' && <div className="badge">
              <Icon icon={Check} size="xs" label="Finished" />
            </div>}
          {agent.state === 'error' && <div className="badge">
              <Icon icon={TriangleAlert} size="xs" label="Failed" />
            </div>}
        </div>
        <div className="title">
          <div className="name" title={agent.name}>
            {agent.name}
          </div>
          <div className="sub">
            <span title={agent.handle ? `Handle ${agent.handle} (role ${agent.roleSlug})` : undefined}>{agent.handle ?? agent.roleSlug}</span>
            {shortModel && <span>· {shortModel}</span>}
          </div>
        </div>
      </div>
      <div className={`activity ${streaming || WORKING.has(agent.state) ? 'working' : ''}`} title={activity}>
        {activity}
      </div>
      {agent.worktree && (
        <div className={`worktree wt-${agent.worktree.status}`} title={`${agent.worktree.branch} · ${agent.worktree.path}`}>
          {worktreeLabel(agent.worktree)}
          {agent.worktree.changedFiles?.length ? ` · ${agent.worktree.changedFiles.length} file${agent.worktree.changedFiles.length === 1 ? '' : 's'}` : ''}
        </div>
      )}
      <div className="foot">
        <span>{formatTokens(agent.inputTokens + agent.outputTokens)} tok</span>
        <span title={agent.costUsd > 0 ? cost.title : undefined}>{agent.costUsd > 0 ? cost.text : formatElapsed(agent.startedAt, agent.endedAt)}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
      {/* Agent-to-agent messages attach at the sides, after the reporting-line handles so those stay the defaults. */}
      <Handle id={MSG_OUT} type="source" position={Position.Right} className="msg-handle" isConnectable={false} />
      <Handle id={MSG_IN} type="target" position={Position.Left} className="msg-handle" isConnectable={false} />
    </div>
  )
}

export const AgentNode = memo(AgentNodeView)
