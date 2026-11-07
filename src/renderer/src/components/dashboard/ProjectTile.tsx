import type { KeyboardEvent, ReactElement } from 'react'
import { useState } from 'react'
import { ArrowRight, FolderOpen, GitBranch, MoreHorizontal, Play, RotateCcw, ShieldAlert, Sparkles, Trash2, type LucideIcon } from 'lucide-react'
import type { Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { projectKindOf } from '@shared/defaults'
import { clientOf } from '../../lib/clientGroups'
import { costView, type CostInput } from '../../lib/cost'
import { tileRemoveLabel } from '../../lib/dashboard'
import { folderName } from '../../lib/paths'
import type { StatusWord } from '../../lib/runStatus'
import { Badge } from '../ui/Badge'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { continueLabel, type TileChip, type TileChipKind } from './dashboardProjects'

/** The newest run of a project, as the tile shows it. */
export interface TileRun {
  id: string
  name: string
  /** The status word (Running, Idle, Finished ...), for `data-status`. */
  word: StatusWord
  /** "Idle · Waiting for your reply" or "Finished · 2 h ago". */
  caption: string
}

/** What one tile shows. Built by ProjectsGrid from the store; the tile itself reads nothing. */
export interface TileModel {
  project: Project
  /** Open decisions across the project's runs. */
  decisions: number
  /** Runs that are open (starting, running, idle, stopping). */
  live: number
  /** A run is working now (not merely open): the tile gets its working edge. */
  working: boolean
  /** projectStatus subtitle, or "No runs yet". */
  statusLine: string
  /** The newest run, or null without runs. */
  newest: TileRun | null
  /** The chain's newest member when it can be continued. */
  continuable: { id: string; name: string } | null
  chips: TileChip[]
  /** Cost of runs started in the last 7 days. */
  weekCost: CostInput
}

const CHIP_ICON: Record<TileChipKind, LucideIcon> = { branches: GitBranch, suggestions: Sparkles, 'folder-trust': ShieldAlert }

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
 * One project on the Dashboard (docs/design/dashboard-2.md 10.1). The name is a native button whose ::after covers the
 * whole tile (the tile is one click target); More and the chips sit above that cover, never over the text.
 */
export function ProjectTile({
  model,
  onOpen,
  onDelete,
  onNewRun,
  onContinue,
  onChip,
  onAnnounce
}: {
  model: TileModel
  onOpen: () => void
  onDelete: () => void
  onNewRun: () => void
  onContinue: (runId: string) => void
  onChip: (kind: TileChipKind) => void
  onAnnounce?: (text: string) => void
}): ReactElement {
  const { project, decisions, working, statusLine, newest, continuable, chips, weekCost } = model
  const [error, setError] = useState<string | null>(null)
  const folder = folderName(project.path)
  const client = projectKindOf(project) === 'engagement' ? clientOf(project) : ''
  const pending = setupPending(project)
  const state = decisions > 0 ? 'decisions' : working ? 'live' : 'quiet'
  const costShown = !costView(weekCost).empty

  const openFolder = (): void => {
    setError(null)
    window.orgai.app
      .openPath(project.path)
      .then((err) => {
        if (!err) return
        setError(err)
        onAnnounce?.(err)
      })
      .catch(() => {
        const text = 'OrgAI could not open the folder.'
        setError(text)
        onAnnounce?.(text)
      })
  }

  return (
    <li className="project-tile" data-testid="project-tile" data-name={project.name} data-id={project.id} data-state={state}>
      {client && (
        <p className="project-tile-client" data-testid="tile-client" title={client}>
          {client}
        </p>
      )}
      <div className="project-tile-head">
        <h3 className="project-tile-title">
          <button
            type="button"
            className="project-tile-main"
            data-testid="project-tile-main"
            aria-label={`Open ${project.name}, ${statusLine}${newest ? `, ${newest.name}` : ''}${pending ? ', setup pending' : ''}`}
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
                  data-testid="project-tile-new-run"
                  onClick={() => {
                    close()
                    onNewRun()
                  }}
                >
                  <Icon icon={Play} size="sm" />
                  New run
                </button>
                {continuable && (
                  <button
                    type="button"
                    role="menuitem"
                    className="project-tile-menuitem"
                    data-testid="project-tile-continue"
                    title={continuable.name}
                    onClick={() => {
                      close()
                      onContinue(continuable.id)
                    }}
                  >
                    <Icon icon={RotateCcw} size="sm" />
                    {continueLabel(continuable.name)}
                  </button>
                )}
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
                  {tileRemoveLabel(projectKindOf(project))}
                </button>
              </div>
            )}
          </Popover>
        </div>
      </div>
      <p className="project-tile-status">
        <span className={`project-tile-dot ${state}`} aria-hidden="true" />
        <span className="project-tile-status-text">{statusLine}</span>
        {pending && <Badge tone="warning">Setup pending</Badge>}
      </p>
      {newest && (
        <div className="project-tile-run" data-testid="tile-run" data-status={newest.word}>
          <span className="project-tile-run-name" title={newest.name}>
            {newest.name}
          </span>
          <span className="project-tile-run-cap">{newest.caption}</span>
        </div>
      )}
      {chips.length > 0 && (
        <div className="tile-chips" data-testid="tile-chips">
          {chips.map((c) => (
            <button key={c.kind} type="button" className="tile-chip" data-testid="tile-chip" data-kind={c.kind} aria-label={c.name} onClick={() => onChip(c.kind)}>
              <Icon icon={CHIP_ICON[c.kind]} size="sm" />
              {c.text}
            </button>
          ))}
        </div>
      )}
      <p className="project-tile-foot">
        <span className="project-tile-folder" data-testid="tile-folder" title={project.path}>
          {folder}
        </span>
        {costShown && (
          <span className="project-tile-cost" data-testid="tile-cost">
            <Cost value={weekCost} compact /> <span className="project-tile-cost-unit">last 7 days</span>
          </span>
        )}
      </p>
      {error && (
        <p className="project-tile-error" data-testid="project-tile-error">
          {error}
        </p>
      )}
    </li>
  )
}
