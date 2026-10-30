import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { SettingsSection } from '../settings/SettingsSection'
import { filterConnectors, sortForGallery } from '../../lib/connectors'
import { ConnectorTile } from './ConnectorTile'
import ConnectorDialog from './ConnectorDialog'
import { useConnectors } from './useConnectors'

/** App settings > Connectors: the curated services, connected ones first. */
export function ConnectorGallery(): ReactElement {
  const { connectors, error, refresh } = useConnectors()
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const shown = useMemo(() => (connectors ? filterConnectors(sortForGallery(connectors), query) : []), [connectors, query])
  const open = connectors?.find((c) => c.connector.id === openId)

  return (
    <SettingsSection
      id="appsettings-section-connectors"
      title="Connectors"
      description="Connect the services your agents work with. Sign-in stays on this computer."
      testId="connectors-section"
    >
      <div className="connectors-body">
        {error && !connectors ? (
          <Banner
            tone="danger"
            title="Could not load the services"
            actions={
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </Banner>
        ) : connectors === null ? (
          <ul className="connector-grid" aria-busy="true" aria-label="Loading services">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="connector-tile">
                <div className="skeleton connector-sk" />
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className="connector-search">
              <span className="connector-search-icon">
                <Icon icon={Search} size="sm" />
              </span>
              <Input type="search" value={query} onChange={setQuery} placeholder="Search services" aria-label="Search services" data-testid="connector-search" />
            </div>
            {shown.length === 0 ? (
              <div className="connector-empty" data-testid="connector-empty">
                <strong>No service matches "{query.trim()}"</strong>
                <p className="muted">Try a different name or category. Any other server can be added under Custom servers below.</p>
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              </div>
            ) : (
              <ul className="connector-grid" aria-label="Services">
                {shown.map((info) => (
                  <ConnectorTile key={info.connector.id} info={info} onOpen={() => setOpenId(info.connector.id)} />
                ))}
              </ul>
            )}
          </>
        )}
        {open && <ConnectorDialog info={open} onClose={() => setOpenId(null)} />}
      </div>
    </SettingsSection>
  )
}
