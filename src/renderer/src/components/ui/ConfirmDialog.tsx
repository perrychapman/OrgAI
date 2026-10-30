import type { ReactElement, ReactNode } from 'react'
import { useCallback, useRef, useState } from 'react'
import { ConfirmDialog } from './Dialog'

export { ConfirmDialog }

export interface ConfirmOptions {
  title: string
  body: ReactNode
  confirmLabel: string
  /** Danger variant for destructive confirms (discard, delete, remove). */
  danger?: boolean
}

/**
 * Promise-style confirmation that replaces window.confirm().
 *   const { confirm, dialog } = useConfirm()
 *   if (await confirm({ title: 'Discard branch?', body: '...', confirmLabel: 'Discard', danger: true })) ...
 *   return <>{...}{dialog}</>
 * Resolves true on confirm, false on Cancel, Esc or backdrop click. Focus starts on Cancel.
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactElement } {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const [shown, setShown] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const settle = useCallback((ok: boolean): void => {
    resolver.current?.(ok)
    resolver.current = null
    setOpts(null)
  }, [])
  const confirm = useCallback((o: ConfirmOptions): Promise<boolean> => {
    resolver.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setShown(o)
      setOpts(o)
    })
  }, [])
  const dialog = (
    <ConfirmDialog
      open={opts !== null}
      title={shown?.title ?? ''}
      body={shown?.body}
      confirmLabel={shown?.confirmLabel ?? 'Confirm'}
      danger={shown?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )
  return { confirm, dialog }
}
