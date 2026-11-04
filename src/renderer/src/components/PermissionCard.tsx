import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import { FolderOpen, Lock, TriangleAlert } from 'lucide-react'
import type { PermissionRequest } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import DecisionCard, { useDecisionAnswer } from './DecisionCard'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { Icon } from './ui/Icon'
import { isHiddenCommand, permissionTitle, shellSegments } from '../lib/decisionTitle'
import { noRuleLine, permissionLocation, permissionOffer, referenceEffect, referenceLocation, ruleChip, scopeCopy } from '../lib/permissionCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../lib/settingsTarget'
import { openProjectSettings } from '../lib/openProjectSettings'
import { useAppStore } from '../store/useAppStore'

export type PermissionChoice = { behavior: 'allow'; scope: 'once' | 'session' | 'project' } | { behavior: 'deny'; message: string }

interface Props {
  runId: string
  request: PermissionRequest
  /** Display name of the asking agent. */
  who: string
  onDecide: (decision: PermissionChoice) => void | Promise<void>
}

/** Bidi, zero-width and control characters (other than tab and newline) that can disguise a command. */
const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u115f\u1160\u180e\u200b-\u200f\u061c\u2060-\u2064\u3164\ufe00-\ufe0f\uffa0\ufeff\u202a-\u202e\u2066-\u2069]|[\u{e0000}-\u{e007f}]/u
const HIDDEN_ALL = new RegExp(HIDDEN_CHARS.source, 'gu')

/** Replaces hidden characters with visible \\uXXXX (or \\u{XXXXX}) escapes. */
function showHidden(s: string): string {
  return s.replace(HIDDEN_ALL, (c) => {
    const cp = c.codePointAt(0) ?? 0
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
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
  if ((toolName !== 'Bash' && toolName !== 'PowerShell') || !input || typeof input !== 'object') return undefined
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
      if ((toolName === 'Bash' || toolName === 'PowerShell') && str(o.command) !== undefined) return linesOf(str(o.command) as string, '', undefined, false)
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

/** Files whose preview opens by default, like a shell command (ux-review-permissions L2). */
const OPEN_PREVIEW = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The header badge for a shell command: steps, lines, a clipped line, or just "Command". */
function commandBadge(command: string, hidden: boolean): string {
  const lines = command.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length > 1) return `${lines.length} lines`
  const steps = shellSegments(lines[0] ?? '').length
  if (steps > 1) return `${steps} steps`
  return hidden ? 'Long command' : 'Command'
}

/**
 * Open project Settings > Permissions with "Rules and folders you allowed" open and the rules heading focused: the user
 * came to cut prompts (ux-review-config-2 N11).
 */
function openPermissionSettings(projectId: string): void {
  openProjectSettings(projectId, PROJECT_SETTINGS_SECTIONS.rules)
}

/**
 * A tool call the policy did not pre-approve (docs/design/permissions.md). The glance block (where the agent works,
 * what Always allow stops asking for, the rules it saves) stays visible in compact mode; the command and the scope
 * list sit behind Details there. One click allows it once; scope buttons appear when rules can be saved.
 */
export default function PermissionCard({ runId, request, who, onDecide }: Props): ReactElement {
  const { busy, error, submit } = useDecisionAnswer()
  const send = (d: PermissionChoice): void => {
    if (busy) return
    void submit(() => onDecide(d))
  }
  const projectId = useAppStore((st) => st.runs[runId]?.summary.projectId)
  const project = useAppStore((st) => (projectId && !isVirtualProjectId(projectId) ? st.projects.find((p) => p.id === projectId) : undefined))
  const agentCwd = useAppStore((st) => st.runs[runId]?.agents[request.agentId]?.worktree?.path)
  // A command that touches a reference folder offers Allow once and Deny only; main sends no suggestions, and any that
  // arrive anyway are ignored so the card never synthesizes an Always allow.
  const { referenceFolder, canScope, showSettingsLink } = permissionOffer(request)
  const lines = previewLines(request.toolName, request.input)
  const command = bashCommand(request.toolName, request.input)
  const hidden = isHiddenCommand(request.toolName, request.input)
  const commandLines = command ? command.split(/\r?\n/).filter((l) => l.trim()).length : 0
  const longCommand = !!command && (commandLines > 6 || command.length > 400)
  const isShell = request.toolName === 'Bash' || request.toolName === 'PowerShell'
  const hasHidden = command !== undefined && HIDDEN_CHARS.test(command)
  const [full, setFull] = useState(false)
  const location = useMemo(
    () =>
      referenceFolder
        ? referenceLocation(referenceFolder)
        : project
          ? permissionLocation(request.toolName, request.input, { projectPath: project.path, allowedDirectories: project.allowedDirectories, referenceDirectories: project.referenceDirectories, agentCwd })
          : null,
    [project, referenceFolder, request.toolName, request.input, agentCwd]
  )
  const copy = useMemo(() => scopeCopy(canScope ? request.suggestions : undefined, project?.permissionMode), [canScope, request.suggestions, project?.permissionMode])
  const chips = canScope ? [...new Set(request.ruleLabels ?? [])].map(ruleChip).filter((c) => c.text) : []
  const showEffect = canScope && !!copy.project
  const noRule = referenceFolder ? null : noRuleLine(request.toolName, canScope)
  return (
    <DecisionCard
      kind="permission"
      error={error}
      runId={runId}
      who={who}
      agentId={request.agentId}
      title={permissionTitle(request.toolName, request.input)}
      focusDetails={isShell && command !== undefined}
      headerExtra={
        hasHidden || isShell ? (
          <>
            {isShell && <Badge tone="attention">{command !== undefined ? commandBadge(command, hidden) : request.toolName}</Badge>}
            {hasHidden && <Badge tone="attention">Hidden characters</Badge>}
          </>
        ) : undefined
      }
      helper={
        <>
          <ul className="decision-scopes" data-testid="perm-scopes">
            <li>{copy.once}</li>
            {canScope && copy.session && <li>{copy.session}</li>}
            {canScope && copy.project && <li>{copy.project}</li>}
          </ul>
          {project && showSettingsLink && (
            <button type="button" className="link-btn perm-settings-link" data-testid="perm-settings-link" onClick={() => openPermissionSettings(project.id)}>
              Fewer prompts: permission settings
            </button>
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
      {(location || showEffect || noRule || referenceFolder) && (
      <div className="perm-glance">
        {location && (
          <p className="perm-location" data-testid="perm-location" data-kind={location.kind} data-attention={location.attention ? 'true' : undefined} title={location.full}>
            <Icon icon={location.attention ? TriangleAlert : location.kind === 'reference' ? Lock : FolderOpen} size="xs" />
            <span className="perm-location-label">{location.label}</span>
            {location.detail && <span className="perm-location-detail">{location.detail}</span>}
          </p>
        )}
        {showEffect && (
          <div className="perm-effect">
            <p className="perm-effect-text" data-testid="perm-scope-project" title={copy.project}>
              {copy.project}
            </p>
            {chips.length > 0 && (
              <ul className="perm-rule-chips" aria-label="What Allow for session and Always allow approve">
                {chips.map((c) => (
                  <li
                    key={c.text}
                    className="perm-rule-chip"
                    data-testid="perm-rule-chip"
                    data-whole-tool={c.wholeTool ? 'true' : undefined}
                    data-broad={c.broad ? 'true' : undefined}
                    title={c.wholeTool ? `Approves every ${c.text} call, whatever its input` : c.broad ? 'Approves every tool of this server, including tools it adds later' : undefined}
                  >
                    <code>{c.text}</code>
                    {c.wholeTool && <span className="perm-rule-whole">whole tool</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {referenceFolder && (
          <p className="perm-no-rule" data-testid="perm-reference-effect">
            {referenceEffect(request.toolName)}
          </p>
        )}
        {noRule && (
          <p className="perm-no-rule" data-testid="perm-no-rule">
            {noRule}
          </p>
        )}
      </div>
      )}
      <div className="perm-detail">
        {/* The command block shows the command itself; the summary would repeat it (L1). */}
        {command === undefined && <p className="perm-summary">{request.summary}</p>}
        <details className="perm-preview" open={command !== undefined || OPEN_PREVIEW.has(request.toolName) || undefined}>
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
      </div>
    </DecisionCard>
  )
}
