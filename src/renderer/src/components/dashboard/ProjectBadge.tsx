import type { ReactElement } from 'react'
import { projectHue, projectMonogram } from '../../lib/projectIdentity'

export type ProjectBadgeSize = 'xs' | 'sm' | 'md' | 'lg'

/**
 * A project's identity badge (docs/design/dashboard-overhaul.md "Visual pass"): its monogram on its identity hue, the same
 * in every Dashboard section. Decorative (`aria-hidden`): the project's name is always in text or in the accessible name
 * of the control beside it, so colour and monogram are never the only signal. `projectId` empty (Chat) draws the neutral
 * badge with `chatLabel`'s monogram.
 *
 * Size xs is a 10 px dot with no letters (inside dense lines); sm 20 px, md 28 px, lg 36 px squares with rounded corners.
 */
export function ProjectBadge({ projectId, name, size = 'sm', className }: { projectId: string | null | undefined; name: string; size?: ProjectBadgeSize; className?: string }): ReactElement {
  const hue = projectHue(projectId)
  return (
    <span
      className={className ? `dash-pbadge ${className}` : 'dash-pbadge'}
      data-testid="dash-project-badge"
      data-project={projectId ?? ''}
      data-hue={hue}
      data-size={size}
      aria-hidden="true"
      title={size === 'xs' ? undefined : name}
    >
      {size === 'xs' ? null : projectMonogram(name)}
    </span>
  )
}
