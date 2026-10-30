import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Switch } from './ui/Switch'

/**
 * Thin mirror of AppSettings.notifications (the single source of truth, read by the main process). It reads
 * the saved setting, writes through settings.set and follows settings:changed. App settings > App holds the
 * canonical control; the sidebar render can be dropped (see the UI lead report).
 */
export default function NotificationsToggle(): ReactElement {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let live = true
    void window.orgai.settings
      .get()
      .then((s) => {
        if (live) setEnabled(s.notifications !== false)
      })
      .catch(() => undefined)
    const off = window.orgai.onSettingsChanged((s) => setEnabled(s.notifications !== false))
    return () => {
      live = false
      off()
    }
  }, [])

  const change = (next: boolean): void => {
    setEnabled(next)
    void window.orgai.settings
      .get()
      .then(({ dataDir: _d, appVersion: _v, ...s }) => window.orgai.settings.set({ ...s, notifications: next }))
      .catch(() => undefined)
  }

  return (
    <label className="notify-toggle" title="Show an OS notification when a run needs you while OrgAI is in the background">
      <Switch checked={enabled} onChange={change} label="Notifications" />
      <span>Notifications</span>
    </label>
  )
}
