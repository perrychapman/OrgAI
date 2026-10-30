import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CircleCheck, Info, TriangleAlert } from 'lucide-react'
import type { Project, SkillEvaluationReport, SkillFinding, SkillInfo, SkillSuggestion } from '@shared/types'
import { SKILL_EVAL_MAX_BUDGET, SKILL_EVAL_MIN_BUDGET, skillEvaluationOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { formatTokens } from '../../lib/cost'
import { evaluationSummary, skippedReasonText, sortFindings } from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Cost } from '../ui/Cost'
import { Icon } from '../ui/Icon'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { ClampedNumber } from '../settings/ClampedNumber'
import { SettingsCard } from '../settings/SettingsCard'
import { SettingsGroup } from '../settings/SettingsSection'
import { SkillRoleChecklist } from './SkillRoleAccess'
import type { ProjectSkills } from './useSkills'

export interface SkillEvaluationState {
  report: SkillEvaluationReport | null
  evaluating: boolean
  error: string | null
  /** Bumps each time an evaluation finishes, so the panel can open its disclosure. */
  finished: number
  run: () => Promise<void>
  reload: () => Promise<void>
}

/** The last evaluation of a project (loaded on mount) and the action that runs a new one. */
export function useSkillEvaluation(projectId: string): SkillEvaluationState {
  const [report, setReport] = useState<SkillEvaluationReport | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState(0)
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const r = await window.orgai.skills.lastEvaluation(projectId)
      if (mine === seq.current) setReport(r)
    } catch (e) {
      if (mine === seq.current) setError(cleanIpcError(e))
    }
  }, [projectId])

  useEffect(() => {
    setReport(null)
    setError(null)
    setEvaluating(false)
    void reload()
    return () => {
      seq.current++
    }
  }, [reload])

  const run = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    setEvaluating(true)
    setError(null)
    try {
      const r = await window.orgai.skills.evaluate(projectId)
      if (mine !== seq.current) return
      setReport(r)
      setFinished((n) => n + 1)
    } catch (e) {
      if (mine === seq.current) setError(cleanIpcError(e))
    } finally {
      if (mine === seq.current) setEvaluating(false)
    }
  }, [projectId])

  return { report, evaluating, error, finished, run, reload }
}

const plainEvidence = (f: SkillFinding): string[] => {
  const e = f.evidence
  if (!e) return []
  const lines: string[] = []
  if (e.paths?.length) lines.push(`Missing paths: ${e.paths.join(', ')}`)
  if (e.sequence?.length) lines.push(`Tool sequence: ${e.sequence.join(' > ')}`)
  if (typeof e.similarity === 'number') lines.push(`Similarity: ${Math.round(e.similarity * 100)}%`)
  if (typeof e.count === 'number') lines.push(`Seen ${e.count} ${e.count === 1 ? 'time' : 'times'}`)
  if (e.runIds?.length) lines.push(`${e.runIds.length} ${e.runIds.length === 1 ? 'run' : 'runs'}`)
  return lines
}

/** Evaluation settings (off by default) and the last report with its findings and suggestions. All skill text is shown as plain text. */
export default function SkillEvaluationPanel({
  project,
  skillsApi,
  evaluation
}: {
  project: Project
  skillsApi: ProjectSkills
  evaluation: SkillEvaluationState
}): ReactElement {
  const uid = useId()
  const updateProject = useAppStore((s) => s.updateProject)
  const settings = skillEvaluationOf(project)
  const { report, evaluating, error, finished, reload } = evaluation
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const names = new Map(skillsApi.skills.map((s: SkillInfo) => [s.spec.id, s.spec.name]))
  const save = (next: Partial<typeof settings>): void => updateProject({ ...project, skillEvaluation: { ...settings, ...next } })

  useEffect(() => {
    if (finished > 0) setOpen(true)
  }, [finished])
  useEffect(() => setDismissed(new Set()), [report?.at])

  const reason = report ? skippedReasonText(report.skippedReason, report.error) : null
  const visibleSuggestions = (report?.suggestions ?? []).filter((s) => s.appliedSkillId || !dismissed.has(s.id))
  const spent = report && (report.modelAssisted || report.tokensUsed > 0)

  return (
    <SettingsGroup title="Evaluation">
      <SettingsCard>
        <SettingRow
          id={`${uid}-enabled`}
          title="Suggest new skills"
          description="Lets a model read recent runs and draft skills for repeated work. Nothing is added until you apply it. The checks for unused, vague or stale skills always run."
          control={
            <Switch
              checked={settings.enabled}
              label="Suggest new skills"
              describedBy={settingDescId(`${uid}-enabled`)}
              testId="skill-eval-enabled"
              onChange={(enabled) => save({ enabled })}
            />
          }
        />
        <SettingRow
          id={`${uid}-budget`}
          title="Token budget"
          description="Most tokens one evaluation may spend on suggestions."
          width="number"
          control={
            <span data-testid="skill-eval-budget">
              <ClampedNumber
                label="Token budget"
                value={settings.tokenBudget}
                min={SKILL_EVAL_MIN_BUDGET}
                max={SKILL_EVAL_MAX_BUDGET}
                disabled={!settings.enabled}
                describedBy={settingDescId(`${uid}-budget`)}
                onCommit={(tokenBudget) => save({ tokenBudget })}
              />
            </span>
          }
        />
      </SettingsCard>

      {error && (
        <Banner tone="danger" title="Could not evaluate skills">
          {error}
        </Banner>
      )}
      {evaluating && (
        <p className="muted" role="status">
          Evaluating skills
        </p>
      )}

      <details className="skill-eval" data-testid="skill-eval-last" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="skill-eval-title">Last evaluation</span>
          <span className="muted">{report ? evaluationSummary(report) : 'Not run yet'}</span>
        </summary>
        <div className="skill-eval-body">
          {!report ? (
            <p className="muted">Use Evaluate skills to check this project. It works with suggestions turned off.</p>
          ) : (
            <>
              <p className="muted">
                {report.runsConsidered} {report.runsConsidered === 1 ? 'run' : 'runs'} read.
                {spent ? (
                  <>
                    {' '}
                    {formatTokens(report.tokensUsed)} tokens{report.tokensEstimated ? ' (estimated)' : ''} of {formatTokens(report.tokenBudget)}
                    {report.model ? `, ${report.model}` : ''}, cost{' '}
                    <Cost value={{ costUsd: report.costUsd, costSource: report.costUsd === null ? 'unknown' : 'computed' }} />.
                  </>
                ) : null}
              </p>
              {reason && <Banner tone="info">{reason}</Banner>}

              {report.findings.length === 0 ? (
                <p className="muted">
                  <Icon icon={CircleCheck} size="sm" /> No problems found.
                </p>
              ) : (
                <ul className="skill-findings" aria-label="Findings">
                  {sortFindings(report.findings).map((f) => {
                    const lines = plainEvidence(f)
                    const about = f.skillIds.map((id) => names.get(id)).filter(Boolean)
                    return (
                      <li key={f.id} className="skill-finding" data-testid="skill-finding" data-kind={f.kind}>
                        <Badge tone={f.severity === 'warning' ? 'attention' : 'info'} icon={f.severity === 'warning' ? TriangleAlert : Info}>
                          {f.severity === 'warning' ? 'Warning' : 'Note'}
                        </Badge>
                        <div className="skill-finding-main">
                          <span className="mcp-name">{f.title}</span>
                          <span className="skill-text">{f.detail}</span>
                          {about.length > 0 && <span className="muted">Skills: {about.join(', ')}</span>}
                          {lines.map((l) => (
                            <span key={l} className="muted skill-text">
                              {l}
                            </span>
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              {visibleSuggestions.length > 0 && (
                <ul className="skill-findings" aria-label="Suggested skills">
                  {visibleSuggestions.map((s) => (
                    <Suggestion
                      key={s.id}
                      suggestion={s}
                      project={project}
                      skillsApi={skillsApi}
                      onApplied={() => void reload()}
                      onDismiss={() => setDismissed((d) => new Set(d).add(s.id))}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
    </SettingsGroup>
  )
}

function Suggestion({
  suggestion: s,
  project,
  skillsApi,
  onApplied,
  onDismiss
}: {
  suggestion: SkillSuggestion
  project: Project
  skillsApi: ProjectSkills
  onApplied: () => void
  onDismiss: () => void
}): ReactElement {
  const [roles, setRoles] = useState<string[]>([])
  const [pickRoles, setPickRoles] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applied = !!s.appliedSkillId

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.orgai.skills.applySuggestion({ projectId: project.id, suggestionId: s.id, ...(roles.length ? { roleIds: roles } : {}) })
      skillsApi.apply(result)
      onApplied()
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="skill-finding skill-suggestion" data-testid="skill-suggestion" data-name={s.draft.name}>
      <Badge tone={applied ? 'success' : 'accent'} icon={applied ? CircleCheck : undefined}>
        {applied ? 'Applied' : 'Suggested'}
      </Badge>
      <div className="skill-finding-main">
        <span className="mcp-name mono">{s.draft.name}</span>
        <span className="skill-text">{s.draft.description}</span>
        <span className="muted skill-text">{s.rationale}</span>
        <details className="skill-body-preview">
          <summary>Show instructions</summary>
          <pre className="skill-pre">{s.draft.body}</pre>
        </details>
        {!applied && (
          <>
            {pickRoles && <SkillRoleChecklist roles={project.roles} value={roles} onChange={setRoles} label={`Roles for ${s.draft.name}`} />}
            {error && (
              <p className="invalid-text" role="alert">
                {error}
              </p>
            )}
            <div className="skill-actions">
              <Button size="sm" variant="primary" loading={busy} testId="skill-suggestion-apply" ariaLabel={`Apply ${s.draft.name}`} onClick={() => void apply()}>
                Apply
              </Button>
              <Button size="sm" disabled={busy} testId="skill-suggestion-dismiss" ariaLabel={`Dismiss ${s.draft.name}`} onClick={onDismiss}>
                Dismiss
              </Button>
              {project.roles.length > 0 && (
                <button type="button" className="mcp-link" aria-expanded={pickRoles} onClick={() => setPickRoles((p) => !p)}>
                  {roles.length ? `${roles.length} ${roles.length === 1 ? 'role' : 'roles'} will get it` : 'Choose roles (optional)'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </li>
  )
}
