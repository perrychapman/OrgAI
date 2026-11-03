import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, CircleCheck, Info, Pencil, Undo2, TriangleAlert } from 'lucide-react'
import type { Project, SkillEvaluationReport, SkillInfo, SkillSuggestion } from '@shared/types'
import { SKILL_EVAL_MAX_BUDGET, SKILL_EVAL_MIN_BUDGET, skillEvaluationOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { formatTokens } from '../../lib/cost'
import {
  evaluationAnnouncement,
  evaluationSummary,
  evaluationToggleLabel,
  evidenceLines,
  openSuggestionCount,
  skippedReasonText,
  sortFindings
} from '../../lib/skills'
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
import { SkillRolePicker } from './SkillRoleAccess'
import type { ProjectSkills } from './useSkills'

export interface SkillEvaluationState {
  report: SkillEvaluationReport | null
  evaluating: boolean
  error: string | null
  /** Bumps each time an evaluation finishes, so the panel can open its disclosure and move focus to the results. */
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

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true || document.documentElement.getAttribute('data-reduce-motion') === 'on'

/** What the panel tells the section when a suggestion became a skill. */
export interface SuggestionApplied {
  skillId: string | null
  name: string
  roleCount: number
}

/** Evaluation settings (off by default) and the last report with its findings and suggestions. All skill text is shown as plain text. */
export default function SkillEvaluationPanel({
  project,
  skillsApi,
  evaluation,
  onEditSkill,
  onApplied,
  onShowSkill,
  actions
}: {
  project: Project
  skillsApi: ProjectSkills
  evaluation: SkillEvaluationState
  /** Opens the skill's form (or its library entry when it is linked). */
  onEditSkill: (info: SkillInfo) => void
  onApplied: (applied: SuggestionApplied) => void
  /** Scrolls to and flashes a skill row. */
  onShowSkill: (skillId: string) => void
  /** The Evaluate button, placed under the disclosure so it is reachable while the results are folded. */
  actions?: ReactNode
}): ReactElement {
  const { report, evaluating, error, finished, reload } = evaluation
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [announcement, setAnnouncement] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const autoOpened = useRef<number | null>(null)
  const infos = new Map(skillsApi.skills.map((s: SkillInfo) => [s.spec.id, s]))

  // A restored result opens by default while a suggestion still waits for a decision, so Apply is visible on return.
  useEffect(() => {
    if (!report || autoOpened.current === report.at) return
    autoOpened.current = report.at
    if (openSuggestionCount(report) > 0) setOpen(true)
  }, [report])

  // A fresh run: open the results, announce them and move focus to their heading (the Evaluate button was busy, not removed).
  useEffect(() => {
    if (finished === 0 || !report) return
    setOpen(true)
    setAnnouncement(evaluationAnnouncement(report))
    const t = window.setTimeout(() => {
      heading.current?.focus({ preventScroll: true })
      heading.current?.scrollIntoView({
        block: 'start',
        behavior: reducedMotion() ? 'auto' : 'smooth'
      })
    }, 0)
    return () => window.clearTimeout(t)
    // Only a new finish counts, not a later report reload after Apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished])
  useEffect(() => setDismissed(new Set()), [report?.at])

  const reason = report ? skippedReasonText(report.skippedReason, report.error) : null
  // Counts follow what the user still sees: a dismissed suggestion no longer counts.
  const counted = report
    ? {
        ...report,
        suggestions: report.suggestions.filter((s) => s.appliedSkillId || !dismissed.has(s.id))
      }
    : null
  const spent = report && (report.modelAssisted || report.tokensUsed > 0)

  return (
    <div className="skill-eval-wrap" data-testid="skill-eval">

      {error && (
        <Banner tone="danger" title="Could not evaluate skills">
          {error}
        </Banner>
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="skill-eval-live">
        {evaluating ? 'Evaluating skills' : announcement}
      </p>
      {evaluating && (
        <p className="muted" aria-hidden="true">
          Evaluating skills
        </p>
      )}

      <details className="skill-eval" data-testid="skill-eval-last" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <Icon icon={ChevronRight} size="sm" />
          <h4 className="skill-eval-title" tabIndex={-1} ref={heading} data-testid="skill-eval-heading">
            Suggestions from past runs
          </h4>
          <span className="muted skill-eval-when">{counted ? evaluationSummary(counted) : 'Not run yet'}</span>
          <span className="skill-eval-toggle" data-testid="skill-eval-toggle">
            {evaluationToggleLabel(counted, open)}
          </span>
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
                    {formatTokens(report.tokensUsed)} tokens
                    {report.tokensEstimated ? ' (estimated)' : ''} of {formatTokens(report.tokenBudget)}
                    {report.model ? `, ${report.model}` : ''}, cost{' '}
                    <Cost
                      value={{
                        costUsd: report.costUsd,
                        costSource: report.costUsd === null ? 'unknown' : 'computed'
                      }}
                    />
                    .
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
                    const lines = evidenceLines(f.evidence)
                    const about = f.skillIds.map((id) => infos.get(id)).filter((i): i is SkillInfo => !!i)
                    return (
                      <li key={f.id} className="skill-finding" data-testid="skill-finding" data-kind={f.kind}>
                        <Badge tone={f.severity === 'warning' ? 'attention' : 'info'} icon={f.severity === 'warning' ? TriangleAlert : Info}>
                          {f.severity === 'warning' ? 'Warning' : 'Note'}
                        </Badge>
                        <div className="skill-finding-main">
                          <span className="mcp-name">{f.title}</span>
                          <span className="skill-text">{f.detail}</span>
                          {lines.map((l) => (
                            <span key={l} className="muted skill-text">
                              {l}
                            </span>
                          ))}
                          {about.length > 0 && (
                            <span className="skill-actions">
                              {about.map((info) => (
                                <Button
                                  key={info.spec.id}
                                  size="sm"
                                  icon={Pencil}
                                  testId="skill-finding-edit"
                                  ariaLabel={`Edit ${info.spec.name}${info.spec.libraryId ? ' in the library' : ''}`}
                                  onClick={() => onEditSkill(info)}
                                >
                                  Edit {info.spec.name}
                                </Button>
                              ))}
                            </span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              {report.suggestions.length > 0 && (
                <ul className="skill-findings" aria-label="Suggested skills">
                  {report.suggestions.map((s) =>
                    !s.appliedSkillId && dismissed.has(s.id) ? (
                      <li key={s.id} className="skill-finding skill-dismissed" data-testid="skill-suggestion-dismissed" data-name={s.draft.name}>
                        <span className="muted">Dismissed {s.draft.name}.</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Undo2}
                          testId="skill-suggestion-undismiss"
                          ariaLabel={`Undo dismiss of ${s.draft.name}`}
                          onClick={() =>
                            setDismissed((d) => {
                              const next = new Set(d)
                              next.delete(s.id)
                              return next
                            })
                          }
                        >
                          Undo
                        </Button>
                      </li>
                    ) : (
                      <Suggestion
                        key={s.id}
                        suggestion={s}
                        project={project}
                        skillsApi={skillsApi}
                        onApplied={(applied) => {
                          void reload()
                          onApplied(applied)
                        }}
                        onShowSkill={onShowSkill}
                        onDismiss={() => setDismissed((d) => new Set(d).add(s.id))}
                      />
                    )
                  )}
                </ul>
              )}
            </>
          )}
        </div>
      </details>
      {actions && <div className="skill-eval-actions">{actions}</div>}
    </div>
  )
}

/** The evaluation switch and token budget (Project settings > Skills). The results and the Evaluate button live in the Catalog. */
export function SkillEvaluationSettings({ project }: { project: Project }): ReactElement {
  const uid = useId()
  const updateProject = useAppStore((s) => s.updateProject)
  const settings = skillEvaluationOf(project)
  // Write only what the user changed: an unset `enabled` keeps following the Team assistant (skillEvaluationOf).
  const save = (next: Partial<typeof settings>): void => updateProject({ ...project, skillEvaluation: { ...project.skillEvaluation, tokenBudget: settings.tokenBudget, ...next } })
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
    </SettingsGroup>
  )
}

function Suggestion({
  suggestion: s,
  project,
  skillsApi,
  onApplied,
  onShowSkill,
  onDismiss
}: {
  suggestion: SkillSuggestion
  project: Project
  skillsApi: ProjectSkills
  onApplied: (applied: SuggestionApplied) => void
  onShowSkill: (skillId: string) => void
  onDismiss: () => void
}): ReactElement {
  const [roles, setRoles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applied = !!s.appliedSkillId

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.orgai.skills.applySuggestion({
        projectId: project.id,
        suggestionId: s.id,
        ...(roles.length ? { roleIds: roles } : {})
      })
      skillsApi.apply(result)
      onApplied({
        skillId: result.skills.find((i) => i.spec.name === s.draft.name)?.spec.id ?? null,
        name: s.draft.name,
        roleCount: roles.length
      })
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
        {applied && s.appliedSkillId && (
          <div className="skill-actions">
            <Button
              size="sm"
              testId="skill-suggestion-show"
              ariaLabel={`Show the skill ${s.draft.name}`}
              onClick={() => onShowSkill(s.appliedSkillId as string)}
            >
              Show skill
            </Button>
          </div>
        )}
        {!applied && (
          <>
            <SkillRolePicker roles={project.roles} value={roles} onChange={setRoles} label={`Roles for ${s.draft.name}`} />
            {error && (
              <p className="invalid-text" role="alert">
                {error}
              </p>
            )}
            <div className="skill-actions">
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                testId="skill-suggestion-apply"
                ariaLabel={`Apply ${s.draft.name}`}
                onClick={() => void apply()}
              >
                Apply
              </Button>
              <Button size="sm" disabled={busy} testId="skill-suggestion-dismiss" ariaLabel={`Dismiss ${s.draft.name}`} onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </>
        )}
      </div>
    </li>
  )
}
