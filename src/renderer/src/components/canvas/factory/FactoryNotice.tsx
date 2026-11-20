// The Factory Floor's fallback banners (docs/design/factory-floor.md section 8), exact copy, through the shared Banner.
import type { ReactElement } from 'react'
import { Banner } from '../../ui/Banner'
import { Button } from '../../ui/Button'

export type FactoryNoticeKind = 'no-webgl2' | 'chunk-failed' | 'lost' | 'third-loss' | 'too-many'

export interface FactoryNoticeProps {
  kind: FactoryNoticeKind
  /** Current-session agents (the large-team copy). */
  count: number
  onUseGraph(): void
  onRetry(): void
  /** Only the no-WebGL2 notice is dismissible (for the session). */
  onDismiss?(): void
}

const COPY: Record<FactoryNoticeKind, { tone: 'info' | 'warning'; title: string; body: (n: number) => string; retry: boolean }> = {
  'no-webgl2': {
    tone: 'info',
    title: '3D view unavailable',
    body: () => 'This computer did not give OrgAI WebGL 2, so the factory is shown as a floor plan.',
    retry: false
  },
  'chunk-failed': {
    tone: 'warning',
    title: '3D view did not load',
    body: () => 'OrgAI could not load the 3D renderer. Showing the floor plan.',
    retry: true
  },
  lost: {
    tone: 'warning',
    title: '3D view stopped',
    body: () => 'The graphics context was lost and did not come back. Showing the floor plan.',
    retry: true
  },
  'third-loss': {
    tone: 'warning',
    title: '3D view stopped',
    body: () => 'The 3D view stopped 3 times, so OrgAI switched to the floor plan for this session.',
    retry: true
  },
  'too-many': {
    tone: 'info',
    title: 'Large team',
    body: (n) => `This team has ${n} agents. The 3D floor shows up to 120, so the floor plan is shown.`,
    retry: false
  }
}

export function FactoryNotice({ kind, count, onUseGraph, onRetry, onDismiss }: FactoryNoticeProps): ReactElement {
  const copy = COPY[kind]
  return (
    <div className="factory-notice" data-testid="factory-notice" data-notice={kind}>
      <Banner
        tone={copy.tone}
        title={copy.title}
        onDismiss={kind === 'no-webgl2' ? onDismiss : undefined}
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
        {copy.body(count)}
      </Banner>
    </div>
  )
}
