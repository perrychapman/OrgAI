import type { CSSProperties, ReactElement } from 'react'
import type { ProjectShare, ShareSegment } from '../../lib/projectShare'
import { ProjectBadge } from './ProjectBadge'

/**
 * Runs by project this week (the visual pass of Your week): one stacked bar, one segment per project in its identity hue,
 * a 2 px surface gap between segments (so neighbours separate by more than hue), then a legend of dot, name and figure.
 * The bar and the legend are decorative; the sentence from `projectShare` (the same function that built the segments) is
 * the text alternative. Nothing here animates.
 */

function Dot({ seg }: { seg: ShareSegment }): ReactElement {
  if (seg.kind === 'project') return <ProjectBadge projectId={seg.id} name={seg.name} size="xs" />
  return <span className="dash-share-dot" data-kind={seg.kind} aria-hidden="true" />
}

export function WeekShare({ share }: { share: ProjectShare }): ReactElement | null {
  if (!share.show) return null
  return (
    <div className="dash-week-share" data-testid="dash-week-share" data-count={share.segments.length}>
      <div className="dash-share-bar" aria-hidden="true">
        {share.segments.map((s) => (
          <span
            key={s.id}
            className="dash-share-seg"
            data-testid="dash-week-share-seg"
            data-kind={s.kind}
            data-hue={s.hue}
            data-runs={s.runs}
            data-pct={s.pct}
            style={{ flexGrow: s.runs } as CSSProperties}
          />
        ))}
      </div>
      <ul className="dash-share-legend" aria-hidden="true">
        {share.segments.map((s) => (
          <li key={s.id} className="dash-share-item" data-testid="dash-week-share-item" data-kind={s.kind} title={`${s.name}: ${s.runs} ${s.runs === 1 ? 'run' : 'runs'}, ${s.pct}%`}>
            <Dot seg={s} />
            <span className="dash-share-name">{s.name}</span>
            <span className="dash-num dash-share-figure">{s.runs}</span>
          </li>
        ))}
      </ul>
      <p className="sr-only" data-testid="dash-week-share-text">
        {share.text}
      </p>
    </div>
  )
}
