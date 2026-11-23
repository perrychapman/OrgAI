import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentInstance } from '@shared/types'
import { nodeActivity } from '../../lib/agentActivity'
import { agentLabel } from '../../lib/agentTree'
import {
  agentBucket,
  groupLabels,
  matchesAgentFilter,
  matchesAgentQuery,
  sortAgents,
  type AgentBucket,
  type AgentFilterValue,
  type AgentSortMode
} from '../../lib/canvasAgents'
import { agentCostInput } from '../../lib/cost'
import { BREATHE_MAX_NODES } from '../../lib/canvas'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { Cost } from '../ui/Cost'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import '../../styles/canvas-chrome.css'

const SORT_OPTIONS: { value: AgentSortMode; label: string }[] = [
  { value: 'needs', label: 'Needs you first' },
  { value: 'name', label: 'Name' },
  { value: 'group', label: 'Group' }
]

/** The words a screen reader gets in front of the row (colour is never the only cue). */
const BUCKET_WORD: Record<AgentBucket, string> = { waiting: 'Waiting for you', working: 'Working', failed: 'Failed', other: 'Idle', done: 'Done' }

interface RowProps {
  agent: AgentInstance
  bucket: AgentBucket
  group: string | undefined
  selected: boolean
  /** Position among the working rows when it may breathe (the first BREATHE_MAX_NODES), else undefined. */
  breathe: number | undefined
  onSelect: (id: string) => void
}

const AgentRow = memo(function AgentRow({ agent, bucket, group, selected, breathe, onSelect }: RowProps): ReactElement {
  const doing = nodeActivity(agent, { isRoot: agent.parentId === null })
  return (
    <button
      type="button"
      className="agent-row"
      data-testid="agent-list-row"
      data-agent-row=""
      data-agent-id={agent.id}
      data-bucket={bucket}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(agent.id)}
    >
      <span className="agent-row-dot" aria-hidden="true" data-breathe={breathe !== undefined ? '' : undefined} style={breathe !== undefined ? ({ '--i': breathe } as CSSProperties) : undefined} />
      <span className="agent-row-text">
        <span className="agent-row-name">
          <span className="sr-only">{BUCKET_WORD[bucket]}. </span>
          {agentLabel(agent)}
          {group && group !== agentLabel(agent) && <span className="agent-row-group"> · {group}</span>}
        </span>
        <span className="agent-row-doing">{doing}</span>
      </span>
      <Cost value={agentCostInput(agent)} hideEmpty className="agent-row-cost" />
    </button>
  )
})

/**
 * The flat agent list for runs with many agents (Scale board): a search field, a sort, and one native button per agent
 * with its state dot, "name · group", what it is doing and its cost. Every row is rendered (the rows skip layout and
 * paint while off screen, `content-visibility: auto`), so 121 agents stay cheap. One Tab stop for the rows, arrow keys
 * move between them (ArrowDown from the search field enters the list), Enter or Space selects. The selected row is
 * `aria-current`.
 *
 * `groupOf` names an agent's group; by default it is the lead the agent sits under (lib/canvasAgents.ts groupLabels).
 * `filter` narrows to a bucket (the toolbar's "Show" group); it defaults to all.
 */
export function AgentList({
  agents,
  waitingIds,
  selectedId,
  onSelect,
  groupOf,
  autoFocusSearch,
  focusSearchKey,
  filter = 'all'
}: {
  agents: readonly AgentInstance[]
  waitingIds: ReadonlySet<string>
  selectedId: string | null
  onSelect: (id: string) => void
  groupOf?: (agent: AgentInstance) => string | undefined
  /** Focus the search field when the list mounts. */
  autoFocusSearch?: boolean
  /** Focus the search field now and again each time this number changes (a "Find an agent" request); undefined = no request. */
  focusSearchKey?: number
  filter?: AgentFilterValue
}): ReactElement {
  const searchId = useId()
  const searchWrap = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<AgentSortMode>('needs')
  const roving = useRovingFocus(list, '[data-agent-row]')

  useEffect(() => {
    if (autoFocusSearch || focusSearchKey !== undefined) searchWrap.current?.querySelector('input')?.focus()
  }, [autoFocusSearch, focusSearchKey])

  const groups = useMemo(() => (groupOf ? null : groupLabels(agents)), [agents, groupOf])
  const groupName = (a: AgentInstance): string | undefined => (groupOf ? groupOf(a) : groups?.get(a.id))

  const rows = useMemo(() => {
    const shown = agents.filter((a) => matchesAgentFilter(a, filter, waitingIds) && matchesAgentQuery(a, query, [groupName(a) ?? '']))
    return sortAgents(shown, waitingIds, sort, groupName)
    // groupName closes over groupOf and groups, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, filter, query, sort, waitingIds, groupOf, groups])

  let breathing = 0
  const items = rows.map((a) => {
    const bucket = agentBucket(a, waitingIds)
    const breathe = bucket === 'working' && breathing < BREATHE_MAX_NODES ? breathing++ : undefined
    return <AgentRow key={a.id} agent={a} bucket={bucket} group={groupName(a)} selected={a.id === selectedId} breathe={breathe} onSelect={onSelect} />
  })

  const onSearchKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      roving.focusCurrent()
    } else if (e.key === 'Escape' && query) {
      // Clears the filter first; a second Escape reaches whatever owns the panel.
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  return (
    <div className="agent-list" data-testid="agent-list">
      <div className="agent-list-tools">
        <label className="sr-only" htmlFor={searchId}>
          Filter by name, group or file
        </label>
        <div className="agent-list-search" ref={searchWrap} onKeyDown={onSearchKey}>
          <Input id={searchId} type="search" value={query} onChange={setQuery} placeholder="Filter by name, group or file" autoComplete="off" spellCheck={false} data-testid="agent-list-search" />
        </div>
        <Select value={sort} options={SORT_OPTIONS} onChange={(v) => setSort(v as AgentSortMode)} label="Sort agents" />
      </div>
      <div className="agent-list-rows" ref={list} onKeyDown={roving.onKeyDown} onFocus={roving.onFocus} role="group" aria-label="Agents">
        {items}
        {rows.length === 0 && <p className="agent-list-empty">{agents.length === 0 ? 'No agents yet.' : query.trim() ? `No agent matches "${query.trim()}".` : 'No agents in this view.'}</p>}
      </div>
      <div className="agent-list-count" role="status">
        Showing {rows.length} of {agents.length}
      </div>
    </div>
  )
}
