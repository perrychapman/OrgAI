import type { ReactElement } from 'react'
import { Settings2 } from 'lucide-react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { PROJECT_SETTINGS_PANES } from '../../lib/settingsTarget'
import { Button } from '../ui/Button'

/**
 * Catalog tab of the Team panel: every skill, connection and plugin of the project with a "Used by" view.
 * Stub slot, filled by Brief 2b. Until then it lists names read-only and points at project Settings.
 * `onSelectRole` is for the "Used by" chips (selects the role and switches to the Role tab).
 */
export default function TeamCatalog({ project }: { project: Project; onSelectRole?: (roleId: string) => void }): ReactElement {
  const setPane = useAppStore((s) => s.setProjectSettingsPane)
  const setView = useAppStore((s) => s.setView)
  const groups: { id: string; title: string; names: string[]; empty: string }[] = [
    { id: 'skills', title: 'Skills', names: (project.skills ?? []).map((s) => s.name), empty: 'No skills yet.' },
    { id: 'connections', title: 'Connections', names: (project.mcpServers ?? []).map((s) => s.name || s.id), empty: 'No connections yet.' },
    { id: 'plugins', title: 'Plugins', names: (project.plugins ?? []).map((p) => p.name || p.id), empty: 'No plugins yet.' }
  ]
  return (
    <div className="side-body stack-3 team-catalog" data-testid="team-catalog">
      <p className="hint">What the whole team can draw on. Open a role to choose what it uses.</p>
      {groups.map((g) => (
        <section key={g.id} className="stack-2" aria-labelledby={`catalog-${g.id}-title`} data-testid={`catalog-${g.id}`}>
          <h3 className="side-section-title" id={`catalog-${g.id}-title`}>
            {g.title}
            <span className="muted"> {'·'} {g.names.length}</span>
          </h3>
          {g.names.length === 0 ? (
            <p className="hint">{g.empty}</p>
          ) : (
            <ul className="team-catalog-list">
              {g.names.map((n, i) => (
                <li key={`${n}-${i}`}>{n}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <div>
        <Button
          size="sm"
          icon={Settings2}
          onClick={() => {
            setPane(project.id, PROJECT_SETTINGS_PANES.tools)
            setView('settings')
          }}
          testId="catalog-manage"
        >
          Manage in project settings
        </Button>
      </div>
    </div>
  )
}
