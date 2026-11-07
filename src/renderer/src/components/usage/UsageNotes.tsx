import type { ReactElement } from 'react'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import type { DataNotes } from '../../lib/usagePage'

/** The truncation banner under the chips (10): warning, with "Use 30 days" when the span is longer. */
export function TruncatedBanner({ note, onUseThirtyDays }: { note: NonNullable<DataNotes['truncated']>; onUseThirtyDays: () => void }): ReactElement {
  return (
    <Banner
      tone="warning"
      testId="usage-truncated"
      actions={
        note.offerThirtyDays ? (
          <Button size="sm" onClick={onUseThirtyDays} testId="usage-truncated-30">
            Use 30 days
          </Button>
        ) : undefined
      }
    >
      {note.text}
    </Banner>
  )
}

/** Partial and unpriced notes under the summary (11): quiet text, no banner. */
export function SummaryNotes({ notes }: { notes: Pick<DataNotes, 'partial' | 'unpriced'> }): ReactElement | null {
  if (!notes.partial && !notes.unpriced) return null
  return (
    <div className="usage-notes">
      {notes.unpriced && (
        <p className="usage-note" data-testid="usage-unpriced-note">
          {notes.unpriced}
        </p>
      )}
      {notes.partial && (
        <p className="usage-note" data-testid="usage-partial-note">
          {notes.partial}
        </p>
      )}
    </div>
  )
}

/** The legacy note in the footer (11, 15 L4). */
export function LegacyNote({ text }: { text: string | null }): ReactElement | null {
  if (!text) return null
  return (
    <p className="usage-note" data-testid="usage-legacy-note">
      {text}
    </p>
  )
}
