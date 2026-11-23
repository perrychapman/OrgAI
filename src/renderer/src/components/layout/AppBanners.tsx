import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { AuthStatusResult, ConnectionId, ConnectionStatus, Project, UpdateState } from '@shared/types'
import { projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { ensureUpdates, installUpdate, useUpdatesStore } from '../../store/updatesStore'
import { connectionLabel } from '../../lib/connectionLabel'
import { openUpdates } from '../../lib/menuActions'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { Banner, BannerPresence } from '../ui/Banner'
import { Button } from '../ui/Button'
import '../../styles/banners.css'

/** Whether the network looks reachable, following the browser's online and offline events. `recheck` reads it again. */
export function useOnline(): { online: boolean; recheck: () => boolean } {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return {
    online,
    recheck: () => {
      const now = navigator.onLine
      setOnline(now)
      return now
    }
  }
}

/**
 * The connection that needs signing in: the effective default one, when it is a sign-in connection (Claude or Codex,
 * never a proxy or the mock adapter) and its status says it is not connected or errored. A key in the environment
 * (API key mode) has nothing to sign in to. Pure; null when there is nothing to say.
 */
export function signInNeeded(input: {
  mock: boolean
  defaultConnection: ConnectionId | null
  status: ConnectionStatus | undefined
  auth: AuthStatusResult | null
}): ConnectionId | null {
  const { mock, defaultConnection: id, status, auth } = input
  if (mock || !id || (id !== 'anthropic' && id !== 'openai') || !status) return null
  if (status.state !== 'disconnected' && status.state !== 'error') return null
  if (id === 'anthropic' && auth?.mode === 'apiKey') return null
  return id
}

/** Projects whose connection is `id` (the number the sign-in banner states). */
export function projectsUsing(projects: readonly Pick<Project, 'provider'>[], id: ConnectionId): number {
  return projects.filter((p) => projectConnection(p) === id).length
}

/** The update the "ready" banner offers: downloaded, installable by the app itself, not already installing. */
export function readyUpdate(state: UpdateState | null, dismissed: string | null): string | null {
  if (!state || state.capability !== 'auto' || state.status !== 'downloaded' || state.installing || !state.availableVersion) return null
  return state.availableVersion === dismissed ? null : state.availableVersion
}

/**
 * App-wide banners (ui-overhaul Empty board): offline, sign in again, an update that is ready. In-flow at the top of the
 * content area, under the project's top bar when there is one. Each is a named region (no live region of its own except
 * offline and sign-in, which are news the user should hear once). Offline and sign-in clear themselves; the update
 * banner can be dismissed for the version, this session.
 */
export default function AppBanners(): ReactElement | null {
  const view = useAppStore((s) => s.view)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const auth = useAppStore((s) => s.auth)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const connections = useAppStore((s) => s.connections)
  const projects = useAppStore((s) => s.projects)
  const setView = useAppStore((s) => s.setView)
  const { online, recheck } = useOnline()
  const [stillOffline, setStillOffline] = useState(false)
  useEffect(() => {
    if (online) setStillOffline(false)
  }, [online])
  useEffect(ensureUpdates, [])
  const updateState = useUpdatesStore((s) => s.state)
  const dismissed = useUpdatesStore((s) => s.dismissedVersion)

  const status = connections?.find((c) => c.connection.id === defaultConnection)?.status
  const needSignIn = signInNeeded({ mock, defaultConnection, status, auth })
  const ready = readyUpdate(updateState, dismissed)
  // App settings already says both in place (Connections, About > Updates).
  const onSettings = view === 'appSettings'

  const signIn = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
    setView('appSettings')
  }
  const used = needSignIn ? projectsUsing(projects, needSignIn) : 0

  // Always mounted so a leaving banner can finish its exit; the empty wrapper takes no space (banners.css).
  return (
    <div className="app-banners" data-testid="app-banners">
      <BannerPresence show={!online}>
        <Banner
          tone="warning"
          testId="banner-offline"
          title="You are offline."
          actions={
            <Button
              size="sm"
              testId="banner-offline-retry"
              onClick={() => {
                if (!recheck()) setStillOffline(true)
              }}
            >
              Try now
            </Button>
          }
        >
          {stillOffline ? 'Still offline. OrgAI keeps checking and will say when the connection is back.' : 'Agents cannot reach their provider until the connection is back.'}
        </Banner>
      </BannerPresence>
      <BannerPresence show={!!needSignIn && !onSettings}>
        <Banner
          tone="danger"
          testId="banner-sign-in"
          title={`${connectionLabel(needSignIn ?? 'anthropic')} needs you to sign in.`}
          actions={
            <Button size="sm" variant="primary" testId="banner-sign-in-action" onClick={signIn}>
              Sign in
            </Button>
          }
        >
          {used > 0 ? `${used} ${used === 1 ? 'project uses' : 'projects use'} it. Runs that use it cannot work until you sign in.` : 'Runs that use it cannot work until you sign in.'}
        </Banner>
      </BannerPresence>
      <BannerPresence show={!!ready && !onSettings}>
        <Banner
          tone="info"
          label="Update ready"
          testId="banner-update"
          onDismiss={ready ? () => useUpdatesStore.getState().dismiss(ready) : undefined}
          title={`Version ${ready ?? ''} is ready.`}
          actions={
            <Button
              size="sm"
              variant="primary"
              testId="banner-update-restart"
              onClick={() => {
                // Refused (live runs would stop): App settings > About holds the confirmation that ends them.
                void installUpdate().then((r) => {
                  if (!r.ok) openUpdates()
                })
              }}
            >
              Restart
            </Button>
          }
        >
          It installs the next time you restart.
        </Banner>
      </BannerPresence>
    </div>
  )
}
