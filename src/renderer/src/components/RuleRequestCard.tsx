import type { ReactElement } from 'react'
import { useState } from 'react'
import type { PermissionRuleDecision, PermissionRuleRequest } from '@shared/types'
import { isWholeToolRule } from '@shared/types'

interface Props {
  request: PermissionRuleRequest
  /** Display name of the asking agent. */
  who: string
  onDecide: (decision: PermissionRuleDecision) => void
}

/**
 * An agent hit a permission denial and asks for rules (request_permission_rules). Allowing applies at once to the
 * live run (the harness allows matching calls itself); "Always allow" also saves the rules to the project.
 */
export default function RuleRequestCard({ request, who, onDecide }: Props): ReactElement {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const send = (decision: PermissionRuleDecision): void => {
    if (busy) return
    setBusy(true)
    onDecide(decision)
  }

  const flagged = new Set(request.flagged ?? [])
  return (
    <div className="proposal kind-rules">
      <div className="proposal-head">
        <span className="chip setup">Permission request</span>
        <strong>{who} asks to allow</strong>
      </div>
      <div className="rules-list">
        {request.rules.map((r) => (
          <div key={r} className="row rules-row">
            <code>{r}</code>
            {flagged.has(r) && (
              <span className="chip danger" title="A bare shell tool, a wildcard, or a destructive command (rm, git push, git reset, sudo...)">
                broad or destructive
              </span>
            )}
            {!flagged.has(r) && isWholeToolRule(r) && (
              <span className="chip" title={`Approves every ${r} call, whatever its input`}>
                whole tool
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="proposal-body rules-reason">{request.reason}</div>
      <textarea
        className="textarea"
        value={note}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for the agent if you deny (what to do instead)"
        style={{ marginTop: 8 }}
      />
      <div className="proposal-note">
        Allowing takes effect right away for this run and its reports. “Always allow” also saves the rules to the project for future runs. Deny tells the
        agent to find another route.
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={() => send({ behavior: 'grant', scope: 'run' })}>
          {busy ? 'Sending…' : 'Allow for this run'}
        </button>
        <button className="btn" disabled={busy} onClick={() => send({ behavior: 'grant', scope: 'project' })}>
          Always allow (project)
        </button>
        <button
          className="btn danger"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => send(note.trim() ? { behavior: 'deny', message: note.trim() } : { behavior: 'deny' })}
        >
          Deny
        </button>
      </div>
    </div>
  )
}
