import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, CircleAlert, FileDiff, GitMerge, ListChecks, Lock, MessageCircleQuestion, Plug, ShieldQuestion, Users, type LucideIcon } from 'lucide-react'
import type { PermissionRequest, Project, UserQuestion } from '@shared/types'
import { useAppStore, type RunState } from '../../store/useAppStore'
import { agentLabel } from '../../lib/agentTree'
import { oneLine } from '../../lib/decisionTitle'
import { showHidden } from '../../lib/hiddenChars'
import { permissionLocation, referenceLocation, type PermissionLocation } from '../../lib/permissionCopy'
import { cleanIpcError } from '../../lib/ipcError'
import type { WaitingItem, WaitingKind } from '../../lib/needsYou'
import {
  ALLOW_ONCE,
  ANSWER_IN_RUN,
  DENY,
  REFERENCE_LINE,
  inlineRefusal,
  allowedAnnouncement,
  answeredAnnouncement,
  deniedAnnouncement,
  newDecisionKeys,
  newDecisionsText,
  openRowName,
  optionAnswer,
  permissionAsk,
  permissionInlineMode,
  questionAsk,
  questionInlineMode,
  sendFailure,
  type InlineMode
} from '../../lib/needsInline'
import { Icon } from '../ui/Icon'

export interface RunNeedsItem extends WaitingItem {
  projectId: string
  run: RunState
}
/** A team-files approval: no run behind it (lib/teamFiles.ts). */
export interface TeamNeedsItem {
  kind: 'team'
  key: string
  runId?: undefined
  projectId: string
  label: string
  projectName: string
}
export type NeedsItem = RunNeedsItem | TeamNeedsItem

/** The row key shared by React, `data-row-key` and the new-decision baseline. */
export const needsItemKey = (it: NeedsItem): string => (it.kind === 'team' ? it.key : `${it.runId}/${it.key}`)

const KIND_ICON: Record<WaitingKind | 'team', LucideIcon> = {
  permission: ShieldQuestion,
  question: MessageCircleQuestion,
  rules: ListChecks,
  proposal: FileDiff,
  merge: GitMerge,
  install: Plug,
  plan: CircleAlert,
  team: Users
}

/** What one row shows, worked out from the run's open cards. */
interface RowModel {
  mode: InlineMode
  ask: ReactElement | null
  /** The ask as text, for names and announcements. */
  askText: string
  reference?: string
  /** The PermissionCard's location line ("In the project", "Outside the project: ..."). */
  where?: string
  whereAttention?: boolean
  note?: string
  /** The announcement label ("Allow: Run npm test"). */
  label: string
}

/** Where the request works, as the PermissionCard says it (the card's own helper, same context). */
function locationOf(request: PermissionRequest, run: RunState, project: Project | undefined): PermissionLocation | null {
  const reference = typeof request.referenceFolder === 'string' && request.referenceFolder.trim() ? request.referenceFolder : undefined
  if (reference) return referenceLocation(reference)
  if (!project) return null
  const agentCwd = run.agents[request.agentId]?.worktree?.path
  return permissionLocation(request.toolName, request.input, { projectPath: project.path, allowedDirectories: project.allowedDirectories, referenceDirectories: project.referenceDirectories, agentCwd })
}

function permissionRow(item: RunNeedsItem, request: PermissionRequest, project: Project | undefined): RowModel {
  const agent = item.run.agents[request.agentId]
  const location = locationOf(request, item.run, project)
  const mode = permissionInlineMode(request, location?.kind ?? null)
  const ask = permissionAsk(request, agent ? agentLabel(agent) : 'An agent', mode === 'allow')
  const reference = typeof request.referenceFolder === 'string' && request.referenceFolder.trim() ? request.referenceFolder : undefined
  // The reference line already names the folder; other locations get the card's one line.
  const where = !reference && location ? location.label : undefined
  return {
    mode,
    askText: where ? `${ask.text}, ${where}` : ask.text,
    reference,
    where,
    whereAttention: !!location?.attention,
    note: ask.long ? (inlineRefusal(request, location?.kind ?? null) ?? undefined) : undefined,
    label: item.label,
    ask: (
      <>
        <span className="dash-needs-lead">{ask.lead}</span>
        {ask.kind === 'shell' ? (
          // Every step, whole, when it can be allowed here (one line per step, the operator kept); clipped first line plus last step otherwise.
          <code className="dash-needs-code" data-clamp={mode === 'allow' ? undefined : '3'}>
            {ask.object}
          </code>
        ) : ask.kind === 'file' ? (
          <span className="dash-needs-file" title={ask.full}>
            <span className="dash-needs-filename">{ask.object}</span>
            {ask.folder && (
              <bdi className="dash-needs-folder" dir="ltr">
                {ask.folder}
              </bdi>
            )}
          </span>
        ) : (
          <span className="dash-needs-object" data-whole={mode === 'allow' ? '' : undefined}>
            {ask.object}
          </span>
        )}
      </>
    )
  }
}

function questionRow(item: RunNeedsItem, question: UserQuestion): RowModel {
  const text = questionAsk(question)
  const mode = questionInlineMode(question)
  return {
    mode,
    askText: text,
    note: mode === 'none' ? ANSWER_IN_RUN : undefined,
    label: item.label,
    ask: (
      <span className="dash-needs-question" data-clamp="2">
        {text}
      </span>
    )
  }
}

function rowModel(item: NeedsItem, project: Project | undefined): RowModel {
  if (item.kind === 'permission') {
    const request = item.run.permissions.find((p) => p.id === item.key)
    if (request) return permissionRow(item, request, project)
  }
  if (item.kind === 'question') {
    const q = item.run.questions.find((x) => x.id === item.key)
    if (q) return questionRow(item, q)
  }
  return { mode: 'none', askText: item.label, label: item.label, ask: <span className="dash-needs-object">{item.label}</span> }
}

/**
 * One Needs you row (docs/design/dashboard-2.md 5): the place first (project · run), then the ask, and for a permission
 * or a short question the answer buttons. Only Allow once and Deny are ever offered for a permission, whatever the
 * request carries. The row never leaves on its own: it goes when the `*.resolved` event removes the card.
 */
export function NeedsRow({
  item,
  projectName,
  runName,
  onOpen,
  onAnnounce
}: {
  item: NeedsItem
  projectName: string
  runName?: string
  onOpen: () => void
  onAnnounce: (text: string) => void
}): ReactElement {
  const decideIn = useAppStore((s) => s.decideIn)
  const answerQuestionIn = useAppStore((s) => s.answerQuestionIn)
  const project = useAppStore((s) => (item.kind === 'team' ? undefined : (s.projects.find((p) => p.id === item.projectId) ?? (s.virtualProjects as Partial<Record<string, Project>>)[item.projectId])))
  const model = item.kind === 'team' ? ({ mode: 'none', ask: <span className="dash-needs-object">{item.label}</span>, askText: item.label, label: item.label } as RowModel) : rowModel(item, project)
  // `busy`: the pressed button while a send is in flight. `sent`: the answer reached main; the row waits for its
  // `*.resolved` event and stays locked until then, so a second press never answers twice (review M1).
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const inFlight = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const key = needsItemKey(item)
  const runId = item.runId
  const locked = !!busy || sent

  const place = runName ? `${projectName}, ${oneLine(showHidden(runName), 120)}` : projectName
  const mainName = openRowName(item.kind, place, model.askText)

  const send = async (id: string, act: () => Promise<void>, done: string): Promise<void> => {
    if (inFlight.current || sent) return
    inFlight.current = true
    setBusy(id)
    setError(null)
    try {
      await act()
      setSent(true)
      onAnnounce(done)
    } catch (err) {
      const text = sendFailure(cleanIpcError(err))
      setError(text)
      onAnnounce(text)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const permissionId = item.kind === 'permission' ? item.key : null
  const questionId = item.kind === 'question' ? item.key : null
  const question = item.kind === 'question' ? item.run.questions.find((q) => q.id === item.key) : undefined

  return (
    <li
      className="dash-row dash-needs-row"
      data-testid="dash-needs-row"
      data-kind={item.kind}
      data-run={runId ?? ''}
      data-key={item.key}
      data-inline={model.mode}
      data-row-key={key}
      data-has-action={model.mode !== 'none' ? 'true' : undefined}
    >
      <button type="button" className="dash-row-main dash-needs-main" data-row-main="" aria-label={mainName} onClick={onOpen}>
        <span className="dash-row-icon">
          <Icon icon={KIND_ICON[item.kind]} />
        </span>
        <span className="dash-row-text">
          <span className="dash-needs-place">
            <span className="dash-needs-project">{oneLine(showHidden(projectName), 120)}</span>
            {runName && <span className="dash-needs-run"> · {oneLine(showHidden(runName), 120)}</span>}
            {item.kind === 'team' && <span className="dash-needs-run"> · Team files</span>}
          </span>
          <span className="dash-needs-ask">{model.ask}</span>
          {model.reference && (
            <span className="dash-needs-reference" data-testid="dash-needs-reference" title={model.reference}>
              <Icon icon={Lock} size="sm" />
              {REFERENCE_LINE}
            </span>
          )}
          {model.where && (
            <span className="dash-row-cap dash-needs-where" data-testid="dash-needs-where" data-attention={model.whereAttention ? 'true' : undefined}>
              {model.where}
            </span>
          )}
          {model.note && <span className="dash-row-cap">{model.note}</span>}
        </span>
        {model.mode === 'none' && <Icon icon={ChevronRight} size="sm" />}
      </button>
      {model.mode === 'allow' && permissionId && runId && (
        <div className="dash-needs-actions">
          {/* aria-disabled, not disabled: a pressed button keeps focus while the answer is sent (review M2). */}
          <button
            type="button"
            className="btn sm"
            data-testid="dash-needs-allow"
            aria-disabled={locked || undefined}
            aria-label={`Allow once: ${model.askText}`}
            onClick={() => void send('allow', () => decideIn(runId, permissionId, ALLOW_ONCE), allowedAnnouncement(model.label))}
          >
            {busy === 'allow' ? 'Sending…' : 'Allow once'}
          </button>
          <button
            type="button"
            className="btn ghost sm dash-needs-deny"
            data-testid="dash-needs-deny"
            aria-disabled={locked || undefined}
            aria-label={`Deny: ${model.askText}`}
            onClick={() => void send('deny', () => decideIn(runId, permissionId, DENY), deniedAnnouncement(model.label))}
          >
            {busy === 'deny' ? 'Sending…' : 'Deny'}
          </button>
        </div>
      )}
      {model.mode === 'options' && questionId && runId && question && (
        <div className="dash-needs-actions" role="group" aria-label={`Answer: ${model.askText}`}>
          {question.options.map((o) => (
            <button
              key={o.label}
              type="button"
              className="btn sm"
              data-testid="dash-needs-option"
              data-option={o.label}
              aria-disabled={locked || undefined}
              onClick={() => void send(`option:${o.label}`, () => answerQuestionIn(runId, questionId, optionAnswer(o.label)), answeredAnnouncement(o.label))}
            >
              {busy === `option:${o.label}` ? 'Sending…' : o.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="dash-needs-error" data-testid="dash-needs-error">
          {error}
        </p>
      )}
    </li>
  )
}

const BATCH_MS = 600
/** After history has loaded, decisions that exist already are the baseline; give pending cards this long to arrive. */
const SETTLE_MS = 1500

/**
 * Announces a decision that arrives while the Dashboard is open (spec 12.3): "New decision in {project}: {label}", or
 * "{N} new decisions" for several within a beat. The first data load never speaks: the baseline of keys is taken once
 * `ready` (every project's history is in), immediately when the page mounts ready, else after a short settle.
 */
export function useNewDecisionAnnouncer(entries: readonly { key: string; project: string; label: string }[], ready: boolean, say: (text: string) => void): void {
  const seen = useRef<Set<string> | null>(null)
  const latest = useRef(entries)
  latest.current = entries
  const mountedReady = useRef(ready)
  const buffer = useRef<{ project: string; label: string }[]>([])
  const timer = useRef<number | null>(null)
  const sayRef = useRef(say)
  sayRef.current = say

  useEffect(() => {
    if (!ready || seen.current) return
    if (mountedReady.current) {
      seen.current = new Set(latest.current.map((e) => e.key))
      return
    }
    const t = window.setTimeout(() => {
      seen.current = new Set(latest.current.map((e) => e.key))
    }, SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [ready])

  const signature = entries.map((e) => e.key).join('\u0000')
  useEffect(() => {
    const base = seen.current
    if (!base) return
    const fresh = new Set(newDecisionKeys(base, latest.current.map((e) => e.key)))
    for (const e of latest.current) {
      if (!fresh.has(e.key)) continue
      base.add(e.key)
      buffer.current.push({ project: e.project, label: e.label })
    }
    if (buffer.current.length === 0) return
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      const text = newDecisionsText(buffer.current)
      buffer.current = []
      if (text) sayRef.current(text)
    }, BATCH_MS)
  }, [signature])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )
}
