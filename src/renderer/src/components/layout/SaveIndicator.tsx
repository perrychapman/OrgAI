import type { ReactElement } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { Icon } from '../ui/Icon'

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The one autosave indicator (spec 12.5): "Saving…", "Saved HH:MM" or "Save failed". Driven by the store's
 * saveStatus slice; renders an empty live region while idle so announcements still work.
 */
export function SaveIndicator(): ReactElement {
  const status = useAppStore((s) => s.saveStatus)
  return (
    <span
      className={`save-indicator is-${status.state}`}
      role="status"
      aria-live="polite"
      data-testid="save-indicator"
      title={status.state === 'saved' && status.at !== undefined ? `Saved ${clock(status.at)}` : status.state === 'saving' ? 'Saving…' : undefined}
    >
      {status.state === 'saving' && (
        <>
          <Icon icon={LoaderCircle} size="sm" /> <span className="save-text">Saving…</span>
        </>
      )}
      {status.state === 'saved' && status.at !== undefined && (
        <>
          <Icon icon={Check} size="sm" /> <span className="save-text" title={`Saved ${clock(status.at)}`}>Saved {clock(status.at)}</span>
        </>
      )}
      {status.state === 'error' && (
        <span title={status.message}>
          <Icon icon={CircleAlert} size="sm" /> Save failed{status.message ? `: ${status.message}` : ''}
        </span>
      )}
    </span>
  )
}
