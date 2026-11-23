import type { ReactElement } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import { mergeFacts } from '../lib/decisionCard'
import type { MergeDecision, MergeReview } from '@shared/types'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import DiffView from './DiffView'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { ConfirmDialog } from './ui/Dialog'
import { mergeTitle } from '../lib/decisionTitle'

interface Props {
  runId: string
  review: MergeReview
  onDecide: (decision: MergeDecision) => void | Promise<void>
}

/** A finished report's branch waiting for the user: merge it, hold it for later, or discard it. */
export default function MergeReviewCard({ runId, review, onDecide }: Props): ReactElement {
  const { busy, error, submit } = useDecisionAnswer()
  const [showPatch, setShowPatch] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const decide = (decision: MergeDecision): void => {
    if (busy) return
    setConfirmDiscard(false)
    void submit(() => onDecide(decision))
  }

  const files = review.changedFiles
  const facts = mergeFacts(review.checks)
  return (
    <>
      <DecisionCard
        kind="merge"
        error={error}
        runId={runId}
        who={review.agentName}
        agentId={review.agentId}
        waitingSince={review.createdAt}
        title={mergeTitle(review.agentName)}
        headerExtra={
          <code className="mono-dim decision-branch" title={review.branch}>
            {review.branch}
          </code>
        }
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
            <button type="button" className="btn ghost sm" aria-expanded={showPatch} onClick={() => setShowPatch((v) => !v)}>
              <Icon icon={showPatch ? ChevronDown : ChevronRight} size="sm" />
              {showPatch ? 'Hide patch' : 'Show patch'}
            </button>
          </>
        }
        deny={
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setConfirmDiscard(true)}>
            Discard
          </Button>
        }
      >
        <div className="stack-2">
          {facts.length > 0 && (
            <ul className="merge-facts" data-testid="merge-facts" aria-label="Checks on this branch">
              {facts.map((f) => (
                <li key={f.key} className="merge-fact" data-tone={f.tone} data-testid={`merge-fact-${f.key}`}>
                  <Icon icon={f.tone === 'ok' ? CircleCheck : f.tone === 'bad' ? CircleX : CircleHelp} size="xs" />
                  <span className="merge-fact-label">{f.label}</span>
                  <span className="merge-fact-text">{f.text}</span>
                  {f.detail && <span className="merge-fact-detail">{f.detail}</span>}
                </li>
              ))}
            </ul>
          )}
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
