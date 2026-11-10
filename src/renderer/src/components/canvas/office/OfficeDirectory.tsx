import type { ReactElement } from 'react'
import type { OfficeAgent } from './officeArt'

/** The optional "Find a person" list: every loaded agent, including earlier sessions. A pick selects and pans to the person. */
export interface OfficeDirectoryProps {
  agents: readonly OfficeAgent[]
  /** Room label per agent id (`data-office-room`). */
  rooms: ReadonlyMap<string, string>
  selectedId?: string
  onPick(agent: OfficeAgent): void
  onRemove?(id: string): void
}

export function OfficeDirectory({ agents, rooms, selectedId, onPick, onRemove }: OfficeDirectoryProps): ReactElement {
  return <details className="office-directory">
    <summary>Find a person · {agents.length}</summary>
    <div className="office-roster" aria-label="All people, including earlier sessions" role="region">
      {agents.map(agent => <button
        type="button" key={agent.id} data-office-agent-id={agent.id} data-office-agent-context={agent.context} data-office-room={rooms.get(agent.id)}
        aria-pressed={agent.id === selectedId} onClick={() => onPick(agent)}
        onKeyDown={event => { if (event.key === 'Delete' && onRemove) { event.preventDefault(); onRemove(agent.id) } }}
      >
        <span>{agent.name}</span> <span>{agent.statusLabel ?? agent.status}</span>
        {agent.context && <span> · {agent.context}</span>}{agent.activity && <span> · {agent.activity}</span>}
      </button>)}
    </div>
  </details>
}
