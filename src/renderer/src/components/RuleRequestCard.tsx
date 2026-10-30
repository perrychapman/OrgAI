import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { PermissionRuleDecision, PermissionRuleRequest } from '@shared/types'
import { isWholeToolRule } from '@shared/types'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { Textarea } from './ui/Textarea'
import { rulesTitle } from '../lib/decisionTitle'

interface Props {
  runId: string
  request: PermissionRuleRequest
  /** Display name of the asking agent. */
  who: string
  onDecide: (decision: PermissionRuleDecision) => void | Promise<void>
}

/**
 * An agent hit a permission denial and asks for rules (request_permission_rules). Allowing applies at once to the
 * live run (the harness allows matching calls itself); "Always allow" also saves the rules to the project.
 */
export default function RuleRequestCard({ runId, request, who, onDecide }: Props): ReactElement {
  const noteId = useId()
  const [note, setNote] = useState('')
  const { busy, error, submit } = useDecisionAnswer()

  const send = (decision: PermissionRuleDecision): void => {
    if (busy) return
    void submit(() => onDecide(decision))
  }

  const flagged = new Set(request.flagged ?? [])
  return (
    <DecisionCard
      kind="rules"
      error={error}
      runId={runId}
      who={who}
      agentId={request.agentId}
      title={rulesTitle(request.rules)}
      helper={
        <ul className="decision-scopes">
          <li>Allow for this run: takes effect now for this run and its reports.</li>
          <li>Always allow for project: also saves the rules for future runs.</li>
          <li>Deny: the agent is told to find another route.</li>
        </ul>
      }
      primary={
        <Button variant="primary" size="sm" disabled={busy} onClick={() => send({ behavior: 'grant', scope: 'run' })}>
          {busy ? 'Sending…' : 'Allow for this run'}
        </Button>
      }
      secondary={
        <Button size="sm" disabled={busy} onClick={() => send({ behavior: 'grant', scope: 'project' })}>
          Always allow for project
        </Button>
      }
      deny={
        <Button variant="danger" size="sm" disabled={busy} onClick={() => send(note.trim() ? { behavior: 'deny', message: note.trim() } : { behavior: 'deny' })}>
          Deny
        </Button>
      }
    >
      <div className="stack-3">
        <div className="rules-list">
          {request.rules.map((r) => (
            <div key={r} className="row rules-row">
              <code>{r}</code>
              {flagged.has(r) && (
                <span title="A bare shell tool, a wildcard, or a destructive command (rm, git push, git reset, sudo...)">
                  <Badge tone="danger">broad or destructive</Badge>
                </span>
              )}
              {!flagged.has(r) && isWholeToolRule(r) && (
                <span title={`Approves every ${r} call, whatever its input`}>
                  <Badge tone="neutral">whole tool</Badge>
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="rules-reason">{request.reason}</div>
        <div className="field">
          <label htmlFor={noteId}>Note for the agent if you deny (optional)</label>
          <Textarea id={noteId} rows={2} value={note} disabled={busy} onChange={setNote} placeholder="What to do instead" />
        </div>
      </div>
    </DecisionCard>
  )
}
