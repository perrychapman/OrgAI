import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { CircleArrowUp, X } from 'lucide-react'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { useAppStore } from '../../store/useAppStore'
import { ensureUpdates, useUpdatesStore } from '../../store/updatesStore'
import { openUpdates } from '../../lib/menuActions'
import { updateNotice } from '../../lib/updates'
import '../../styles/updates.css'

/**
 * The sidebar's quiet "Update available: <version>" row, above the account footer (docs/agent-notes/updates.md
 * "Renderer"). It never takes focus, never covers a view and is hidden on App settings (the Updates block says it
 * there). Activating it opens App settings > About > Updates; Dismiss hides it for that version for this session. The
 * first appearance of a version or of "ready" is said once through this row's own polite region.
 */
export default function UpdateNotice({ rail }: { rail: boolean }): ReactElement {
  useEffect(ensureUpdates, [])
  const state = useUpdatesStore((s) => s.state)
  const dismissed = useUpdatesStore((s) => s.dismissedVersion)
  const onSettings = useAppStore((s) => s.view === 'appSettings')
  const current = updateNotice(state, dismissed)
  const notice = onSettings ? null : current
  const [said, setSaid] = useState('')
  const lastSaid = useRef('')
  const text = current?.text ?? ''
  useEffect(() => {
    if (!text || text === lastSaid.current) return
    lastSaid.current = text
    // On App settings the Updates block has already said it: remember it without a second announcement.
    if (!onSettings) setSaid(`${text}. Open it from the sidebar.`)
  }, [text, onSettings])

  return (
    <div className="update-notice-slot">
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {notice &&
        (rail ? (
          <IconButton icon={CircleArrowUp} label={`${notice.text}. Open App settings, About`} testId="update-notice" onClick={openUpdates} />
        ) : (
          <div className="update-notice" data-testid="update-notice">
            <button type="button" className="nav-item update-notice-open" data-testid="update-notice-open" title="Open Settings > About and updates" onClick={openUpdates}>
              <Icon icon={CircleArrowUp} size="sm" />
              <span className="update-notice-text">{notice.text}</span>
            </button>
            <IconButton
              icon={X}
              size="sm"
              label={`Dismiss ${notice.text}`}
              testId="update-notice-dismiss"
              onClick={() => {
                // The row goes away with its button: continue from the App settings button just below.
                document.querySelector<HTMLElement>('[data-testid=app-settings-button]')?.focus()
                useUpdatesStore.getState().dismiss(notice.version)
              }}
            />
          </div>
        ))}
    </div>
  )
}
