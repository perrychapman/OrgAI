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

/** Inline role picker for an add flow: nothing is preselected, and it says what that means. */
export function SkillRolePicker({
  roles,
  value,
  onChange,
  label,
  legend = 'Who can load it?'
}: {
  roles: Role[]
  value: string[]
  onChange: (next: string[]) => void
  label: string
  legend?: string
}): ReactElement {
  return (
    <fieldset className="mcp-vars skill-role-picker" data-testid="skill-role-picker">
      <legend>{legend}</legend>
      <SkillRoleChecklist roles={roles} value={value} onChange={onChange} label={label} />
      {roles.length > 0 && (
        <span className={value.length === 0 ? 'hint skill-role-warn' : 'hint'} data-testid="skill-role-hint">
          {value.length === 0
            ? 'Until you choose roles, no agent loads it.'
            : `${value.length} ${value.length === 1 ? 'role' : 'roles'} will be able to load it.`}
        </span>
      )}
    </fieldset>
  )
}

/** "Roles: Writer, QA" button that discloses the checklist in flow. Esc closes and returns focus to the button. */
export function SkillRoleAccess({
  skillName,
  roles,
  grantedTo,
  onChange,
  disabled,
  open: controlledOpen,
  onOpenChange
}: {
  skillName: string
  roles: Role[]
  grantedTo: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  /** Controlled mode: the row opens this control from its "Choose roles" action. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): ReactElement {
  const [innerOpen, setInnerOpen] = useState(false)
  const open = controlledOpen ?? innerOpen
  const setOpen = (next: boolean): void => {
    setInnerOpen(next)
    onOpenChange?.(next)
  }
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
        onClick={() => setOpen(!open)}
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
