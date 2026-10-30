import type { ReactElement } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { MergeDecision, MergeReview } from '@shared/types'
import DecisionCard from './DecisionCard'
import DiffView from './DiffView'
import { Button } from './ui/Button'
import { ConfirmDialog } from './ui/Dialog'

interface Props {
  runId: string
  review: MergeReview
  onDecide: (decision: MergeDecision) => void
}

/** A finished report's branch waiting for the user: merge it, hold it for later, or discard it. */
export default function MergeReviewCard({ runId, review, onDecide }: Props): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showPatch, setShowPatch] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const decide = (decision: MergeDecision): void => {
    if (busy) return
    setConfirmDiscard(false)
    setBusy(true)
    onDecide(decision)
  }

  const files = review.changedFiles
  return (
    <>
      <DecisionCard
        kind="merge"
        runId={runId}
        who={review.agentName}
        title="changes ready to merge"
        headerExtra={<code className="mono-dim">{review.branch}</code>}
        helper="Merge brings these changes into the main checkout. Hold keeps the branch for later (maintenance panel or the orchestrator's retry). Discard deletes it."
        primary={
          <Button variant="primary" size="sm" disabled={busy} onClick={() => decide({ behavior: 'merge' })}>
            Merge
          </Button>
        }
        secondary={
          <>
            <Button size="sm" disabled={busy} onClick={() => decide({ behavior: 'hold' })}>
              Hold for later
            </Button>
            <Button size="sm" variant="ghost" icon={showPatch ? ChevronDown : ChevronRight} onClick={() => setShowPatch((v) => !v)}>
              {showPatch ? 'Hide patch' : 'Show patch'}
            </Button>
          </>
        }
        deny={
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmDiscard(true)}>
            Discard
          </Button>
        }
      >
        <div className="stack-2">
          <div className="mono-dim">
            {files.length} file{files.length === 1 ? '' : 's'} changed
            {files.length > 0 ? `: ${files.slice(0, 12).join(', ')}${files.length > 12 ? `, +${files.length - 12} more` : ''}` : ''}
          </div>
          {review.stat && <pre className="diff-stat">{review.stat}</pre>}
          {showPatch && <DiffView patch={review.patch} />}
        </div>
      </DecisionCard>
      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard ${review.agentName}'s changes?`}
        body={`The branch ${review.branch} and its work are deleted. This cannot be undone.`}
        confirmLabel="Discard changes"
        danger
        onConfirm={() => decide({ behavior: 'discard' })}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  )
}
