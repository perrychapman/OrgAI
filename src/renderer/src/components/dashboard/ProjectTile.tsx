import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, GitBranch, Pin, PinOff, Play, RotateCcw, ShieldAlert, Sparkles, Trash2, type LucideIcon } from 'lucide-react'
import type { Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { projectKindOf } from '@shared/defaults'
import { clientOf } from '../../lib/clientGroups'
import { costView, type CostInput } from '../../lib/cost'
import { tileRemoveLabel } from '../../lib/dashboard'
import { folderName } from '../../lib/paths'
import { PIN_LIMIT } from '../../lib/dashboardLayout'
import { tokenMs } from '../../lib/useExitPresence'
import { Badge } from '../ui/Badge'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { ContextMenu, MenuButton, useContextMenu, type MenuEntry } from '../ui/ContextMenu'
import { projectHue } from '../../lib/projectIdentity'
import { SPARK_BAR_PX, SPARK_TRACK_PX, type Spark } from '../../lib/projectSparkline'
import { ProjectBadge } from './ProjectBadge'
import { continueLabel, openLabel, type TileChip, type TileChipKind, type TileStatusKind, type TileTeam } from './dashboardProjects'

/** Which control of a tile asked for the pin change, so focus can be put back on it. */
export type PinSource = 'button' | 'menu'

/** What one tile shows. Built by ProjectsGrid from the store; the tile itself reads nothing. */
export interface TileModel {
  project: Project
  /** Open decisions across the project's runs. */
  decisions: number
  /** Runs that are open (starting, running, idle, stopping). */
  live: number
  /** A run is working now (not merely open): the tile gets its working edge. */
  working: boolean
  /** `tileStatusLine`: one fact, plain text. */
  statusLine: string
  /** Which mark shape the status gets (`tileStatusKind`). */
  statusKind: TileStatusKind
  /** The 7-day runs sparkline of this project (`projectSpark`). */
  spark: Spark
  /** The org chart as the team row draws it. */
  team: TileTeam
  /** The person pinned this project. */
  pinned: boolean
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
  index = 0,
  onOpen,
  onDelete,
  onNewRun,
  onContinue,
  onChip,
  onAnnounce,
  customising = false,
  pinFull = false,
  ring = 0,
  onTogglePin
}: {
  model: TileModel
  /** The tile rises in: the page is arriving, or the tile appeared after first paint (create, clone). */
  enter?: boolean
  /** Its place in the grid, for the arrival stagger (the CSS caps it at six steps). */
  index?: number
  /** Customise mode (the pin toggle is always drawn now; kept so the tile can say it in `data-customising`). */
  customising?: boolean
  /** The pin limit is reached, so an unpinned tile cannot be pinned from the menu. */
  pinFull?: boolean
  /** Rises on every pin of this tile; each rise plays one ring in the new place (0: none). */
  ring?: number
  onTogglePin?: (source: PinSource) => void
  onOpen: () => void
  onDelete: () => void
  onNewRun: () => void
  onContinue: (runId: string) => void
  onChip: (kind: TileChipKind) => void
  onAnnounce?: (text: string) => void
}): ReactElement {
  const { project, decisions, working, statusLine, statusKind, spark, team, pinned, continuable, chips, weekCost } = model
  const descId = useId()
  const rootRef = useRef<HTMLLIElement>(null)
  // One ring per pin, restarted on a second pin; the class goes away when it ends. Reduced motion never mounts it.
  useEffect(() => {
    const el = rootRef.current
    if (!ring || !el || tokenMs('--dur-slow') < 1) return undefined
    el.classList.remove('motion-ring')
    void el.offsetWidth
    el.classList.add('motion-ring')
    const done = window.setTimeout(() => el.classList.remove('motion-ring'), tokenMs('--dur-slow') * 2.3 + 50)
    return () => window.clearTimeout(done)
  }, [ring])
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
    {
      id: 'pin',
      label: pinned ? 'Unpin' : 'Pin to top',
      icon: pinned ? PinOff : Pin,
      testId: 'project-tile-pin-item',
      disabled: !pinned && pinFull,
      disabledReason: !pinned && pinFull ? `You can pin up to ${PIN_LIMIT} projects.` : undefined,
      onSelect: () => onTogglePin?.('menu')
    },
    'separator',
    { id: 'delete', label: tileRemoveLabel(projectKindOf(project)), icon: Trash2, destructive: true, testId: 'project-tile-delete', onSelect: onDelete }
  ]

  return (
    <li
      className={enter ? 'project-tile motion-enter' : 'project-tile'}
      style={enter ? ({ '--i': index } as CSSProperties) : undefined}
      data-testid="project-tile"
      data-name={project.name}
      data-id={project.id}
      data-state={state}
      data-hue={projectHue(project.id)}
      data-pinned={pinned ? '' : undefined}
      data-customising={customising ? '' : undefined}
      ref={rootRef}
      onContextMenu={(e) => menu.onContextMenu(e, project.id, { invoker: mainRef.current ?? undefined })}
    >
      <div className="project-tile-top">
        <ProjectBadge projectId={project.id} name={project.name} size="md" className="project-tile-badge" />
        <div className="project-tile-id">
          <h3 className="project-tile-title">
            <button
              type="button"
              className="project-tile-main"
              data-testid="project-tile-main"
              aria-label={openLabel({ name: project.name, statusLine, team, pinned, setupPending: pending })}
              aria-describedby={descId}
              title={`${project.name}\n${project.path}`}
              ref={mainRef}
              onClick={onOpen}
              onKeyDown={(e) => void menu.onKeyDown(e, project.id)}
            >
              <span className="project-tile-name">{project.name}</span>
            </button>
          </h3>
          {/* The one meta line: a mark whose shape follows the state, its words, and the client of an engagement. */}
          <p className="project-tile-status" data-kind={statusKind}>
            <span className="tile-mark" data-kind={statusKind} aria-hidden="true" />
            <span className="project-tile-status-text">{statusLine}</span>
            {pending && <Badge>Setup pending</Badge>}
            {client && (
              <span className="project-tile-client" data-testid="tile-client" title={client}>
                {client}
              </span>
            )}
          </p>
        </div>
      </div>
      {/* The pin is its own button, right after the Open button in the tab order; it sits above the tile's cover. A pressed
          toggle keeps one name and says its state with aria-pressed. */}
      <button
        type="button"
        className="icon-btn size-sm project-tile-pin"
        data-testid="project-tile-pin"
        aria-pressed={pinned}
        aria-label={`Pin ${project.name}`}
        title={pinned ? `Unpin ${project.name}` : pinFull ? `You can pin up to ${PIN_LIMIT} projects.` : `Pin ${project.name} to the top`}
        onClick={() => onTogglePin?.('button')}
      >
        <Icon icon={pinned ? PinOff : Pin} size="sm" />
      </button>
      <div className="project-tile-spark">
        <svg
          className="tile-spark"
          data-testid="tile-spark"
          data-total={spark.total}
          role="img"
          aria-label={spark.label}
          width={spark.width}
          height={spark.height}
          viewBox={`0 0 ${spark.width} ${spark.height}`}
          focusable="false"
        >
          <line className="tile-spark-base" x1={0} x2={spark.width} y1={SPARK_TRACK_PX + 0.5} y2={SPARK_TRACK_PX + 0.5} />
          {spark.days.map((d) => (
            <g key={d.key} data-day={d.key} data-runs={d.runs} data-today={d.today ? '' : undefined}>
              {d.height > 0 && <rect className="tile-spark-bar" x={d.x} y={SPARK_TRACK_PX - d.height} width={SPARK_BAR_PX} height={d.height} rx={1} />}
              {d.today && <rect className="tile-spark-today" x={d.x} y={SPARK_TRACK_PX + 3} width={SPARK_BAR_PX} height={2} rx={1} />}
            </g>
          ))}
        </svg>
        <span className="project-tile-runs" aria-hidden="true" data-empty={spark.total === 0 ? '' : undefined}>
          <span className="project-tile-runs-n">{spark.total}</span> {spark.total === 1 ? 'run' : 'runs'}
        </span>
      </div>
      {(team.marks.length > 0 || chips.length > 0) && (
        <div className="project-tile-foot">
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
          {chips.length > 0 && (
            <div className="tile-chips" data-testid="tile-chips">
              {chips.map((c) => (
                <button key={c.kind} type="button" className="tile-chip" data-testid="tile-chip" data-kind={c.kind} aria-label={c.name} title={c.text} onClick={() => onChip(c.kind)}>
                  <Icon icon={CHIP_ICON[c.kind]} size="sm" />
                  {c.count !== null && <span className="tile-chip-n">{c.count}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* The folder and the week's cost are not drawn: they are the Open button's description, read after its name. */}
      <span id={descId} className="sr-only">
        Folder{' '}
        <span data-testid="tile-folder" title={project.path}>
          {folder}
        </span>
        {costShown && (
          <span data-testid="tile-cost">
            . Cost <Cost value={weekCost} compact labelled /> in the last 7 days
          </span>
        )}
      </span>
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
