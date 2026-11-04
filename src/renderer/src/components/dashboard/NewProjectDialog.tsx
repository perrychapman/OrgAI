import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'
import { Dialog } from '../ui/Dialog'
import { NewProjectForm } from './NewProjectForm'

const OPENER = '[data-testid=new-project]'

/**
 * The New project form in a dialog, for a Dashboard that already has projects. Esc, the close button and Cancel call
 * `onClose`; focus goes back to the "New project" button (Dialog restores the opener, and this repeats it for the case
 * where the dialog was opened without that button focused, such as a draft parked by the Connections link).
 */
export function NewProjectDialog({ open, onClose, mockAvailable }: { open: boolean; onClose: () => void; mockAvailable: boolean }): ReactElement | null {
  // The form mounts inside a still-closed <dialog>, so its own focus call finds nothing to focus. Put the cursor in the project kind choice (the checked card, else the first) once open.
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const radios = Array.from(document.querySelectorAll<HTMLInputElement>('[data-testid=new-project-dialog] [data-testid=project-kind] input[type=radio]'))
      ;(radios.find((r) => r.checked) ?? radios[0])?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  // After a close, make sure focus is on the opener (a no-op once the view has changed and the button is gone).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return undefined
    }
    if (!wasOpen.current) return undefined
    wasOpen.current = false
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !active.closest('dialog')) return
      document.querySelector<HTMLElement>(OPENER)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} title="New project" size="lg" testId="new-project-dialog">
      <NewProjectForm mockAvailable={mockAvailable} onCancel={onClose} variant="dialog" />
    </Dialog>
  )
}
