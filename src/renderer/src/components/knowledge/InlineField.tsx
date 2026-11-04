import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

/**
 * An inline-editable value (docs/design/knowledge.md section 3): at rest a `button.inline-edit` showing the value (or
 * a quiet placeholder), on activation the field itself. Saves on blur and Enter (a multiline field saves on blur and
 * Ctrl+Enter, since Enter adds a line), Esc cancels. A refused save keeps the field open with the message under it
 * (`knowledge-field-error`, role=alert) and `aria-invalid`; the stored value stays what it was.
 */
export function InlineField({
  label,
  value,
  placeholder,
  display,
  multiline,
  rows = 3,
  maxLength,
  options,
  inputTestId,
  restTestId,
  className,
  onSave
}: {
  /** The action, e.g. "Edit name" (the rest button's name is "<label>: <value>"). */
  label: string
  value: string
  /** Shown quietly at rest when the value is empty, e.g. "Add a summary". */
  placeholder?: string
  /** What the rest button shows instead of the raw value. */
  display?: ReactNode
  multiline?: boolean
  rows?: number
  maxLength?: number
  /** Renders a datalist of suggestions for a single-line field. */
  options?: readonly string[]
  inputTestId: string
  restTestId?: string
  className?: string
  /** Resolves to null when saved, else the message to show. */
  onSave: (value: string) => Promise<string | null>
}): ReactElement {
  const uid = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const restRef = useRef<HTMLButtonElement>(null)
  const fieldId = `${uid}-field`
  const fieldEl = (): HTMLElement | null => document.getElementById(fieldId)
  const committing = useRef(false)
  const [refocus, setRefocus] = useState(0)

  useEffect(() => {
    if (editing) fieldEl()?.focus()
  }, [editing])
  useEffect(() => {
    if (refocus) restRef.current?.focus()
  }, [refocus])
  // A value changed elsewhere (a push) replaces an untouched draft.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const open = (): void => {
    setDraft(value)
    setError(null)
    setEditing(true)
  }
  const close = (): void => {
    setEditing(false)
    setError(null)
    setRefocus((n) => n + 1)
  }
  const commit = async (fromKey: boolean): Promise<void> => {
    if (committing.current) return
    const next = multiline ? draft.replace(/\s+$/, '') : draft.replace(/\s+/g, ' ').trim()
    if (next === value) {
      close()
      return
    }
    committing.current = true
    setBusy(true)
    try {
      const problem = await onSave(next)
      if (problem) {
        setError(problem)
        // Enter keeps the user in the field; a blur that failed leaves the message without pulling focus back.
        if (fromKey) fieldEl()?.focus()
      } else close()
    } finally {
      committing.current = false
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <button ref={restRef} type="button" className={`inline-edit${value ? '' : ' is-empty'}${className ? ` ${className}` : ''}`} aria-label={value ? `${label}: ${value}` : label} title={label} data-testid={restTestId} onClick={open}>
        {display ?? (value || placeholder || label)}
      </button>
    )
  }
  const describedBy = error ? `${uid}-err` : undefined
  const listId = options && options.length ? `${uid}-list` : undefined
  return (
    <span className={`inline-field${className ? ` ${className}` : ''}`}>
      {multiline ? (
        <Textarea
          id={fieldId}
          aria-label={label}
          value={draft}
          rows={rows}
          maxLength={maxLength}
          invalid={!!error}
          aria-describedby={describedBy}
          disabled={busy}
          data-testid={inputTestId}
          onChange={(v) => {
            setDraft(v)
            setError(null)
          }}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void commit(true)
            }
          }}
        />
      ) : (
        <Input
          id={fieldId}
          aria-label={label}
          value={draft}
          maxLength={maxLength}
          invalid={!!error}
          aria-describedby={describedBy}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          list={listId}
          data-testid={inputTestId}
          onChange={(v) => {
            setDraft(v)
            setError(null)
          }}
          onBlur={() => void commit(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void commit(true)
            }
          }}
        />
      )}
      {listId && (
        <datalist id={listId}>
          {options!.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      {error && (
        <span id={`${uid}-err`} className="field-msg error knowledge-field-error" role="alert" data-testid="knowledge-field-error">
          {error}
        </span>
      )}
    </span>
  )
}
