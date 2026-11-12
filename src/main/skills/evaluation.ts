import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { SKILL_EVALUATION_RUNS, SKILL_MAX_SUGGESTIONS, isSafeId, skillEvaluationOf } from '@shared/defaults'
import type { Project, RunRecord, RunSummary, SkillEvaluationReport, SkillFinding, SkillSuggestion } from '@shared/types'
import type { ProjectCompletionInput } from '../runtime/runManager'
import { evaluateSkills, type EvalRun, type EvalSkill } from './evaluate'
import { buildSuggestionPrompt, estimateTokens, parseSuggestions, redactEvidence } from './suggest'
import type { SkillEvaluationApi, SkillServiceApi } from './types'

/** What SkillEvaluationService needs. The constructor signature is the contract index.ts wires; keep it. */
export interface SkillEvaluationDeps {
  /** Reports persist under `<dataDir>/skill-evaluations/<projectId>.json`. */
  dataDir: string
  project(projectId: string): Project | null
  /** The project's runs, newest first or any order (persisted summaries; RunManager.list). */
  listRuns(projectId: string): RunSummary[]
  /** One run with its transcript (RunManager.get). */
  getRun(runId: string): RunRecord | null
  skills: SkillServiceApi
  /** One-shot completion on the project's connection (RunManager.completeForProject). */
  complete(project: Project, input: ProjectCompletionInput): Promise<{ text: string; model?: string }>
}

/** The model step is given up after this long. */
export const SKILL_EVAL_TIMEOUT_MS = 60_000
/** Output tokens reserved per suggestion when checking the budget. */
const OUTPUT_TOKENS_PER_SUGGESTION = 1_500

/** A project-relative path probe that never leaves the project root and never reads file contents. */
export function confinedPathExists(root: string): (rel: string) => boolean {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return () => false
  }
  const fold = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)
  const inside = (p: string): boolean => {
    const a = fold(p)
    const r = fold(realRoot)
    return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep)
  }
  return (rel) => {
    try {
      if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel)) return false
      if (rel.split(/[\\/]/).some((s) => s === '..')) return false
      const full = resolve(realRoot, rel)
      if (!inside(full)) return false
      if (!inside(realpathSync(dirname(full)))) return false
      lstatSync(full)
      return true
    } catch {
      return false
    }
  }
}

/** A one-line, secret-free message of a failed model step. */
function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  const cleaned = (line ?? 'The model step failed')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk|key|tok|token|ghp|gho|xox[a-z])[-_][A-Za-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
  return cleaned.length > 300 ? cleaned.slice(0, 299) + '…' : cleaned
}

/**
 * skills:evaluate and its persisted reports. The checks themselves are pure (evaluate.ts); the model step drafts
 * suggestions (suggest.ts) and never applies them: skills:applySuggestion does, on the user's call.
 *
 * TODO(out of scope): A/B replay evaluation (re-running a saved task with and without a skill to measure its effect)
 * is not built. It would spend real tokens on full agent runs, so it needs its own consent and budget design.
 */
export class SkillEvaluationService implements SkillEvaluationApi {
  private inflight = new Map<string, Promise<SkillEvaluationReport>>()
  /** Model steps in flight, so dispose() can abort them. */
  private modelSteps = new Set<AbortController>()
  /** dispose() ran (the host is shutting down): no new evaluation, no report written by an aborted one. */
  private disposed = false
  /** Activity (backgroundTasks): skill evaluations in flight (one per project at most). */
  inFlightCount(): number { return this.inflight.size }

  constructor(private deps: SkillEvaluationDeps) {}

  /**
   * The host is shutting down (activity quiesce, cli-standalone.md round 6 item 9): abort every model step in flight,
   * so a drain never waits up to SKILL_EVAL_TIMEOUT_MS for one. An aborted evaluation answers its caller with the error
   * and leaves the last saved report as it was. New evaluations are refused. Idempotent.
   */
  dispose(): void {
    this.disposed = true
    for (const ac of this.modelSteps) ac.abort()
    this.modelSteps.clear()
  }

  evaluate(projectId: string): Promise<SkillEvaluationReport> {
    if (this.disposed) return Promise.reject(new Error('OrgAI is shutting down; evaluate the skills once it has started again.'))
    const existing = this.inflight.get(projectId)
    if (existing) return existing
    const p = this.run(projectId).finally(() => this.inflight.delete(projectId))
    this.inflight.set(projectId, p)
    return p
  }

  private async run(projectId: string): Promise<SkillEvaluationReport> {
    const project = this.deps.project(projectId)
    if (!project) throw new Error('Project not found')
    const settings = skillEvaluationOf(project)

    const summaries = this.deps
      .listRuns(projectId)
      .filter((r) => r.kind === 'work')
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, SKILL_EVALUATION_RUNS)
    const runs: EvalRun[] = summaries.map((summary) => {
      let rec: RunRecord | null = null
      try {
        rec = this.deps.getRun(summary.id)
      } catch {
        rec = null
      }
      return { summary: rec?.summary ?? summary, transcript: rec?.transcript ?? [] }
    })

    const skills: EvalSkill[] = this.deps.skills.list(projectId).map((info) => {
      let skillMd = ''
      try {
        skillMd = this.deps.skills.read({ projectId, skillId: info.spec.id }).skillMd
      } catch {
        skillMd = ''
      }
      return { info, skillMd }
    })

    const evaluated = evaluateSkills({ roles: project.roles, skills, runs, pathExists: confinedPathExists(project.path) })
    // Run-derived text (correction excerpts, paths) is secret-masked before the prompt and the saved report.
    const redactFinding = (f: SkillFinding): SkillFinding => ({
      ...f,
      title: redactEvidence(f.title),
      detail: redactEvidence(f.detail),
      ...(f.evidence ? { evidence: { ...f.evidence, ...(f.evidence.paths ? { paths: f.evidence.paths.map(redactEvidence) } : {}), ...(f.evidence.sequence ? { sequence: f.evidence.sequence.map(redactEvidence) } : {}) } } : {})
    })
    const quality = evaluated.quality.map(redactFinding)
    const gaps = evaluated.gaps.map(redactFinding)
    const report: SkillEvaluationReport = {
      projectId,
      at: Date.now(),
      runsConsidered: runs.length,
      findings: [...quality, ...gaps],
      suggestions: [],
      modelAssisted: false,
      tokenBudget: settings.tokenBudget,
      tokensUsed: 0,
      costUsd: null
    }

    if (!settings.enabled) report.skippedReason = 'disabled'
    else if (!gaps.length) report.skippedReason = 'no-gaps'
    else {
      const { system, prompt } = buildSuggestionPrompt(
        gaps,
        skills.map((s) => ({ name: s.info.spec.name, description: s.info.spec.description }))
      )
      const estimate = estimateTokens(system.length + prompt.length) + OUTPUT_TOKENS_PER_SUGGESTION * SKILL_MAX_SUGGESTIONS
      if (estimate > settings.tokenBudget) report.skippedReason = 'budget'
      else await this.modelStep(project, report, system, prompt, estimate, skills, gaps.map((g) => g.id))
    }

    // An evaluation cut by shutdown keeps the last saved report (its error would only replace a good one).
    if (!this.disposed) this.write(report)
    return report
  }

  private async modelStep(project: Project, report: SkillEvaluationReport, system: string, prompt: string, estimate: number, skills: EvalSkill[], gapIds: string[]): Promise<void> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), SKILL_EVAL_TIMEOUT_MS)
    this.modelSteps.add(ac)
    let tokens = 0
    let cost = 0
    let costKnown = false
    let reported = false
    let usageModel: string | undefined
    try {
      const out = await this.deps.complete(project, {
        kind: 'skills',
        tier: 'everyday',
        system,
        prompt,
        signal: ac.signal,
        onUsage: (u) => {
          reported = true
          tokens += (u.tokens.input || 0) + (u.tokens.output || 0) + (u.tokens.cacheRead || 0) + (u.tokens.cacheWrite || 0)
          if (typeof u.costUsd === 'number' && Number.isFinite(u.costUsd)) {
            cost += u.costUsd
            costKnown = true
          }
          if (u.model) usageModel = u.model
        }
      })
      report.modelAssisted = true
      report.suggestions = parseSuggestions(out.text, skills.map((s) => s.info.spec.name), gapIds)
      const model = out.model ?? usageModel
      if (model) report.model = model
      if (reported) {
        report.tokensUsed = tokens
        report.costUsd = costKnown ? cost : null
      } else {
        report.tokensUsed = estimate - OUTPUT_TOKENS_PER_SUGGESTION * SKILL_MAX_SUGGESTIONS + estimateTokens(typeof out.text === 'string' ? out.text.length : 0)
        report.tokensEstimated = true
        report.costUsd = null
      }
    } catch (e) {
      report.skippedReason = 'error'
      report.error = this.disposed ? 'OrgAI shut down before the model answered.' : ac.signal.aborted ? 'The model took too long to answer.' : readableError(e)
      if (reported) report.tokensUsed = tokens
    } finally {
      clearTimeout(timer)
      this.modelSteps.delete(ac)
    }
  }

  private file(projectId: string): string | null {
    return isSafeId(projectId) ? join(this.deps.dataDir, 'skill-evaluations', `${projectId}.json`) : null
  }

  private write(report: SkillEvaluationReport): void {
    const file = this.file(report.projectId)
    if (!file) return
    const tmp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(report), 'utf8')
      renameSync(tmp, file)
    } catch {
      rmSync(tmp, { force: true })
    }
  }

  last(projectId: string): SkillEvaluationReport | null {
    const file = this.file(projectId)
    if (!file) return null
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')) as SkillEvaluationReport
      if (!v || typeof v !== 'object' || v.projectId !== projectId || !Array.isArray(v.findings) || !Array.isArray(v.suggestions)) return null
      return v
    } catch {
      return null
    }
  }

  suggestion(projectId: string, suggestionId: string): SkillSuggestion {
    const s = this.last(projectId)?.suggestions.find((x) => x.id === suggestionId)
    if (!s) throw new Error('Suggestion not found')
    if (s.appliedSkillId) throw new Error('Suggestion already applied')
    return s
  }

  markApplied(projectId: string, suggestionId: string, skillId: string): void {
    const report = this.last(projectId)
    const s = report?.suggestions.find((x) => x.id === suggestionId)
    if (!report || !s) return
    s.appliedSkillId = skillId
    this.write(report)
  }
}
