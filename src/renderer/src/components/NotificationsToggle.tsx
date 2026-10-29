import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'orgai.notifications'

function readSetting(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Global on/off for OS attention notifications. Persists in localStorage and tells the main process. */
export default function NotificationsToggle(): ReactElement {
  const [enabled, setEnabled] = useState(readSetting)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      // Storage unavailable; the choice still applies for this session.
    }
    void window.orgai.notifications.setEnabled(enabled).catch(() => {})
  }, [enabled])

  return (
    <label className="notify-toggle" title="Show an OS notification when a run needs you while OrgAI is in the background">
      <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      Notifications
    </label>
  )
}
