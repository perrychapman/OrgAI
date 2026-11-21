import type { FormEvent, ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { cleanDisplayName, DISPLAY_NAME_MAX_CHARS } from '@shared/displayName'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Popover } from '../ui/Popover'
import { NAME_NOT_SAVED, NAME_REFUSED, saveDisplayName } from '../../lib/dashboardName'

/**
 * The name control of the Briefing (docs/design/dashboard-overhaul.md section 5): a pencil that edits a saved name, or an
 * "Add your name" button, both opening the same one-field popover. The person's name is shown only in the greeting and in
 * the two edit fields (here and Settings > General > About you): it never goes into a log, an error string or an
 * announcement.
 */

const SAVE_FAILED = `${NAME_NOT_SAVED} Try again.`

/** AppSettings.displayName: read once, then follow settings:changed (another window, the Settings field). */
export function useDisplayName(): [string | undefined, (name: string | undefined) => void] {
  const [name, setName] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    window.orgai.settings
      .get()
      .then((s) => alive && setName(cleanDisplayName(s.displayName)))
      .catch(() => undefined)
    const off = window.orgai.onSettingsChanged((s) => setName(cleanDisplayName(s.displayName)))
    return () => {
      alive = false
      off()
    }
  }, [])
  return [name, setName]
}

/** The panel body: a labelled field, a hint, Save (Remove name when emptying an existing name) and Cancel. */
function NameForm({ name, close, onSaved }: { name: string | undefined; close: () => void; onSaved: (saved: string | undefined) => void }): ReactElement {
  const uid = useId()
  const inputId = `${uid}-name`
  const hintId = `${uid}-hint`
  const errorId = `${uid}-error`
  const [draft, setDraft] = useState(name ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const removing = !!name && draft.trim() === ''

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    const clean = cleanDisplayName(draft)
    if (draft.trim() !== '' && clean === undefined) {
      setError(NAME_REFUSED)
      return
    }
    // Nothing changed (or nothing to remove): close without saving.
    if (clean === name) {
      close()
      return
    }
    setBusy(true)
    try {
      await saveDisplayName(clean ?? null)
      onSaved(clean)
      close()
    } catch {
      setError(SAVE_FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="dash-name-form" onSubmit={(e) => void submit(e)} noValidate>
      <label htmlFor={inputId} className="dash-name-label">
        Your name
      </label>
      <Input
        id={inputId}
        data-testid="dash-name-input"
        value={draft}
        maxLength={DISPLAY_NAME_MAX_CHARS}
        autoComplete="off"
        spellCheck={false}
        invalid={error !== null}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onChange={(v) => {
          setDraft(v)
          setError(null)
        }}
      />
      <p className="dash-name-hint" id={hintId}>
        Used for the greeting on the Dashboard. It stays on this computer.
      </p>
      {error && (
        <p className="dash-name-error" id={errorId} role="alert" data-testid="dash-name-error">
          {error}
        </p>
      )}
      <div className="dash-name-actions">
        <Button type="submit" variant="primary" size="sm" inert={busy} testId="dash-name-save">
          {removing ? 'Remove name' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={close} testId="dash-name-cancel">
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function NameControl({ name, onSaved }: { name: string | undefined; onSaved: (saved: string | undefined) => void }): ReactElement {
  const panel = (api: { close: () => void }): ReactElement => <NameForm name={name} close={api.close} onSaved={onSaved} />
  if (name) {
    return (
      <Popover
        trigger={<Icon icon={Pencil} size="sm" />}
        triggerLabel="Change your name"
        triggerTitle="Change your name"
        triggerClassName="icon-btn size-md"
        triggerTestId="dash-name-edit"
        label="Your name"
        className="dash-name-panel"
        testId="dash-name-panel"
      >
        {panel}
      </Popover>
    )
  }
  return (
    <Popover
      trigger={
        <>
          <Icon icon={Plus} size="sm" />
          Add your name
        </>
      }
      triggerClassName="btn ghost sm"
      triggerTestId="dash-name-add"
      label="Your name"
      className="dash-name-panel"
      testId="dash-name-panel"
    >
      {panel}
    </Popover>
  )
}
