import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { CONNECTION_IDS } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import RemapNotices from '../RemapNotices'
import { APP_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { SettingsSection } from '../settings/SettingsSection'
import ConnectionCard from './ConnectionCard'

/** App settings > Connections: notices, the three provider cards and page states. */
export default function ConnectionsPanel(): ReactElement {
  const connections = useAppStore((s) => s.connections)
  const error = useAppStore((s) => s.connectionsError)
  const load = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  const [busy, setBusy] = useState(false)

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

  const none = connections && connections.every((c) => c.status.state !== 'connected')
  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.connections}
      titleId="connections-title"
      title="Connections"
      description="Where agents get their models. One connection is the default for new projects; each project can switch in its own Settings."
      actions={
        <Button loading={busy} title="Reload status and model lists" onClick={() => void refreshAll()}>
          Refresh all
        </Button>
      }
    >
      <RemapNotices />
      {error && !connections ? (
        <Banner tone="danger" title="Could not load connections" actions={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {error}
        </Banner>
      ) : !connections ? (
        <div className="conn-stack" aria-busy="true" aria-label="Loading connections">
          {CONNECTION_IDS.map((id) => (
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
          <div className="conn-stack">
            {connections.map((c) => (
              <ConnectionCard key={c.connection.id} info={c} />
            ))}
          </div>
        </>
      )}
    </SettingsSection>
  )
}
