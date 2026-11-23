import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import AppSettingsView from './AppSettingsView'

/**
 * A project's Settings tab: the one Settings view (App and project panes in one menu, ui-overhaul settings boards),
 * embedded under the project's topbar and opening on the project's remembered pane. Picking an App entry shows that
 * pane here too; nothing navigates away.
 */
export default function SettingsView({ project }: { project: Project }): ReactElement {
  return (
    <div className="editor single">
      <AppSettingsView project={project} />
    </div>
  )
}
