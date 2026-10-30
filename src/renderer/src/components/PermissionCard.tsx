import type { ReactElement } from 'react'
import { useState } from 'react'
import type { PermissionRequest } from '@shared/types'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { isHiddenCommand, permissionTitle } from '../lib/decisionTitle'

export type PermissionChoice = { behavior: 'allow'; scope: 'once' | 'session' | 'project' } | { behavior: 'deny'; message: string }

interface Props {
  runId: string
  request: PermissionRequest
  /** Display name of the asking agent. */
  who: string
  onDecide: (decision: PermissionChoice) => void | Promise<void>
}

/** Bidi, zero-width and control characters (other than tab and newline) that can disguise a command. */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u061c\ufeff\u202a-\u202e\u2066-\u2069]/
const HIDDEN_ALL = new RegExp(HIDDEN_CHARS.source, 'g')

/** Replaces hidden characters with visible \\uXXXX escapes. */
function showHidden(s: string): string {
  return s.replace(HIDDEN_ALL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
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

function linesOf(text: string, prefix: string, kind?: 'add' | 'del', clipLines = true): PreviewLine[] {
  return text.split(/\r?\n/).map((l) => ({ text: clipLines ? clip(prefix + l) : prefix + l, kind }))
}

/** The shell command exactly as sent, or undefined for any other tool. Never clipped: it is what the user approves. */
function bashCommand(toolName: string, input: unknown): string | undefined {
  if (toolName !== 'Bash' || !input || typeof input !== 'object') return undefined
  return str((input as Record<string, unknown>).command)
}

function cap(lines: PreviewLine[]): PreviewLine[] {
  if (lines.length <= MAX_LINES) return lines
  return [...lines.slice(0, MAX_LINES), { text: `… ${lines.length - MAX_LINES} more lines`, kind: 'more' }]
}

/** A readable rendering of a tool input: capped for JSON and file content, never for a Bash command. Never throws. */
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
      if (toolName === 'Bash' && str(o.command) !== undefined) return linesOf(str(o.command) as string, '', undefined, false)
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
  const command = bashCommand(request.toolName, request.input)
  const hidden = isHiddenCommand(request.toolName, request.input)
  const commandLines = command ? command.split(/\r?\n/).filter((l) => l.trim()).length : 0
  const longCommand = !!command && (commandLines > 6 || command.length > 400)
  const isBash = request.toolName === 'Bash'
  const hasHidden = command !== undefined && HIDDEN_CHARS.test(command)
  const [full, setFull] = useState(false)
  return (
    <DecisionCard
      kind="permission"
      error={error}
      runId={runId}
      who={who}
      agentId={request.agentId}
      title={permissionTitle(request.toolName, request.input)}
      focusDetails={isBash && command !== undefined}
      headerExtra={
        hidden || hasHidden || isBash ? (
          <>
            {hidden ? (
              <Badge tone="attention">{commandLines > 1 ? `${commandLines} lines` : 'Long command'}</Badge>
            ) : isBash ? (
              <Badge tone="attention">{command !== undefined ? 'Command' : 'Bash'}</Badge>
            ) : null}
            {hasHidden && <Badge tone="attention">Hidden characters</Badge>}
          </>
        ) : undefined
      }
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
      <details className="perm-preview" open={command !== undefined || undefined}>
        <summary>{command !== undefined ? 'Command' : 'Tool input'}</summary>
        <pre className={`perm-input${command !== undefined ? ' perm-command' : ''}${full ? ' full' : ''}`} tabIndex={command !== undefined ? 0 : undefined}>
          {lines.map((l, i) => (
            <span key={i} className={l.kind === 'add' ? 'diff-add' : l.kind === 'del' ? 'diff-del' : l.kind === 'more' ? 'perm-more' : undefined}>
              {command !== undefined ? showHidden(l.text) : l.text}
              {'\n'}
            </span>
          ))}
        </pre>
        {longCommand && (
          <button type="button" className="perm-expand" aria-expanded={full} onClick={() => setFull((v) => !v)}>
            {full ? 'Show less' : 'Show full command'}
          </button>
        )}
      </details>
    </DecisionCard>
  )
}
