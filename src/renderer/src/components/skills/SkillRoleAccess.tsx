import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Role } from '@shared/types'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { grantSummary } from '../../lib/skills'

/** Checkbox list of roles (by Role.id, the key of Role.skills grants) with an All roles toggle on top. */
export function SkillRoleChecklist({
  roles,
  value,
  onChange,
  disabled,
  label
}: {
  roles: Role[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  label: string
}): ReactElement {
  if (roles.length === 0) return <p className="muted">This project has no roles yet.</p>
  const all = roles.every((r) => value.includes(r.id))
  return (
    <div className="mcp-roles" role="group" aria-label={label}>
      <Checkbox label="All roles" checked={all} disabled={disabled} onChange={() => onChange(all ? [] : roles.map((r) => r.id))} />
      {roles.map((r) => (
        <Checkbox
          key={r.id}
          label={r.name}
          checked={value.includes(r.id)}
          disabled={disabled}
          onChange={() => onChange(value.includes(r.id) ? value.filter((s) => s !== r.id) : [...value, r.id])}
        />
      ))}
    </div>
  )
}

/** "Roles: Writer, QA" button that discloses the checklist in flow. Esc closes and returns focus to the button. */
export function SkillRoleAccess({
  skillName,
  roles,
  grantedTo,
  onChange,
  disabled
}: {
  skillName: string
  roles: Role[]
  grantedTo: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useId()
  const summary = grantSummary({ grantedTo }, roles)
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        btn.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className="mcp-role-access">
      <button
        ref={btn}
        type="button"
        className="mcp-link"
        data-testid="skill-roles"
        title={summary}
        aria-label={`${summary}. ${open ? 'Hide' : 'Change'} role access for ${skillName}`}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mcp-link-text">{summary}</span>
        <Icon icon={ChevronDown} size="xs" />
      </button>
      {open && (
        <div id={panel} className="mcp-role-panel">
          <SkillRoleChecklist roles={roles} value={grantedTo} onChange={onChange} label={`Role access for ${skillName}`} />
        </div>
      )}
    </div>
  )
}
