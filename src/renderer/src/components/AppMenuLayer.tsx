import type { ReactElement } from 'react'
import { useCallback } from 'react'
import { closeKeyboardShortcuts, useKeyboardShortcutsOpen, useMenuAnnouncement } from '../lib/menuActions'
import { useAppMenu } from '../lib/useAppMenu'
import { useAppNavigate } from '../lib/useAppNavigate'
import KeyboardShortcutsDialog from './KeyboardShortcutsDialog'

/**
 * Application menu plumbing with no visible chrome of its own: the hook that routes menu actions and reports menu
 * state, the keyboard shortcuts dialog, and the app-wide polite status region for "does not apply" sentences shown
 * when the run tabs (which show them visibly) are not on screen.
 */
export default function AppMenuLayer(): ReactElement {
  // Subscribe to agent navigations before useAppMenu sends the first menu.setState: main queues app:navigate until then.
  useAppNavigate()
  useAppMenu()
  const open = useKeyboardShortcutsOpen()
  const text = useMenuAnnouncement()
  const onClose = useCallback(() => {
    closeKeyboardShortcuts()
    // Opened from the native menu nothing had focus; give it back to the page instead of leaving it on <body>.
    requestAnimationFrame(() => {
      const a = document.activeElement
      if (!a || a === document.body) document.getElementById('main-content')?.focus()
    })
  }, [])
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" data-testid="menu-announce">
        {text}
      </div>
      <KeyboardShortcutsDialog open={open} onClose={onClose} />
    </>
  )
}
