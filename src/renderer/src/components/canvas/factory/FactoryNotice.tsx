// The Factory Floor's fallback banners (docs/design/factory-floor.md section 8), through the shared Banner. The exact
// copy and which notice shows live in lib/factory/fallback.ts (unit tested).
import type { ReactElement } from 'react'
import { Banner } from '../../ui/Banner'
import { Button } from '../../ui/Button'
import { noticeCopy, type FactoryNoticeKind } from '../../../lib/factory/fallback'

export type { FactoryNoticeKind } from '../../../lib/factory/fallback'

export interface FactoryNoticeProps {
  kind: FactoryNoticeKind
  /** Current-session agents (the large-team copy). */
  count: number
  onUseGraph(): void
  onRetry(): void
  /** Only the no-WebGL2 notice is dismissible (for the session). */
  onDismiss?(): void
}

export function FactoryNotice({ kind, count, onUseGraph, onRetry, onDismiss }: FactoryNoticeProps): ReactElement {
  const copy = noticeCopy(kind, count)
  return (
    <div className="factory-notice" data-testid="factory-notice" data-notice={kind}>
      <Banner
        tone={copy.tone}
        title={copy.title}
        onDismiss={copy.dismissible ? onDismiss : undefined}
        actions={
          <>
            {copy.retry && (
              <Button size="sm" testId="factory-retry-3d" onClick={onRetry}>
                Try 3D again
              </Button>
            )}
            <Button size="sm" testId="factory-use-graph" onClick={onUseGraph}>
              Use Graph
            </Button>
          </>
        }
      >
        {copy.body}
      </Banner>
    </div>
  )
}
