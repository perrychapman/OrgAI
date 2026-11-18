import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil, Play, Trash2 } from 'lucide-react'
import type { TodoRowView } from '@shared/view/todos'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import TodoEditForm, { type TodoEdits } from './TodoEditForm'

export interface TodoRunLink {
  id: string
  projectId: string
  /** "Session 2": the order the user started them in, oldest first. */
  label: string
  /** The run's own name, for the accessible name and the tooltip. */
  name: string
}

/**
 * One to-do. Everything an agent wrote (title, detail, role name) is drawn as plain text nodes: no Markdown, no links
 * made from the text, no HTML. The edit form replaces the row's text while it is open.
 */
export default function TodoRow({
  row,
  writable,
  editing,
  error,
  sourceLink,
  runLinks,
  onToggle,
  onEdit,
  onDelete,
  onStart,
  onOpenRun,
  onSave,
  onCancelEdit
}: {
  row: TodoRowView
  writable: boolean
  editing: boolean
  /** The last refusal of an action on this row (not of an edit: the form shows its own). */
  error?: string
  sourceLink?: TodoRunLink
  runLinks: TodoRunLink[]
  onToggle: (row: TodoRowView, done: boolean) => void
  onEdit: (row: TodoRowView) => void
  onDelete: (row: TodoRowView) => void
  onStart: (row: TodoRowView) => void
  onOpenRun: (link: TodoRunLink) => void
  onSave: (row: TodoRowView, edits: TodoEdits, expectedUpdatedAt: number) => Promise<string | null>
  onCancelEdit: (row: TodoRowView) => void
}): ReactElement {
  const [showDetail, setShowDetail] = useState(false)
  const detailId = useId()
  const done = row.item.status === 'done'
  return (
    <li className="todo-row" data-testid="todo-row" data-todo-id={row.id} data-status={row.item.status}>
      {editing ? (
        <TodoEditForm item={row.item} onSave={(edits, expected) => onSave(row, edits, expected)} onCancel={() => onCancelEdit(row)} />
      ) : (
        <>
          <div className="todo-row-main">
            <Checkbox
              checked={done}
              onChange={(next) => onToggle(row, next)}
              label={
                <span className={`todo-title${done ? ' is-done' : ''}`} data-testid="todo-title">
                  {row.title}
                </span>
              }
              disabled={!writable}
              testId="todo-check"
            />
            {row.detail && (
              <div className="todo-detail-wrap">
                <button
                  type="button"
                  className="todo-detail-toggle"
                  data-testid="todo-detail-toggle"
                  aria-expanded={showDetail}
                  aria-controls={showDetail ? detailId : undefined}
                  onClick={() => setShowDetail((v) => !v)}
                >
                  <Icon icon={showDetail ? ChevronDown : ChevronRight} size="sm" />
                  Details
                </button>
                {showDetail && (
                  <p className="todo-detail" id={detailId} data-testid="todo-detail">
                    {row.detail}
                  </p>
                )}
              </div>
            )}
            {(row.sourceText || runLinks.length > 0) && (
              <div className="todo-meta">
                {row.sourceText && (
                  <p>
                    <span data-testid="todo-source">{row.sourceText}</span>
                    {sourceLink && (
                      <>
                        {' · '}
                        <button type="button" className="link-btn" data-testid="todo-source-link" aria-label={`Open the conversation ${row.checkLabel} came from`} onClick={() => onOpenRun(sourceLink)}>
                          Open conversation
                        </button>
                      </>
                    )}
                  </p>
                )}
                {runLinks.length > 0 && (
                  <p data-testid="todo-runs">
                    Started from this:{' '}
                    {runLinks.map((link, i) => (
                      <span key={link.id}>
                        {i > 0 && ', '}
                        <button type="button" className="link-btn" data-testid="todo-run-link" title={link.name} aria-label={`Open ${link.label}: ${link.name}`} onClick={() => onOpenRun(link)}>
                          {link.label}
                        </button>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            )}
            {error && (
              <p className="field-error" data-testid="todo-row-error">
                {error}
              </p>
            )}
          </div>
          <div className="todo-row-actions">
            {row.canStart && (
              <Button
                size="sm"
                icon={Play}
                ariaLabel={`Start session for ${row.checkLabel}`}
                title="Fills the message box with this to-do. Nothing starts until you send it."
                onClick={() => onStart(row)}
                testId="todo-start"
              >
                Start session
              </Button>
            )}
            <IconButton icon={Pencil} label={`Edit ${row.checkLabel}`} size="sm" inert={!writable} onClick={() => onEdit(row)} testId="todo-edit" />
            <IconButton icon={Trash2} label={`Delete ${row.checkLabel}`} size="sm" inert={!writable} onClick={() => onDelete(row)} testId="todo-delete" />
          </div>
        </>
      )}
    </li>
  )
}
