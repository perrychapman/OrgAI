import type { ReactElement } from 'react'

/**
 * The one quiet line under a start page's message box while its draft was prefilled from a to-do (docs/design/todos.md).
 * The page shows it only while `useTodoDraftLinked` is true and ties it to the box with Composer's `describedBy`.
 */
export default function TodoDraftNote({ id, sendLabel }: { id: string; sendLabel: string }): ReactElement {
  return (
    <p className="muted" id={id} data-testid="todo-draft-note">
      {`Drafted from your to-do. Nothing is sent until you press ${sendLabel}. The item stays on your list.`}
    </p>
  )
}
