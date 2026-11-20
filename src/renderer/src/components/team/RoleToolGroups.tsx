import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { ToolName } from '@shared/types'
import { TOOL_CATALOG, TOOL_HINTS } from '@shared/types'
import { Badge } from '../ui/Badge'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { groupState, resolveGroups, toggleGroup, type ToolGroup } from '../../lib/toolGroups'

function GroupRow({ group, tools, onChange }: { group: ToolGroup; tools: readonly string[]; onChange: (next: string[]) => void }): ReactElement {
  const ref = useRef<HTMLInputElement>(null)
  const state = groupState(group, tools)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed'
  }, [state])
  return (
    <li className="role-tool-group-row" data-state={state}>
      <label className="checkbox">
        <input
          ref={ref}
          type="checkbox"
          checked={state === 'on'}
          data-testid={`role-tool-group-${group.id}`}
          onChange={() => onChange(toggleGroup(group, tools))}
        />
        <span className="checkbox-box" aria-hidden="true">
          <Icon icon={Check} size="sm" />
        </span>
        <span className="checkbox-text">
          <span className="checkbox-label role-tool-group-label">
            {group.label}
            {group.elevated && group.chip && (
              <Badge tone="attention" icon={TriangleAlert}>
                {group.chip}
              </Badge>
            )}
          </span>
          <span className="role-tool-group-desc">
            {group.description}
            <span className="role-tool-group-names mono"> {group.members.join(', ')}</span>
          </span>
        </span>
      </label>
    </li>
  )
}

/**
 * The open tools editor: one checkbox per plain-language group (mixed when only some of its tools are on) and, under
 * them, a closed disclosure with the per-tool grid for exact control.
 */
export default function RoleToolGroups({ tools, onChange }: { tools: readonly string[]; onChange: (tools: string[]) => void }): ReactElement {
  const groups = resolveGroups(TOOL_CATALOG, tools)
  const toggleTool = (t: ToolName): void => onChange(tools.includes(t) ? tools.filter((x) => x !== t) : [...tools, t])
  return (
    <div className="role-tool-groups stack-2" data-testid="role-tools-grid">
      <ul className="role-tool-group-list" aria-label="Tool groups">
        {groups.filter((g) => g.members.length > 0).map((g) => (
          <GroupRow key={g.id} group={g} tools={tools} onChange={onChange} />
        ))}
      </ul>
      <details className="role-tool-individual" data-testid="role-tools-individual">
        <summary>Choose individual tools</summary>
        <div className="check-grid">
          {TOOL_CATALOG.map((t) => (
            <Checkbox
              key={t}
              checked={tools.includes(t)}
              onChange={() => toggleTool(t)}
              label={t}
              title={TOOL_HINTS[t]}
              testId={`role-tool-${t}`}
            />
          ))}
        </div>
      </details>
    </div>
  )
}
