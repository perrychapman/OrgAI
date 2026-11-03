import type { ReactElement } from 'react'
import type { AgentInstance } from '@shared/types'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { formatElapsed, initials } from '../lib/layout'
import { Cost } from './ui/Cost'
import { agentCostInput } from '../lib/cost'
import { agentLabel } from '../lib/agentTree'

export interface FinishedGroup {
  /** The group's parent as the fold names it (`agentLabel`), or "an earlier session". */
  parentName: string
  /** Every folded agent in the subtree, direct reports first. */
  agents: AgentInstance[]
  /** The label (`agentLabel`) of the agent a member ran under, when it is not a direct report of the group's parent. */
  underOf?: (a: AgentInstance) => string | undefined
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

/**
 * Side-panel list of every finished agent a collapsed group stands for (its whole subtree), newest first. A member
 * that is not a direct report says which agent it ran under. Click one to read its transcript.
 */
export default function FinishedList({ group }: { group: FinishedGroup }): ReactElement {
  const sorted = [...group.agents].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const under = new Map(group.agents.map((a) => [a.id, group.underOf?.(a)]))
  return (
    <div className="finished-list">
      <div className="finished-head">
        <span>
          {group.agents.length} finished agent{group.agents.length === 1 ? '' : 's'} under {group.parentName}
        </span>
        <Button variant="ghost" size="sm" onClick={group.onExpand}>
          Show on chart
        </Button>
      </div>
      {sorted.map((a) => {
        const label = agentLabel(a)
        return (
          <button type="button" key={a.id} className="finished-row" onClick={() => group.onPick(a.id)}>
            <span className="avatar" style={{ ['--role' as string]: a.worktree?.status === 'conflict' ? 'var(--danger)' : 'var(--border-strong)' }}>
              {initials(a.name)}
            </span>
            <span className="finished-body">
              <span className="finished-title">
                <strong>{label}</strong>
                {label !== a.name && <span className="finished-role">{a.name}</span>}
                <Badge tone={a.state === 'error' ? 'danger' : 'neutral'}>{a.state === 'error' ? 'failed' : 'done'}</Badge>
                {a.worktree && <Badge>{WT_LABEL[a.worktree.status] ?? a.worktree.status}</Badge>}
              </span>
              {under.get(a.id) && <span className="finished-under">under {under.get(a.id)}</span>}
              <span className="finished-sub">{(a.result ?? a.lastText ?? a.activity).replace(/\s+/g, ' ').slice(0, 140)}</span>
            </span>
            <span className="finished-meta">
              <Cost value={agentCostInput(a)} hideEmpty />
              <br />
              {formatElapsed(a.startedAt, a.endedAt)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
