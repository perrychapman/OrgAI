import type { ReactElement } from 'react'
import type { AgentInstance } from '@shared/types'
import { Button } from './ui/Button'
import { formatCost, formatElapsed, initials } from '../lib/layout'

export interface FinishedGroup {
  parentName: string
  agents: AgentInstance[]
  onPick: (agentId: string) => void
  onExpand: () => void
}

const WT_LABEL: Record<string, string> = {
  merged: 'merged',
  empty: 'no changes',
  conflict: 'merge conflict',
  held: 'held',
  review: 'awaiting review',
  removed: 'removed'
}

/** Side-panel list of the finished reports a collapsed group stands for. Click one to read its transcript. */
export default function FinishedList({ group }: { group: FinishedGroup }): ReactElement {
  const sorted = [...group.agents].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return (
    <div className="finished-list">
      <div className="finished-head">
        <span>
          {group.agents.length} finished report{group.agents.length === 1 ? '' : 's'} under {group.parentName}
        </span>
        <Button variant="ghost" size="sm" onClick={group.onExpand}>
          Show on chart
        </Button>
      </div>
      {sorted.map((a) => (
        <button type="button" key={a.id} className="finished-row" onClick={() => group.onPick(a.id)}>
          <span className="avatar" style={{ ['--role' as string]: a.worktree?.status === 'conflict' ? 'var(--danger)' : 'var(--border-strong)' }}>
            {initials(a.name)}
          </span>
          <span className="finished-body">
            <span className="finished-title">
              <strong>{a.name}</strong>
              <span className={`chip ${a.state === 'error' ? 'danger' : ''}`}>{a.state === 'error' ? 'failed' : 'done'}</span>
              {a.worktree && <span className="chip">{WT_LABEL[a.worktree.status] ?? a.worktree.status}</span>}
            </span>
            <span className="finished-sub">{(a.result ?? a.lastText ?? a.activity).replace(/\s+/g, ' ').slice(0, 140)}</span>
          </span>
          <span className="finished-meta">
            {a.costUsd > 0 ? formatCost(a.costUsd) : ''}
            <br />
            {formatElapsed(a.startedAt, a.endedAt)}
          </span>
        </button>
      ))}
    </div>
  )
}
