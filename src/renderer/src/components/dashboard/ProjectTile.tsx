import type { KeyboardEvent, ReactElement } from 'react'
import { useState } from 'react'
import { ArrowRight, FolderOpen, MoreHorizontal, Trash2 } from 'lucide-react'
import type { Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { costView, type CostInput } from '../../lib/cost'
import { folderName } from '../../lib/paths'
import { Badge } from '../ui/Badge'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { plural } from './dashboardProjects'

/** What one tile shows. Built by ProjectsGrid from the store; the tile itself reads nothing. */
export interface TileModel {
  project: Project
  /** Open decisions across the project's runs. */
  decisions: number
  /** Live runs. */
  live: number
  /** projectStatus subtitle, or "No runs yet". */
  statusLine: string
  /** The newest run's name, or null without runs. */
  newestRun: string | null
  /** Cost of runs started in the last 7 days. */
  weekCost: CostInput
}

/** Arrow keys, Home and End move between the menu's items (the Popover focuses the first one on open). */
function onMenuKey(e: KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)'))
  if (items.length === 0) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length
  items[next]?.focus()
}

/**
 * One project on the Dashboard. The name is a native button whose ::after covers the whole tile (the tile is one
 * click target); the More button sits in the tile's own grid above that cover, never over the text.
 */
export function ProjectTile({ model, onOpen, onDelete }: { model: TileModel; onOpen: () => void; onDelete: () => void }): ReactElement {
  const { project, decisions, live, statusLine, newestRun, weekCost } = model
  const [error, setError] = useState<string | null>(null)
  const folder = folderName(project.path)
  const pending = setupPending(project)
  const state = decisions > 0 ? 'decisions' : live > 0 ? 'live' : 'quiet'
  const roles = project.roles.length
  const costShown = !costView(weekCost).empty

  const openFolder = (): void => {
    setError(null)
    window.orgai.app
      .openPath(project.path)
      .then((err) => {
        if (err) setError(err)
      })
      .catch(() => setError('OrgAI could not open the folder.'))
  }

  return (
    <li className="project-tile" data-testid="project-tile" data-name={project.name} data-id={project.id} data-state={state}>
      <div className="project-tile-head">
        <h3 className="project-tile-title">
          <button
            type="button"
            className="project-tile-main"
            data-testid="project-tile-main"
            aria-label={`Open ${project.name}, ${folder}, ${statusLine}${pending ? ', setup pending' : ''}`}
            title={project.path}
            onClick={onOpen}
          >
            <span className="project-tile-name">{project.name}</span>
          </button>
        </h3>
        <div className="project-tile-more">
          <Popover
            trigger={<Icon icon={MoreHorizontal} size="sm" />}
            triggerClassName="icon-btn size-sm"
            triggerLabel={`More actions for ${project.name}`}
            triggerTitle={`More actions for ${project.name}`}
            triggerTestId="project-tile-more"
            label={`Actions for ${project.name}`}
            role="menu"
            placement="bottom-end"
          >
            {({ close }) => (
              <div className="project-tile-menu" role="presentation" onKeyDown={onMenuKey}>
                <button
                  type="button"
                  role="menuitem"
                  className="project-tile-menuitem"
                  onClick={() => {
                    close()
                    onOpen()
                  }}
                >
                  <Icon icon={ArrowRight} size="sm" />
                  Open
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="project-tile-menuitem"
                  data-testid="project-tile-open-folder"
                  onClick={() => {
                    close()
                    openFolder()
                  }}
                >
                  <Icon icon={FolderOpen} size="sm" />
                  Open folder
                </button>
                <hr className="project-tile-menusep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="project-tile-menuitem danger"
                  data-testid="project-tile-delete"
                  onClick={() => {
                    close()
                    onDelete()
                  }}
                >
                  <Icon icon={Trash2} size="sm" />
                  Delete project…
                </button>
              </div>
            )}
          </Popover>
        </div>
      </div>
      <p className="project-tile-status">
        <span className={`project-tile-dot ${state}`} aria-hidden="true" />
        <span>{statusLine}</span>
        {pending && <Badge tone="warning">Setup pending</Badge>}
      </p>
      <p className="project-tile-folder" title={project.path}>
        {folder}
      </p>
      {newestRun && <p className="project-tile-run">{newestRun}</p>}
      <p className="project-tile-foot">
        <span>{plural(roles, 'role', 'roles')}</span>
        {costShown && (
          <span className="project-tile-cost">
            <Cost value={weekCost} /> <span className="project-tile-cost-unit">7 d</span>
          </span>
        )}
      </p>
      {error && (
        <p className="project-tile-error" data-testid="project-tile-error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
