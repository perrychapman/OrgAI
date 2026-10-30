import type { ReactElement } from 'react'
import { useState } from 'react'
import type { MergeDecision, MergeReview } from '@shared/types'
import DiffView from './DiffView'
import { ConfirmDialog } from './ui/Dialog'

interface Props {
  review: MergeReview
  onDecide: (decision: MergeDecision) => void
}

/** A finished report's branch waiting for the user: merge it, hold it for later, or discard it. */
export default function MergeReviewCard({ review, onDecide }: Props): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showPatch, setShowPatch] = useState(false)

  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const decide = (decision: MergeDecision): void => {
    if (decision.behavior === 'discard' && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    setConfirmDiscard(false)
    setBusy(true)
    onDecide(decision)
  }

  const files = review.changedFiles
  return (
    <div className="proposal merge-review">
      <div className="proposal-head">
        <span className="chip">Review changes</span>
        <strong>{review.agentName}</strong>
        <code className="mono-dim" style={{ marginLeft: 'auto' }}>
          {review.branch}
        </code>
      </div>
      <div className="proposal-body">
        <div className="mono-dim">
          {files.length} file{files.length === 1 ? '' : 's'} changed
          {files.length > 0 ? `: ${files.slice(0, 12).join(', ')}${files.length > 12 ? `, +${files.length - 12} more` : ''}` : ''}
        </div>
        {review.stat && <pre className="diff-stat">{review.stat}</pre>}
        <button className="btn ghost sm" onClick={() => setShowPatch((v) => !v)}>
          {showPatch ? 'Hide patch' : 'Show patch'}
        </button>
        {showPatch && <DiffView patch={review.patch} />}
      </div>
      <div className="proposal-note">
        Merging brings these changes into the main checkout. Holding keeps the branch for later (maintenance panel or the orchestrator&apos;s retry).
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy} onClick={() => decide({ behavior: 'merge' })}>
          Merge
        </button>
        <button className="btn" disabled={busy} onClick={() => decide({ behavior: 'hold' })}>
          Hold for later
        </button>
        <button className="btn danger" disabled={busy} onClick={() => decide({ behavior: 'discard' })}>
          Discard
        </button>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title={`Discard ${review.agentName}'s changes?`}
        body={`The branch ${review.branch} and its work are deleted. This cannot be undone.`}
        confirmLabel="Discard changes"
        danger
        onConfirm={() => decide({ behavior: 'discard' })}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  )
}
