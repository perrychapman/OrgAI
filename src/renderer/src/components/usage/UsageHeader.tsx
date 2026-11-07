import type { ReactElement } from 'react'
import { ClipboardCopy, Download } from 'lucide-react'
import { Button } from '../ui/Button'
import { USAGE_SUBTITLE } from '../../lib/usagePage'
import type { UsageCsv } from './useUsageCsv'

/** The topbar's right side: Copy as CSV, Save CSV... and the quiet "Updated 14:02" (not announced). */
export function UsageTopbarActions({ csv, disabled, updated, liveNote }: { csv: UsageCsv; disabled: boolean; updated: string | null; liveNote?: string | null }): ReactElement {
  return (
    <>
      {liveNote && (
        // Beside "Updated": a topbar item, so a run starting or ending moves nothing below (spec 17.5).
        <span className="usage-live-note" data-testid="usage-live-note" title={liveNote}>
          {liveNote}
        </span>
      )}
      {updated && (
        <span className="usage-updated" data-testid="usage-updated">
          {updated}
        </span>
      )}
      <Button icon={ClipboardCopy} size="sm" disabled={disabled} inert={csv.busy} onClick={() => void csv.copy()} testId="usage-copy-csv">
        Copy as CSV
      </Button>
      <Button icon={Download} size="sm" disabled={disabled} inert={csv.busy} onClick={() => void csv.save()} testId="usage-save-csv">
        Save CSV...
      </Button>
    </>
  )
}

/** Scope line, subtitle and the CSV status under the h1 (usage-header). */
export default function UsageHeader({ scope, csv }: { scope: string; csv: UsageCsv }): ReactElement {
  return (
    <header className="usage-header" data-testid="usage-header">
      <p className="usage-scopeline" data-testid="usage-scope">
        {scope}
      </p>
      <p className="usage-subtitle">{USAGE_SUBTITLE}</p>
      <p
        key={csv.status?.failed ? 'failed' : 'ok'}
        className={`usage-csv-status${csv.status?.failed ? ' failed' : ''}`}
        role={csv.status?.failed ? 'alert' : 'status'}
        data-testid="usage-csv-status"
      >
        {csv.status?.text ?? ''}
      </p>
    </header>
  )
}
