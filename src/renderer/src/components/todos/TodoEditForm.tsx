import type { FormEvent, KeyboardEvent, ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'
import { TODO_DETAIL_MAX_CHARS, TODO_TITLE_MAX_CHARS } from '@shared/types'
import { cleanTodoText } from '@shared/todos'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'

export interface TodoEdits {
  title?: string
  detail?: string | null
}

/**
 * Inline edit of one to-do. It keeps the item as it was when the edit opened: the diff and `expectedUpdatedAt` come from
 * that snapshot, so a change made elsewhere meanwhile is refused by main instead of being overwritten. A refusal shows
 * under the fields and keeps what was typed. Enter in the title saves, Escape cancels.
 */
export default function TodoEditForm({
  item,
  onSave,
  onCancel
}: {
  item: TodoItem
  /** Resolves to a plain sentence when the save was refused, or null when it went through (the form then closes). */
  onSave: (edits: TodoEdits, expectedUpdatedAt: number) => Promise<string | null>
  onCancel: () => void
}): ReactElement {
  const snapshot = useRef(item).current
  const [title, setTitle] = useState(snapshot.title)
  const [detail, setDetail] = useState(snapshot.detail ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleId = useId()
  const detailId = useId()
  const errorId = useId()

  useEffect(() => {
    const el = document.getElementById(titleId) as HTMLInputElement | null
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [titleId])

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    const cleaned = cleanTodoText({ title, detail })
    if (!cleaned.ok) {
      setError(cleaned.problem)
      return
    }
    const edits: TodoEdits = {}
    if (cleaned.title !== undefined && cleaned.title !== snapshot.title) edits.title = cleaned.title
    if ((cleaned.detail ?? null) !== (snapshot.detail ?? null)) edits.detail = cleaned.detail ?? null
    if (edits.title === undefined && edits.detail === undefined) {
      onCancel()
      return
    }
    setBusy(true)
    setError(null)
    const problem = await onSave(edits, snapshot.updatedAt)
    setBusy(false)
    if (problem) setError(problem)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  return (
    <form className="todo-edit" onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} noValidate>
      <label className="todo-edit-label" htmlFor={titleId}>
        Title
      </label>
      <Input id={titleId} data-testid="todo-edit-title" value={title} onChange={setTitle} invalid={!!error} aria-describedby={error ? errorId : undefined} autoComplete="off" spellCheck />
      <label className="todo-edit-label" htmlFor={detailId}>
        Details
      </label>
      <Textarea id={detailId} data-testid="todo-edit-detail" value={detail} rows={4} onChange={setDetail} invalid={!!error} aria-describedby={error ? errorId : undefined} />
      <p className="todo-edit-limit muted">
        Title up to {TODO_TITLE_MAX_CHARS} characters, details up to {TODO_DETAIL_MAX_CHARS.toLocaleString()}.
      </p>
      {error && (
        <p className="field-error" id={errorId} data-testid="todo-row-error">
          {error}
        </p>
      )}
      <div className="todo-edit-actions">
        <Button type="submit" variant="primary" size="sm" testId="todo-edit-save">
          Save
        </Button>
        <Button size="sm" onClick={onCancel} testId="todo-edit-cancel">
          Cancel
        </Button>
      </div>
    </form>
  )
}
