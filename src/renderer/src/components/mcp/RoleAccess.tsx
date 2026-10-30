import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Role } from '@shared/types'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'

/** Checkbox list of roles with an All roles toggle on top. `value` is a slug list (undefined = every role). */
export function RoleChecklist({
  roles,
  value,
  onChange,
  disabled,
  label
}: {
  roles: Role[]
  value: string[] | undefined
  onChange: (next: string[]) => void
  disabled?: boolean
  label: string
}): ReactElement {
  const selected = value === undefined ? roles.map((r) => r.slug) : value
  const all = roles.length > 0 && roles.every((r) => selected.includes(r.slug))
  if (roles.length === 0) return <p className="muted">This project has no roles yet.</p>
  return (
    <div className="mcp-roles" role="group" aria-label={label}>
      <Checkbox label="All roles" checked={all} disabled={disabled} onChange={() => onChange(all ? [] : roles.map((r) => r.slug))} />
      {roles.map((r) => (
        <Checkbox
          key={r.id}
          label={r.name}
          checked={selected.includes(r.slug)}
          disabled={disabled}
          onChange={() => onChange(selected.includes(r.slug) ? selected.filter((s) => s !== r.slug) : [...selected, r.slug])}
        />
      ))}
    </div>
  )
}

/** "Roles: n of m" button that discloses the checklist in flow. Esc closes and returns focus to the button. */
export function RoleAccess({
  serverName,
  roles,
  value,
  onChange,
  disabled
}: {
  serverName: string
  roles: Role[]
  value: string[] | undefined
  onChange: (next: string[]) => void
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useId()
  const n = value === undefined ? roles.length : roles.filter((r) => value.includes(r.slug)).length
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
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Roles: {n} of {roles.length}
        <Icon icon={ChevronDown} size="xs" />
      </button>
      {open && (
        <div id={panel} className="mcp-role-panel">
          <RoleChecklist roles={roles} value={value} onChange={onChange} label={`Role access for ${serverName}`} />
        </div>
      )}
    </div>
  )
}
