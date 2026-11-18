import type { CSSProperties, ReactElement } from 'react'
import { useRef, useState } from 'react'
import { ArrowRight, FolderOpen, GitBranch, Play, RotateCcw, ShieldAlert, Sparkles, Trash2, type LucideIcon } from 'lucide-react'
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
import { ContextMenu, MenuButton, useContextMenu, type MenuEntry } from '../ui/ContextMenu'
import { continueLabel, openLabel, statusParts, type TileCaption, type TileChip, type TileChipKind, type TileTeam } from './dashboardProjects'

/** The newest run of a project, as the tile shows it. */
export interface TileRun {
  id: string
  name: string
  /** The status word (Running, Idle, Finished ...), for `data-status`. */
  word: StatusWord
  /** "Needs you · Allow: Run npm test", "Running · <plan step>" or the outcome of an ended run. */
  caption: TileCaption
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
  /** `tileStatusLine`: the decisions and runs, "Last run 9 d ago", or "No runs yet". */
  statusLine: string
  /** The org chart as the team row draws it. */
  team: TileTeam
  /** The newest run, or null without runs. */
  newest: TileRun | null
  /** The chain's newest member when it can be continued. */
  continuable: { id: string; name: string } | null
  chips: TileChip[]
  /** Cost of runs started in the last 7 days. */
  weekCost: CostInput
}

const CHIP_ICON: Record<TileChipKind, LucideIcon> = { branches: GitBranch, suggestions: Sparkles, 'folder-trust': ShieldAlert }

/**
 * One project on the Dashboard (docs/design/dashboard-2.md 10.1). The name is a native button whose ::after covers the
 * whole tile (the tile is one click target); More and the chips sit above that cover, never over the text.
 */
export function ProjectTile({
  model,
  enter,
  onOpen,
  onDelete,
  onNewRun,
  onContinue,
  onChip,
  onAnnounce
}: {
  model: TileModel
  /** The tile appeared after first paint (create, clone). */
  enter?: boolean
  onOpen: () => void
  onDelete: () => void
  onNewRun: () => void
  onContinue: (runId: string) => void
  onChip: (kind: TileChipKind) => void
  onAnnounce?: (text: string) => void
}): ReactElement {
  const { project, decisions, working, statusLine, team, newest, continuable, chips, weekCost } = model
  const parts = statusParts(statusLine, decisions)
  const [error, setError] = useState<string | null>(null)
  const folder = folderName(project.path)
  const client = projectKindOf(project) === 'engagement' ? clientOf(project) : ''
  const pending = setupPending(project)
  const state = decisions > 0 ? 'decisions' : working ? 'live' : 'quiet'
  // Only when something was spent (spec 10.1): a reported $0 shows nothing; an unknown cost says so (review L4).
  const weekView = costView(weekCost)
  const costShown = !weekView.empty && !(weekView.kind === 'known' && weekCost.costUsd === 0)

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

  // The More menu (components/ui/ContextMenu.tsx): the visible More button, a right click anywhere on the tile, and the
  // Menu key or Shift+F10 on the tile's Open button all open it. Focus returns to the element that opened it.
  const menu = useContextMenu<string>()
  const mainRef = useRef<HTMLButtonElement>(null)
  const menuItems = (): MenuEntry[] => [
    { id: 'open', label: 'Open', icon: ArrowRight, testId: 'project-tile-open', onSelect: onOpen },
    { id: 'new-run', label: 'New run', icon: Play, testId: 'project-tile-new-run', onSelect: onNewRun },
    ...(continuable ? [{ id: 'continue', label: continueLabel(continuable.name), icon: RotateCcw, title: continuable.name, testId: 'project-tile-continue', onSelect: () => onContinue(continuable.id) }] : []),
    { id: 'open-folder', label: 'Open folder', icon: FolderOpen, testId: 'project-tile-open-folder', onSelect: openFolder },
    'separator',
    { id: 'delete', label: tileRemoveLabel(projectKindOf(project)), icon: Trash2, destructive: true, testId: 'project-tile-delete', onSelect: onDelete }
  ]

  return (
    <li
      className={enter ? 'project-tile motion-enter' : 'project-tile'}
      data-testid="project-tile"
      data-name={project.name}
      data-id={project.id}
      data-state={state}
      onContextMenu={(e) => menu.onContextMenu(e, project.id, { invoker: mainRef.current ?? undefined })}
    >
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
            aria-label={openLabel({ name: project.name, statusLine, team, newestName: newest?.name, setupPending: pending })}
            title={project.path}
            ref={mainRef}
            onClick={onOpen}
            onKeyDown={(e) => void menu.onKeyDown(e, project.id)}
          >
            <span className="project-tile-name">{project.name}</span>
          </button>
        </h3>
      </div>
      {team.marks.length > 0 && (
        <div className="tile-team" data-testid="tile-team" aria-hidden="true" data-count={team.total}>
          <span className="tile-team-marks" data-line={team.marks.length > 1 ? '' : undefined} style={{ '--tile-team-line': team.marks[0].color } as CSSProperties}>
            {team.marks.map((m, i) => (
              <span key={m.id} className={i === 0 ? 'tile-team-root' : 'tile-team-mark'} style={{ '--role': m.color } as CSSProperties} />
            ))}
          </span>
          {team.more > 0 && (
            <span className="tile-team-more" data-testid="tile-team-more">
              +{team.more}
            </span>
          )}
        </div>
      )}
      <p className="project-tile-status">
        <span className={`project-tile-dot ${state}`} aria-hidden="true" />
        <span className="project-tile-status-text">
          {parts.decision ? <span className="project-tile-decisions">{parts.decision}</span> : null}
          {parts.rest}
        </span>
        {pending && <Badge tone="warning">Setup pending</Badge>}
      </p>
      {newest && (
        <div className="project-tile-run" data-testid="tile-run" data-status={newest.word}>
          <span className="project-tile-run-name" title={newest.name}>
            {newest.name}
          </span>
          <span className="project-tile-run-cap">
            {newest.caption.lead ? <span className="project-tile-run-lead">{newest.caption.lead}</span> : null}
            {newest.caption.lead ? ' · ' : ''}
            {newest.caption.text}
          </span>
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
            <Cost value={weekCost} compact labelled /> <span className="project-tile-cost-unit">last 7 days</span>
          </span>
        )}
      </p>
      {error && (
        <p className="project-tile-error" data-testid="project-tile-error">
          {error}
        </p>
      )}
      {/* Last in the DOM so the tab order is Open, chips, More; placed top right by the CSS. */}
      <div className="project-tile-more">
        <MenuButton control={menu} target={project.id} label={`More actions for ${project.name}`} testId="project-tile-more" />
      </div>
      <ContextMenu control={menu} label={`Actions for ${project.name}`} items={menuItems} testId="project-tile-menu" />
    </li>
  )
}
