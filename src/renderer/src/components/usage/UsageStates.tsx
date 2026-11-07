import type { ReactElement } from 'react'
import { ChartColumn } from 'lucide-react'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import type { EmptyModel } from '../../lib/usagePage'

/** No run has ever spent tokens: the whole page is this (11). Filters are hidden. */
export function EmptyAll({ onDashboard }: { onDashboard: () => void }): ReactElement {
  return (
    <EmptyState
      icon={ChartColumn}
      title="No usage yet"
      description="Usage appears here once a run has spent tokens. Start a run in any project."
      actions={
        <Button variant="primary" onClick={onDashboard} testId="usage-empty-all-dashboard">
          Go to Dashboard
        </Button>
      }
      testId="usage-empty-all"
    />
  )
}

/** Runs exist, none under the filters (11): the cause, then the way out. The filter bar and chips stay. */
export function EmptyFiltered({ model, onClear, onUseThirtyDays }: { model: EmptyModel; onClear: () => void; onUseThirtyDays: () => void }): ReactElement {
  return (
    <EmptyState
      icon={ChartColumn}
      compact
      title={model.title}
      description={model.description}
      testId="usage-empty"
      actions={
        <>
          {model.canClear && (
            <Button onClick={onClear} testId="usage-empty-clear">
              Clear all filters
            </Button>
          )}
          {model.canUseThirtyDays && (
            <Button onClick={onUseThirtyDays} testId="usage-empty-30">
              Use 30 days
            </Button>
          )}
        </>
      }
    />
  )
}

/** A load that failed with nothing to show: a danger banner in place of the panels (10). */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <Banner
      tone="danger"
      title="Could not load usage"
      testId="usage-error"
      actions={
        <Button size="sm" onClick={onRetry} testId="usage-retry">
          Retry
        </Button>
      }
    >
      {message}
    </Banner>
  )
}

/** A refetch failed while data is on screen: the data stays and a warning says how old it is. */
export function RefreshFailed({ text, onRetry }: { text: string; onRetry: () => void }): ReactElement {
  return (
    <Banner
      tone="warning"
      testId="usage-refresh-failed"
      actions={
        <Button size="sm" onClick={onRetry} testId="usage-refresh-retry">
          Retry
        </Button>
      }
    >
      {text}
    </Banner>
  )
}

/** First-load placeholders at the heights of the loaded page, so nothing moves when data arrives. */
export function LoadingSkeleton(): ReactElement {
  return (
    <div className="usage-skeleton" aria-hidden="true" data-testid="usage-skeleton">
      <div className="skeleton usage-sk-summary" />
      <div className="skeleton usage-sk-spend" />
      <div className="usage-where">
        <div className="skeleton usage-sk-where" />
        <div className="skeleton usage-sk-where" />
        <div className="skeleton usage-sk-where" />
      </div>
      <div className="skeleton usage-sk-eff" />
      <div className="skeleton usage-sk-table" />
    </div>
  )
}
