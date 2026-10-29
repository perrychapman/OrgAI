import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'
import { Button } from './Button'

/**
 * Modal dialog on the native <dialog> element: focus trap, Esc and inert background come from the platform.
 * Children mount only while open. A control with data-autofocus (Button autoFocusDialog) takes initial focus.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  testId
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  size?: 'sm' | 'md' | 'lg'
  children: ReactNode
  footer?: ReactNode
  testId?: string
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const el = ref.current
    if (!el || !open) return undefined
    const opener = document.activeElement as HTMLElement | null
    if (!el.open) el.showModal()
    el.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      if (el.open) el.close()
      opener?.focus?.()
    }
  }, [open])
  return (
    <dialog
      ref={ref}
      className={`dialog size-${size}`}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open && (
        <div className="dialog-panel">
          <div className="dialog-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <IconButton icon={X} label="Close dialog" size="sm" onClick={onClose} />
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

/** Confirmation on Dialog. Focus starts on Cancel. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button autoFocusDialog onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}
