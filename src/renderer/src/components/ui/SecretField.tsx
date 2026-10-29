import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Check, Minus } from 'lucide-react'
import { Badge } from './Badge'
import { Button } from './Button'
import { ConfirmDialog } from './Dialog'

/**
 * Write-only secret input. It never receives or shows a stored value: `state` says whether one exists.
 * Replace turns it into an empty password input (Enter saves, Esc cancels). The typed value is dropped from
 * state as soon as onSave settles. There is deliberately no reveal or copy control.
 */
export function SecretField({
  name,
  state,
  onSave,
  onClear,
  disabled,
  hint
}: {
  name: string
  state: 'set' | 'notSet'
  onSave: (value: string) => void | Promise<void>
  onClear?: () => void | Promise<void>
  disabled?: boolean
  hint?: string
}): ReactElement {
  const id = useId()
  const [replacing, setReplacing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Whatever the stored state does, leave replace mode and drop any typed text when it changes.
  useEffect(() => {
    setReplacing(false)
    setValue('')
  }, [state])

  const editable = state === 'notSet' || replacing

  const save = async (): Promise<void> => {
    if (!value) return
    setBusy(true)
    setError(null)
    try {
      await onSave(value)
      setValue('')
      setReplacing(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const cancel = (): void => {
    setValue('')
    setError(null)
    setReplacing(false)
  }

  return (
    <div className="secret-field" data-testid="secret-field" data-name={name} data-state={state}>
      <div className="secret-row">
        {editable ? (
          <input
            ref={input}
            id={id}
            className="input mono-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={disabled || busy}
            placeholder="Not set"
            aria-label={`${name}, secret, ${state === 'set' ? 'set, enter a new value to replace it' : 'not set'}`}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save()
              } else if (e.key === 'Escape' && replacing) {
                e.stopPropagation()
                cancel()
              }
            }}
          />
        ) : (
          <div id={id} className="input mono-input secret-mask" role="textbox" aria-readonly="true" aria-label={`${name}, secret, set`}>
            ••••••••
          </div>
        )}
        {state === 'set' && !replacing ? (
          <Badge tone="success" icon={Check}>
            Set
          </Badge>
        ) : state === 'notSet' ? (
          <Badge tone="neutral" icon={Minus}>
            Not set
          </Badge>
        ) : null}
        {editable && (
          <Button size="sm" variant="primary" disabled={!value || disabled} loading={busy} onClick={() => void save()}>
            Save
          </Button>
        )}
        {editable && replacing && (
          <Button size="sm" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {!editable && (
          <>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                setReplacing(true)
                setTimeout(() => input.current?.focus(), 0)
              }}
            >
              Replace
            </Button>
            {onClear && (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setConfirmClear(true)}>
                Clear
              </Button>
            )}
          </>
        )}
      </div>
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="hint invalid-text">{error}</span>}
      <ConfirmDialog
        open={confirmClear}
        title={`Clear ${name}?`}
        body={<p>The stored value is deleted. The server may not work until you set it again.</p>}
        confirmLabel="Clear"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          void Promise.resolve(onClear?.()).catch((e: Error) => setError(e.message))
        }}
      />
    </div>
  )
}
