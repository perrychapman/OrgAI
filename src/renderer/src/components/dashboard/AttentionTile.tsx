import type { FocusEvent, ReactElement, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { isVirtualProjectId, type Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { openTeamFilesDecision } from '../../lib/menuActions'
import { displayRunName } from '../../lib/orgChange'
import { locationLabel } from '../../lib/assistants'
import { projectHue } from '../../lib/projectIdentity'
import { TILE_ROW_CAP, tileActionName, waitedLong, waitedShort, type AttentionTile as TileModel, type DecisionTile } from '../../lib/attentionTiles'
import { focusAfterRemoval, headingAfter, rowMotionProps, useAttentionList, type RowExits, type RowMotion } from './AttentionSection'
import { NeedsRow, needsItemKey, type NeedsItem } from './NeedsInline'
import { ProjectBadge } from './ProjectBadge'

/** What the section hands every tile. */
export interface TileContext {
  projects: readonly Project[]
  /** `useNow()`: the clock the waited caption reads. */
  now: number
  /** Rows that arrive after this turns true enter with `.motion-enter` (the page's arrival settle). */
  arrive: boolean
  exits: RowExits
  onAnnounce: (text: string) => void
}

const NO_ITEMS: readonly NeedsItem[] = []

/** The run's name for a decision tile: the first item's run (a team-files tile has none). */
function decisionRunName(tile: DecisionTile<NeedsItem>, projects: readonly Project[]): string {
  const first = tile.items[0]
  if (!first || first.kind === 'team') return locationLabel(tile.projectId, projects)
  return displayRunName(first.run.summary)
}

/**
 * One Waiting on you tile (docs/design/dashboard-overhaul.md 7.2, board pass): a run that needs the person.
 * Decision tiles hold the run's NeedsRow rows (inline answers exactly as built, at most `TILE_ROW_CAP`, then "+N more");
 * a reply tile holds a two-line plain-text summary of the run's last message. The tile is a `li` and never a button: its
 * quick link ("Open" / "Reply") is its own native button, and no button nests in another. Run text is rendered as React
 * text only and clipped by CSS; the full text is the `title`.
 */
export function AttentionTileView({ tile, motion, ctx }: { tile: TileModel<NeedsItem>; motion: RowMotion; ctx: TileContext }): ReactElement {
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const focusRun = useAppStore((s) => s.focusRun)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const { projects, now, arrive, exits, onAnnounce } = ctx

  // The tile's own rows: capped, with the arrival baseline and the user's exits. Its focus rules are the section's
  // (`useTileFocus`), so this model's `onFocus` / `onBlur` are not attached.
  const rowModel = useAttentionList<NeedsItem>({ items: tile.kind === 'reply' ? NO_ITEMS : tile.items, cap: TILE_ROW_CAP, itemKey: needsItemKey, arrive, exits })

  const projectName = locationLabel(tile.projectId, projects)
  const badgeProject = isVirtualProjectId(tile.projectId) ? '' : tile.projectId
  const runName = tile.kind === 'reply' ? tile.title : decisionRunName(tile, projects)
  const title = tile.kind === 'team' ? projectName : runName
  const waitedAt = tile.since
  const waited = waitedShort(waitedAt, now)
  const waitedWords = waitedLong(waitedAt, now)
  const actionName = tileActionName(tile.kind, title)
  const runId = tile.runId ?? ''

  const open = (): void => {
    if (tile.kind === 'reply') {
      void focusRun(tile.projectId, tile.runId).then(() => requestAnimationFrame(() => focusComposer()))
      return
    }
    if (tile.kind === 'team') {
      openTeamFilesDecision(tile.projectId)
      return
    }
    const first = tile.items[0]
    void jumpToDecision(tile.projectId, tile.runId as string, first && first.kind !== 'plan' ? first.key : undefined)
  }

  const hidden = rowModel.hiddenCount
  const moreName = `Open ${title}, ${hidden} more ${hidden === 1 ? 'decision' : 'decisions'}`

  return (
    <li
      {...rowMotionProps(motion, 'dash-attn-tile')}
      data-testid="dash-attn-tile"
      data-kind={tile.kind}
      data-run={runId}
      data-project={tile.projectId}
      data-hue={projectHue(badgeProject)}
      data-tile-key={tile.key}
    >
      <div className="dash-attn-head">
        <ProjectBadge projectId={badgeProject} name={projectName} size="md" />
        <span className="dash-attn-title" title={title}>
          {title}
        </span>
        {waited && (
          <span className="dash-attn-waited" data-testid="dash-attn-waited" title={waitedWords}>
            <span aria-hidden="true">{waited}</span>
            <span className="sr-only">{waitedWords}</span>
          </span>
        )}
      </div>

      {tile.kind === 'reply' ? (
        <>
          <p className="dash-attn-place" title={projectName}>
            {projectName}
          </p>
          <p className="dash-attn-summary" data-testid="dash-attn-summary" data-empty={tile.summary ? undefined : ''} title={tile.summary || undefined}>
            {tile.summary || 'Waiting for your reply.'}
          </p>
        </>
      ) : (
        <ul className="dash-attn-items">
          {rowModel.rows.map((r) => {
            const it = r.item
            const key = needsItemKey(it)
            const rowMotion: RowMotion = r.leaving ? { arrived: false, index: 0, leaving: true } : (rowModel.motionOf.get(key) as RowMotion)
            return (
              <NeedsRow
                key={key}
                item={it}
                motion={rowMotion}
                onExpectExit={(on) => {
                  // The answered row leaves by the user's action; when it was the tile's last item, the tile leaves with it.
                  if (on) exits.mark(tile.items.length === 1 ? [key, tile.key] : [key])
                  else {
                    exits.unmark(key)
                    exits.unmark(tile.key)
                  }
                }}
                projectName={it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects)}
                runName={it.kind === 'team' ? undefined : displayRunName(it.run.summary)}
                onAnnounce={onAnnounce}
                onOpen={() => (it.kind === 'team' ? openTeamFilesDecision(it.projectId) : void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key))}
              />
            )
          })}
        </ul>
      )}

      <div className="dash-attn-foot">
        {tile.kind === 'reply' ? (
          // Raw button: the shared Button carries no data-* hook, and the section's focus rule needs data-tile-main.
          <button type="button" className="btn sm" data-testid="dash-attn-open" data-tile-main="" aria-label={actionName} onClick={open}>
            Reply
          </button>
        ) : (
          <>
            {hidden > 0 && (
              <button type="button" className="btn ghost sm" data-testid="dash-attn-more" aria-label={moreName} onClick={open}>
                {`+${hidden} more`}
              </button>
            )}
            <button type="button" className="btn sm" data-testid="dash-attn-open" aria-label={actionName} onClick={open}>
              Open
            </button>
          </>
        )}
      </div>
    </li>
  )
}

const TARGET = '[data-row-main], [data-tile-main]'
const KEYED = 'li[data-row-key], li[data-tile-key]'
const isOut = (el: Element): boolean => !!el.closest('[data-state="out"]')
const keyOf = (li: Element): string => li.getAttribute('data-row-key') ?? li.getAttribute('data-tile-key') ?? ''
const targetsOf = (list: HTMLElement): HTMLElement[] => Array.from(list.querySelectorAll<HTMLElement>(TARGET)).filter((el) => !isOut(el))

/**
 * Focus rules of the tile grid (spec 12.2): when the row or tile that held focus goes away (answered inline, or its run
 * ended), focus moves to the next row's main button, else the previous one, else the next section's heading (the section
 * itself is gone by then, so its own h2 would be a dead end). Never leaves focus on body. The targets are every row's
 * main button (`data-row-main`) and a reply tile's Reply button (`data-tile-main`), in document order.
 */
export function useTileFocus(listRef: RefObject<HTMLUListElement | null>, sectionRef: RefObject<HTMLElement | null>): { onFocus: (e: FocusEvent<HTMLUListElement>) => void; onBlur: (e: FocusEvent<HTMLUListElement>) => void } {
  const last = useRef<{ key: string; index: number } | null>(null)
  const fallback = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const prev = last.current
    if (!prev) return
    const list = listRef.current
    const present = !!list && Array.from(list.querySelectorAll(KEYED)).some((li) => !isOut(li) && keyOf(li) === prev.key)
    if (present) return
    last.current = null
    const active = document.activeElement
    // Focus inside a row that is leaving counts as lost: that row is inert now.
    if (active && active !== document.body && active !== document.documentElement && !isOut(active)) return
    const targets = list ? targetsOf(list) : []
    if (targets.length > 0) targets[Math.min(prev.index, targets.length - 1)].focus({ preventScroll: true })
    else focusAfterRemoval(fallback.current)
  })

  const onFocus = (e: FocusEvent<HTMLUListElement>): void => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(KEYED)
    const list = listRef.current
    if (!li || !list || !list.contains(li)) return
    const main = li.querySelector<HTMLElement>(TARGET)
    const index = main ? targetsOf(list).indexOf(main) : 0
    last.current = { key: keyOf(li), index: Math.max(0, index) }
    fallback.current = headingAfter(sectionRef.current ?? li.closest('section'))
  }
  const onBlur = (e: FocusEvent<HTMLUListElement>): void => {
    // Focus moved to another element: forget the row. A removed row blurs with no relatedTarget and is kept.
    if (e.relatedTarget) last.current = null
  }
  return { onFocus, onBlur }
}
