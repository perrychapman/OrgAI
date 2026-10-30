import type { ReactElement } from 'react'
import type { PermissionRequest } from '@shared/types'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { Button } from './ui/Button'
import { permissionTitle } from '../lib/decisionTitle'

export type PermissionChoice = { behavior: 'allow'; scope: 'once' | 'session' | 'project' } | { behavior: 'deny'; message: string }

interface Props {
  runId: string
  request: PermissionRequest
  /** Display name of the asking agent. */
  who: string
  onDecide: (decision: PermissionChoice) => void | Promise<void>
}

const MAX_LINES = 8
const MAX_LINE_CHARS = 200

interface PreviewLine {
  text: string
  kind?: 'add' | 'del' | 'more'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function clip(s: string): string {
  return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s
}

function linesOf(text: string, prefix: string, kind?: 'add' | 'del'): PreviewLine[] {
  return text.split(/\r?\n/).map((l) => ({ text: clip(prefix + l), kind }))
}

function cap(lines: PreviewLine[]): PreviewLine[] {
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES), { text: `… ${lines.length - MAX_LINES} more lines`, kind: 'more' }]
}

/** A readable, capped rendering of a tool input. Never throws on odd input. */
export function previewLines(toolName: string, input: unknown): PreviewLine[] {
  try {
    const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined
    if (o) {
      const edits = Array.isArray(o.edits) ? o.edits : [o]
      const hasEdit = edits.some((e) => e && typeof e === 'object' && (e as Record<string, unknown>).old_string !== undefined)
      if (hasEdit && (toolName === 'Edit' || toolName === 'MultiEdit')) {
        const out: PreviewLine[] = []
        const file = str(o.file_path)
        if (file) out.push({ text: clip(file) })
        for (const e of edits) {
          const r = (e ?? {}) as Record<string, unknown>
          out.push(...linesOf(str(r.old_string) ?? '', '- ', 'del'), ...linesOf(str(r.new_string) ?? '', '+ ', 'add'))
        }
        return cap(out)
      }
      if (toolName === 'Bash' && str(o.command) !== undefined) return cap(linesOf(str(o.command) as string, ''))
      if (toolName === 'Write' && str(o.file_path)) {
        return cap([{ text: clip(str(o.file_path) as string) }, ...linesOf(str(o.content) ?? '', '')])
      }
    }
    const json = JSON.stringify(input, null, 2)
    return cap(linesOf(json ?? String(input), ''))
  } catch {
    return [{ text: 'The input cannot be shown.', kind: 'more' }]
  }
}

/** A tool call the policy did not pre-approve. One click allows it once; scope buttons appear when rules can be saved. */
export default function PermissionCard({ runId, request, who, onDecide }: Props): ReactElement {
  const { busy, error, submit } = useDecisionAnswer()
  const send = (d: PermissionChoice): void => {
    if (busy) return
    void submit(() => onDecide(d))
  }
  const canScope = (request.suggestions?.length ?? 0) > 0
  const lines = previewLines(request.toolName, request.input)
  return (
    <DecisionCard
      kind="permission"
      error={error}
      runId={runId}
      who={who}
      agentId={request.agentId}
      title={permissionTitle(request.toolName, request.input)}
      helper={
        <>
          <ul className="decision-scopes">
            <li>Allow once: this call only.</li>
            {canScope && <li>Allow for session: until the run ends.</li>}
            {canScope && <li>Always allow for project: saved to the project rules.</li>}
          </ul>
          {canScope && request.ruleLabels && request.ruleLabels.length > 0 && (
            <div className="decision-rule-chips" aria-label="Rules the session and project options approve">
              {request.ruleLabels.map((r) => (
                <code key={r}>{r}</code>
              ))}
            </div>
          )}
        </>
      }
      primary={
        <Button variant="primary" size="sm" disabled={busy} onClick={() => send({ behavior: 'allow', scope: 'once' })}>
          Allow once
        </Button>
      }
      secondary={
        canScope ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => send({ behavior: 'allow', scope: 'session' })}>
              Allow for session
            </Button>
            <Button size="sm" disabled={busy} onClick={() => send({ behavior: 'allow', scope: 'project' })}>
              Always allow for project
            </Button>
          </>
        ) : undefined
      }
      deny={
        <Button variant="danger" size="sm" disabled={busy} onClick={() => send({ behavior: 'deny', message: 'The user declined this action. Find another way or ask.' })}>
          Deny
        </Button>
      }
    >
      <p className="perm-summary">{request.summary}</p>
      <details className="perm-preview">
        <summary>Tool input</summary>
        <pre className="perm-input">
          {lines.map((l, i) => (
            <span key={i} className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : l.kind === 'more' ? 'perm-more' : undefined}>
              {l.text}
              {'\n'}
            </span>
          ))}
        </pre>
      </details>
    </DecisionCard>
  )
}
