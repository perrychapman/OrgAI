import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { ConnectionInfo } from '@shared/types'
import { PROXIES_MAX, isProxyConnection } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import RemapNotices from '../RemapNotices'
import { APP_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { SettingsSection } from '../settings/SettingsSection'
import ConnectionCard from './ConnectionCard'
import ProxyCard from './ProxyCard'
import AddProxyDialog from './AddProxyDialog'
import type { ProxyAdded } from './AddProxyDialog'
import { ConnectionsAnnounceContext } from './announce'

const nameOf = (c: ConnectionInfo): string => (isProxyConnection(c.connection) ? c.connection.name : '')

/** App settings > Connections: notices, the two built-in cards, the Proxies group and page states. */
export default function ConnectionsPanel(): ReactElement {
  const connections = useAppStore((s) => s.connections)
  const error = useAppStore((s) => s.connectionsError)
  const load = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  const [busy, setBusy] = useState(false)
  /** The pane's one polite live region; cards announce through ConnectionsAnnounceContext. */
  const [live, setLive] = useState('')
  const announce = useCallback((message: string) => {
    // Clear first so a repeated message is read again.
    setLive('')
    setTimeout(() => setLive(message), 50)
  }, [])
  const [adding, setAdding] = useState(false)
  const [openProxy, setOpenProxy] = useState<string | null>(null)
  const [focusProxy, setFocusProxy] = useState<string | null>(null)
  const clearFocus = useCallback(() => setFocusProxy(null), [])

  useEffect(() => {
    void load()
  }, [load])

  const refreshAll = async (): Promise<void> => {
    setBusy(true)
    await load()
    await Promise.all(
      (useAppStore.getState().connections ?? []).filter((c) => c.status.state === 'connected').map((c) => loadModels(c.connection.id, true))
    )
    setBusy(false)
  }

  const onAdded = (a: ProxyAdded): void => {
    setAdding(false)
    setOpenProxy(a.id)
    setFocusProxy(a.id)
    // After the card's own "connected" status announcement, so this fuller sentence is the one that stays.
    setTimeout(() => announce(`${a.name} added. ${a.connected ? 'Connected.' : (a.detail ?? 'Not connected yet.')}`), 250)
  }
  const onRemoved = (name: string): void => {
    setOpenProxy(null)
    announce(`${name} removed`)
    setTimeout(() => document.getElementById('proxies-heading')?.focus(), 60)
  }

  const proxies = (connections ?? []).filter((c) => isProxyConnection(c.connection))
  const atMax = proxies.length >= PROXIES_MAX
  const none = connections && connections.every((c) => c.status.state !== 'connected')
  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.connections}
      titleId="connections-title"
      title="Connections"
      description="Where agents get their models. One connection is the default for new projects and assistants; each project can switch in its own Settings."
      actions={
        <Button loading={busy} title="Reload status and model lists" onClick={() => void refreshAll()}>
          Refresh all
        </Button>
      }
    >
      <p className="sr-only" role="status" aria-live="polite" data-testid="connections-live">
        {live}
      </p>
      <RemapNotices />
      {error && !connections ? (
        <Banner tone="danger" title="Could not load connections" actions={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Banner>
      ) : !connections ? (
        <div className="conn-stack" aria-busy="true" aria-label="Loading connections">
          {['anthropic', 'openai'].map((id) => (
            <div key={id} className="card-block">
              <div className="card-sec">
                <div className="skeleton w-40" />
                <div className="skeleton w-70" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {none && <Banner tone="neutral">No connection is set up. Connect one so projects can run.</Banner>}
          <ConnectionsAnnounceContext.Provider value={announce}>
            <div className="conn-stack">
              {connections
                .filter((c) => !isProxyConnection(c.connection))
                .map((c) => (
                  <ConnectionCard key={c.connection.id} info={c} />
                ))}
            </div>
            <div className="conn-group-head">
              <h3 id="proxies-heading" tabIndex={-1} data-testid="proxies-heading">
                Proxies ({proxies.length})
              </h3>
              <Button variant="primary" size="sm" testId="proxy-add" inert={atMax} ariaDescribedBy={atMax ? 'proxy-add-reason' : undefined} onClick={() => setAdding(true)}>
                Add proxy
              </Button>
            </div>
            {atMax && (
              <p className="field-msg warn" id="proxy-add-reason" data-testid="proxy-add-reason">
                You have {PROXIES_MAX} proxies, the most OrgAI keeps. Remove one to add another.
              </p>
            )}
            {proxies.length === 0 ? (
              <p className="muted" data-testid="proxies-empty">
                No proxies yet. Add one to route Claude, GPT and other models through a gateway you run.
              </p>
            ) : (
              <div className="conn-stack" data-testid="proxy-list">
                {proxies.map((c) => (
                  <ProxyCard
                    key={c.connection.id}
                    info={c}
                    open={openProxy === c.connection.id}
                    onToggle={() => {
                      // Opening re-reads the list so "used by" is current (projects change connection elsewhere).
                      if (openProxy !== c.connection.id) void load()
                      setOpenProxy((cur) => (cur === c.connection.id ? null : c.connection.id))
                    }}
                    focusToken={focusProxy}
                    onFocused={clearFocus}
                    onRemoved={onRemoved}
                    existingNames={['Anthropic', 'OpenAI', ...proxies.filter((p) => p.connection.id !== c.connection.id).map(nameOf)]}
                  />
                ))}
              </div>
            )}
            <AddProxyDialog open={adding} onClose={() => setAdding(false)} existingNames={proxies.map(nameOf)} onAdded={onAdded} />
          </ConnectionsAnnounceContext.Provider>
        </>
      )}
    </SettingsSection>
  )
}
