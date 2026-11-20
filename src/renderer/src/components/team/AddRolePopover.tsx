import type { FormEvent, KeyboardEvent, ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Role } from '@shared/types'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { cleanIpcError } from '../../lib/ipcError'
import { nextRoleName, parentOptions } from '../../lib/roleOps'
import { addHelperText, duplicateNameText, nameTaken } from '../../lib/teamNotices'

/** Asks the popover to open with `parentId` as "Reports to" (the node menu's Add a report, the editor's Add a report). `n` makes every request new. */
export interface AddRoleRequest {
  parentId: string
  n: number
}

export interface AddRolePopoverProps {
  roles: Role[]
  /** The selected role: "Reports to" starts on it, else on the root. */
  selectedRoleId: string | null
  /** The last programmatic request, consumed once per open (or applied at once while open). */
  request: AddRoleRequest | null
  /** Adds the role. May throw (shown inside the popover; the popover stays open). */
  onSubmit: (name: string, parentId: string | null) => void | Promise<void>
}

/** Where the form starts: the requested parent, else the selected role, else the root, else nothing (an empty team). */
export function defaultParentId(roles: readonly Role[], selectedRoleId: string | null, requested: string | null): string | null {
  const has = (id: string | null): id is string => !!id && roles.some((r) => r.id === id)
  if (has(requested)) return requested
  if (has(selectedRoleId)) return selectedRoleId
  return roles.find((r) => r.reportsTo === null)?.id ?? roles[0]?.id ?? null
}

/**
 * The header's Add role button and its popover (docs/design/team-tab-overhaul.md 1.2). The trigger is the tab's one
 * primary button (testid `team-add-role`); Enter in the name submits, Escape cancels and the popover returns focus to
 * the trigger. The role is created by `onSubmit`; focus then moves on to the new role's Description (the view does it).
 */
export default function AddRolePopover(props: AddRolePopoverProps): ReactElement {
  // A new key per opening: the form never carries a previous opening's name or error.
  const [opening, setOpening] = useState(0)
  const consumed = useRef(0)
  return (
    <Popover
      label="Add a role"
      role="dialog"
      placement="bottom-end"
      className="add-role-popover"
      testId="add-role-popover"
      triggerTestId="team-add-role"
      triggerClassName="btn primary sm team-header-btn"
      onOpenChange={(open) => {
        if (open) setOpening((n) => n + 1)
      }}
      trigger={
        <>
          <Icon icon={Plus} size="sm" />
          Add role
        </>
      }
    >
      {({ close }) => <AddRoleForm key={opening} {...props} consumed={consumed} close={close} />}
    </Popover>
  )
}

function AddRoleForm({ roles, selectedRoleId, request, onSubmit, consumed, close }: AddRolePopoverProps & { consumed: { current: number }; close: () => void }): ReactElement {
  const uid = useId()
  const nameId = `${uid}-name`
  const parentId = `${uid}-parent`
  const helperId = `${uid}-helper`
  const errorId = `${uid}-error`
  const requestedNow = request && request.n > consumed.current ? request : null
  const [name, setName] = useState(() => nextRoleName(roles))
  const [parent, setParent] = useState<string | null>(() => defaultParentId(roles, selectedRoleId, requestedNow?.parentId ?? null))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const empty = roles.length === 0

  // A request is consumed once; one that arrives while the popover is open moves "Reports to" there.
  useEffect(() => {
    if (!request || request.n <= consumed.current) return
    consumed.current = request.n
    setParent(defaultParentId(roles, selectedRoleId, request.parentId))
  }, [request, roles, selectedRoleId, consumed])

  // The suggested name arrives selected, so typing replaces it. The popover also focuses its first field; this keeps the selection.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const land = (): void => {
      const input = document.getElementById(nameId) as HTMLInputElement | null
      if (!input) return
      input.focus()
      input.select()
      if (document.activeElement !== input && tries++ < 6) frame = requestAnimationFrame(land)
    }
    frame = requestAnimationFrame(land)
    return () => cancelAnimationFrame(frame)
  }, [nameId])

  const options = useMemo(() => parentOptions(roles).map((o) => ({ value: o.id, label: o.label })), [roles])
  const parentRole = roles.find((r) => r.id === parent)
  const trimmed = name.trim()
  const duplicate = nameTaken(roles, trimmed)
  const valid = trimmed !== '' && !duplicate && (empty || !!parentRole)

  const submit = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await onSubmit(trimmed, empty ? null : parent)
      close()
    } catch (err) {
      setFailure(cleanIpcError(err, 'The role could not be added.'))
      setBusy(false)
    }
  }

  // A closed <select> does not submit its form on Enter in Chromium: the keyboard path of "pick a manager, Enter" is here.
  const onSelectKey = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key === 'Enter' && !e.defaultPrevented && (e.target as HTMLElement).tagName === 'SELECT') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <form className="add-role-form" onSubmit={(e) => void submit(e)} onKeyDown={onSelectKey} noValidate>
      <h2 className="add-role-title">Add a role</h2>
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <Input
          id={nameId}
          value={name}
          onChange={(v) => {
            setName(v)
            setFailure(null)
          }}
          invalid={duplicate}
          aria-describedby={duplicate ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          data-testid="add-role-name"
        />
        {duplicate && (
          <p id={errorId} className="field-msg error" role="alert" data-testid="add-role-duplicate">
            {duplicateNameText(trimmed)}
          </p>
        )}
      </div>
      {empty ? (
        <p className="add-role-first" data-testid="add-role-first">
          The first role becomes the top of the team.
        </p>
      ) : (
        <div className="field">
          <label htmlFor={parentId}>Reports to</label>
          <select id={parentId} className="select" value={parent ?? ''} aria-describedby={helperId} data-testid="add-role-parent" onChange={(e) => setParent(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {parentRole && (
            <p id={helperId} className="field-msg" data-testid="add-role-helper">
              {addHelperText(parentRole.name, parentRole.canSpawn)}
            </p>
          )}
        </div>
      )}
      {failure && (
        <Banner tone="danger" testId="add-role-error">
          {failure}
        </Banner>
      )}
      <div className="add-role-actions">
        <Button variant="ghost" size="sm" onClick={close} testId="add-role-cancel">
          Cancel
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={!valid} loading={busy} testId="add-role-submit">
          {empty ? 'Add first role' : 'Add role'}
        </Button>
      </div>
    </form>
  )
}
