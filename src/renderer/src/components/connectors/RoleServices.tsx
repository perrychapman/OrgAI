import type { ReactElement } from 'react'
import { Settings2 } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { PROJECT_SETTINGS_PANES } from '../../lib/settingsTarget'
import { servicesForRole } from '../../lib/roleServices'
import { Button } from '../ui/Button'

/** Read-only list of the connected services a role can use, with a way into project Settings > Tools. */
export default function RoleServices({ project, role }: { project: Project; role: Role }): ReactElement {
  const setPane = useAppStore((s) => s.setProjectSettingsPane)
  const setView = useAppStore((s) => s.setView)
  const services = servicesForRole(project, role)
  const manage = (): void => {
    setPane(project.id, PROJECT_SETTINGS_PANES.tools)
    setView('settings')
  }
  return (
    <section className="stack-2 role-services" aria-labelledby="role-services-title" data-testid="role-services">
      <h3 className="side-section-title" id="role-services-title">
        Services
      </h3>
      {services.length === 0 ? (
        <p className="hint">No services yet. Connect and grant them in project Settings &gt; Tools.</p>
      ) : (
        <ul className="role-services-list">
          {services.map((s) => (
            <li key={s.id} className="role-service" data-testid="role-service" data-name={s.label}>
              <span className="role-service-tile" style={{ ['--hue' as string]: s.hue }} aria-hidden="true">
                {s.initial}
              </span>
              <span className="role-service-name">{s.label}</span>
              {s.custom && <span className="role-service-custom">custom</span>}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button size="sm" icon={Settings2} onClick={manage} testId="role-services-manage">
          Manage in Tools
        </Button>
      </div>
    </section>
  )
}
