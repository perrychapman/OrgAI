import type { ReactElement } from 'react'
import { memo, useEffect, useState } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { AgentInstance } from '@shared/types'
import { formatCost, formatElapsed, formatTokens, initials } from '../lib/layout'
import { activeRun, useAppStore } from '../store/useAppStore'

export type AgentFlowNode = Node<{ agent: AgentInstance; color: string; isRoot: boolean }, 'agent'>

const WORKING = new Set(['starting', 'thinking', 'tool', 'delegating'])

const WORKTREE_LABEL: Record<NonNullable<AgentInstance['worktree']>['status'], string> = {
  active: 'isolated worktree',
  merging: 'merging…',
  merged: 'merged',
  empty: 'no changes',
  conflict: 'merge conflict',
  removed: 'worktree removed'
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
  const activity = streaming ? partial.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Writing…' : agent.activity

  return (
    <div className={`agent-node state-${agent.state} ${selected ? 'selected' : ''}`} style={{ ['--role' as string]: color }}>
      {!isRoot && <Handle type="target" position={Position.Top} />}
      <div className="head">
        <div className="avatar-wrap">
          <div className="avatar">{initials(agent.name)}</div>
          <div className="ring" />
          {agent.state === 'done' && <div className="badge">✓</div>}
          {agent.state === 'error' && <div className="badge">!</div>}
        </div>
        <div className="title">
          <div className="name" title={agent.name}>
            {agent.name}
          </div>
          <div className="sub">
            <span>{agent.roleSlug}</span>
            {shortModel && <span>· {shortModel}</span>}
          </div>
        </div>
      </div>
      <div className={`activity ${streaming || WORKING.has(agent.state) ? 'working' : ''}`} title={activity}>
        {activity}
      </div>
      {agent.worktree && (
        <div className={`worktree wt-${agent.worktree.status}`} title={`${agent.worktree.branch} · ${agent.worktree.path}`}>
          {WORKTREE_LABEL[agent.worktree.status]}
          {agent.worktree.changedFiles?.length ? ` · ${agent.worktree.changedFiles.length} file${agent.worktree.changedFiles.length === 1 ? '' : 's'}` : ''}
        </div>
      )}
      <div className="foot">
        <span>{formatTokens(agent.inputTokens + agent.outputTokens)} tok</span>
        <span>{agent.costUsd > 0 ? formatCost(agent.costUsd) : formatElapsed(agent.startedAt, agent.endedAt)}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const AgentNode = memo(AgentNodeView)
