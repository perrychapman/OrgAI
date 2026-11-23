import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Search } from 'lucide-react'
import { Icon } from '../../ui/Icon'
import type { OfficeAgent } from './officeArt'

/**
 * "Find a person" (Office board): a native disclosure in the scene toolbar whose list drops over the stage. Every loaded
 * agent, including earlier sessions; under a Show filter only the people inside it. A pick selects and pans to the
 * person and leaves the list open; Escape closes it and returns focus to the button.
 */
export interface OfficeDirectoryProps {
  agents: readonly OfficeAgent[]
  /** Room label per agent id (`data-office-room`). */
  rooms: ReadonlyMap<string, string>
  selectedId?: string
  onPick(agent: OfficeAgent): void
  onRemove?(id: string): void
  /** How many people the Show filter leaves out of the list (0 under All). */
  filteredOut?: number
}

export function OfficeDirectory({ agents, rooms, selectedId, onPick, onRemove, filteredOut = 0 }: OfficeDirectoryProps): ReactElement {
  const details = useRef<HTMLDetailsElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>): void => {
    if (event.key !== 'Escape' || !details.current?.open) return
    event.preventDefault()
    event.stopPropagation()
    details.current.open = false
    details.current.querySelector('summary')?.focus()
  }
  return <details className="office-directory" ref={details} onKeyDown={onKeyDown}>
    <summary className="office-chip"><Icon icon={Search} size="sm" /><span className="office-chip-label">Find a person</span> <span className="office-chip-count">{agents.length}</span></summary>
    <div className="office-roster glass-strong" aria-label="All people, including earlier sessions" role="region">
      {filteredOut > 0 && (agents.length
        ? <p className="office-roster-note">{filteredOut} more not shown: Show is not set to All.</p>
        : <p className="office-roster-note">Nobody matches the Show filter.</p>)}
      {!agents.length && !filteredOut && <p className="office-roster-note">Nobody is here yet.</p>}
      {agents.map(agent => <button
        type="button" key={agent.id} data-office-agent-id={agent.id} data-office-agent-context={agent.context} data-office-room={rooms.get(agent.id)}
        aria-pressed={agent.id === selectedId} onClick={() => onPick(agent)}
        onKeyDown={event => { if (event.key === 'Delete' && onRemove) { event.preventDefault(); onRemove(agent.id) } }}
      >
        <span className="office-roster-name">{agent.name}</span> <span className="office-roster-meta"><span>{agent.statusLabel ?? agent.status}</span>
        {agent.context && <span> · {agent.context}</span>}{agent.activity && <span> · {agent.activity}</span>}</span>
      </button>)}
    </div>
  </details>
}
