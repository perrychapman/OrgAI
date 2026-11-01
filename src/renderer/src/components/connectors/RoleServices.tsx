import type { ReactElement } from 'react'
import { Settings2 } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { PROJECT_SETTINGS_PANES } from '../../lib/settingsTarget'
import { servicesForRole } from '../../lib/roleServices'
import { capList } from '../../lib/connectors'
import { Button } from '../ui/Button'
import { ConnectorLogo } from './ConnectorLogo'

/** Services listed in the inspector before "and N more". */
const ROLE_SERVICES_CAP = 5

/** Read-only list of the connected services a role can use, with a way into project Settings > Tools. */
export default function RoleServices({ project, role }: { project: Project; role: Role }): ReactElement {
  const setPane = useAppStore((s) => s.setProjectSettingsPane)
  const setView = useAppStore((s) => s.setView)
  const services = servicesForRole(project, role)
  const { shown, more } = capList(services, ROLE_SERVICES_CAP)
  const manage = (): void => {
    setPane(project.id, PROJECT_SETTINGS_PANES.tools)
    setView('settings')
  }
  return (
    <section className="stack-2 role-services" aria-labelledby="role-services-title" data-testid="role-services">
      <h3 className="side-section-title" id="role-services-title">
        Connections
      </h3>
      {services.length === 0 ? (
        <p className="hint">No connections yet. Add and grant them in project Settings &gt; Plugins and suggestions.</p>
      ) : (
        <ul className="role-services-list">
          {shown.map((s) => (
            <li key={s.id} className="role-service" data-testid="role-service" data-name={s.label}>
              {s.connectorId ? (
                <ConnectorLogo def={{ id: s.connectorId, name: s.label }} size="sm" />
              ) : (
                <span className="role-service-tile" style={{ ['--hue' as string]: s.hue }} aria-hidden="true">
                  {s.initial}
                </span>
              )}
              <span className="role-service-name">{s.label}</span>
              {s.custom && <span className="role-service-custom">custom</span>}
            </li>
          ))}
          {more > 0 && (
            <li className="role-service role-service-more" data-testid="role-service-more">
              <button type="button" className="link-btn" onClick={manage}>
                and {more} more
              </button>
            </li>
          )}
        </ul>
      )}
      <div>
        <Button size="sm" icon={Settings2} onClick={manage} testId="role-services-manage">
          Manage connections
        </Button>
      </div>
    </section>
  )
}
