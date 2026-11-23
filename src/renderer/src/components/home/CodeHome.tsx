import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { useId, useMemo, useState } from 'react'
import type { Project, TodoItem } from '@shared/types'
import { waitingItems } from '@shared/view/needsYou'
import { useAppStore } from '../../store/useAppStore'
import { useConfirm } from '../ui/ConfirmDialog'
import { Button } from '../ui/Button'
import { startSessionFromTodo } from '../../lib/todoStart'
import { cleanIpcError } from '../../lib/ipcError'
import { useSchedules } from '../schedules/useSchedules'
import { HomeLink, HomeSection } from './HomeSection'
import { openNewRunWith } from './startRun'
import { useLiveKey, useMonthOverview, useProjectGit, useProjectHistory, useProjectSpend, useProjectTodos, useScheduleOutcomes } from './useHomeData'
import {
  QUICK_STARTS,
  RUNNING_MARKS_MAX,
  homeTodos,
  monthSpend,
  monthSpendFrom,
  projectSchedules,
  runningLine,
  runningNow,
  safeSquareColor,
  teamLine,
  teamSummary,
  type RunningNowIn,
  type TodoHomeRow
} from '../../lib/projectHome'
import { healthLines, mergedRows, nightlyBars, nightlySummary, repoStrip } from '../../lib/projectHomeGit'
import { BAND_BREATHING_MAX } from '../../lib/dashboardBand'
import { displayRunName } from '../../lib/orgChange'
import { modKeyLabel, currentPlatform } from '../../lib/platform'
import { useNow } from '../dashboard/useDashboardData'

/**
 * ProjectHome (docs/design/ui-overhaul/project/ProjectHome.dc.html): the Home tab of a code project, drawn like a
 * workbench: monospace lowercase labels, a violet accent, a dot-grid ground. Every section is built from what the app
 * really holds (the store, the repository read, usage, schedules, to-dos) and is left out when it has nothing to say.
 */
export default function CodeHome({ project }: { project: Project }): ReactElement {
  const setView = useAppStore((s) => s.setView)
  const focusRun = useAppStore((s) => s.focusRun)
  const setProjectSettingsPane = useAppStore((s) => s.setProjectSettingsPane)
  const openSchedules = useAppStore((s) => s.openSchedules)
  const now = useNow()
  const liveKey = useLiveKey(project.id)
  const gitState = useProjectGit(project.id, liveKey)
  const git = gitState.kind === 'ready' ? gitState.git : null
  const overview = useMonthOverview(project.id, liveKey)
  const projectSpend = useProjectSpend(project.id, liveKey)
  const todos = useProjectTodos(project.id)
  const schedules = useSchedules()
  const history = useProjectHistory(project.id)

  const runs = useAppStore((s) => s.runs)
  const running = useMemo(
    () =>
      runningNow(
        Object.values(runs)
          .filter((r) => r.summary.projectId === project.id && r.summary.kind === 'work')
          .map((r): RunningNowIn => ({ summary: r.summary, agents: r.agents, plan: r.plan, decisions: waitingItems(r, 'code').length }))
      ),
    [runs, project.id]
  )

  const strip = repoStrip(git, project.path, now)
  const mySchedules = useMemo(() => projectSchedules(schedules.list, project.id), [schedules.list, project.id])
  const scheduleRows = useMemo(() => (schedules.list ?? []).filter((s) => s.target.kind === 'team' && s.target.projectId === project.id), [schedules.list, project.id])
  const health = healthLines(git, scheduleRows, now)
  const merged = mergedRows(git, now)
  const spend = monthSpendFrom(projectSpend, overview) ?? monthSpend(overview)
  const todo = homeTodos(todos ?? undefined)
  const team = useMemo(() => teamSummary(project.roles), [project.roles])
  const runCount = history.filter((h) => h.kind === 'work').length

  return (
    <div className="home-page code-home" data-testid="project-home" data-kind="code">
      <div className="home-scroll">
        <div className="home-repo" data-testid="home-repo" role="list" aria-label="Repository">
          {strip.map((it) => (
            <span key={it.key} className="home-repo-item" role="listitem" title={it.title} data-key={it.key}>
              <span className="home-repo-mark" data-mark={it.mark} aria-hidden="true" />
              <span className="home-repo-label">{it.label}</span>
              <span className={`home-repo-value${it.key === 'folder' ? ' is-path' : ''}`}>{it.value}</span>
            </span>
          ))}
        </div>
        {gitState.kind === 'none' && (
          <p className="home-git-note" data-testid="home-git-none">
            No git information for this folder.
          </p>
        )}
        {gitState.kind === 'failed' && (
          <p className="home-git-note" data-tone="warn" data-testid="home-git-failed">
            Git information could not be read.
          </p>
        )}

        <div className="home-ground">
          <div className="home-row">
            <NewRunBox project={project} hasRuns={runCount > 0} />
            {running && (
              <HomeSection title="running now" className="home-running" testId="home-running" enter={0} action={<HomeLink onClick={() => void focusRun(project.id, running.runId)} testId="home-running-open" label={`Open the running run`}>Open</HomeLink>}>
                <RunningBody run={running} now={now} projectId={project.id} />
              </HomeSection>
            )}
          </div>

          <div className="home-grid">
            {health.length > 0 && (
              <HomeSection title="health" testId="home-health" enter={0} note={git?.defaultBranch ? `${git.defaultBranch}` : undefined}>
                <ul className="home-lines" aria-label="Health">
                  {health.map((h) => (
                    <li key={h.key} className="home-line" data-tone={h.tone}>
                      <span className="home-state-dot" data-tone={h.tone} aria-hidden="true" />
                      <span className="home-line-main">{h.label}</span>
                      <span className="home-line-value">{h.value}</span>
                    </li>
                  ))}
                </ul>
              </HomeSection>
            )}

            {merged.length > 0 && (
              <HomeSection title="merged lately" testId="home-merged" enter={1} action={<HomeLink onClick={() => setView('history')} testId="home-all-runs">All runs</HomeLink>}>
                <ul className="home-rows" aria-label="Recent commits">
                  {merged.map((m) => (
                    <li key={m.key} className="home-row-line">
                      <span className="home-row-title" title={m.subject}>
                        {m.subject}
                      </span>
                      {m.sha && (
                        <span className="home-sha" title="Commit">
                          {m.sha.slice(0, 7)}
                        </span>
                      )}
                      {(m.added !== undefined || m.removed !== undefined) && (
                        <span className="home-diffstat">
                          {m.added !== undefined && <span className="home-add">+{m.added}</span>}
                          {m.added !== undefined && m.removed !== undefined && ' '}
                          {m.removed !== undefined && <span className="home-del">−{m.removed}</span>}
                        </span>
                      )}
                      <span className="home-age">{m.when}</span>
                    </li>
                  ))}
                </ul>
              </HomeSection>
            )}

            {todo.open > 0 && <TodosBox rows={todo.rows} open={todo.open} />}

            <HomeSection title="team" testId="home-team" action={<HomeLink onClick={() => setView('team')} testId="home-team-edit">Edit</HomeLink>}>
              {team.groups.length > 0 && (
                <ul className="home-groups" aria-label="Groups">
                  {team.groups.map((g) => (
                    <li key={g.id} className="home-group">
                      <span className="home-group-name" title={g.name}>
                        {g.name}
                      </span>
                      <span className="home-squares" aria-hidden="true">
                        {g.colors.map((c, i) => (
                          <span key={i} className="home-square" style={{ background: safeSquareColor(c) }} />
                        ))}
                      </span>
                      <span className="home-group-count">{g.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="home-summary" data-testid="home-team-line">
                {teamLine(team.roleCount, project.permissionMode)}
              </p>
            </HomeSection>

            {spend && (
              <HomeSection
                title="spend this month"
                testId="home-spend"
                enter={2}
                action={
                  <HomeLink
                    onClick={() => {
                      setProjectSettingsPane(project.id, 'limits')
                      setView('settings')
                    }}
                    testId="home-spend-limits"
                  >
                    Limits
                  </HomeLink>
                }
              >
                <div className="home-figure-row">
                  <span className="home-figure" title={spend.title} data-testid="home-spend-figure">
                    {spend.text}
                  </span>
                  <span className="home-figure-note">{spend.runs === 1 ? '1 run' : `${spend.runs} runs`} this month</span>
                </div>
                {(spend.limitText || spend.projectionText) && <p className="home-summary">{[spend.limitText, spend.projectionText].filter(Boolean).join(' · ')}</p>}
                {spend.typicalText && <p className="home-summary">A typical run costs {spend.typicalText}.</p>}
                {spend.unknownRuns > 0 && <p className="home-hint">{spend.unknownRuns === 1 ? '1 run has' : `${spend.unknownRuns} runs have`} no known price, so the figure is a lower bound.</p>}
              </HomeSection>
            )}

            {mySchedules.length > 0 && (
              <HomeSection title="scheduled" testId="home-schedules" enter={3} action={<HomeLink onClick={() => openSchedules()} testId="home-schedules-open">Schedules</HomeLink>}>
                <ul className="home-rows" aria-label="Schedules">
                  {mySchedules.map((s) => (
                    <li key={s.id} className="home-row-line">
                      <span className="home-row-title" title={s.name}>
                        {s.name}
                        {!s.enabled && <span className="home-muted"> · paused</span>}
                      </span>
                      <ScheduleBar scheduleId={s.id} refreshKey={liveKey} />
                      <span className="home-mono-note" data-tone={s.tone}>
                        {s.last}
                      </span>
                    </li>
                  ))}
                </ul>
              </HomeSection>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- schedule outcome bar ----------

const BAR_W = 5
const BAR_GAP = 2
const BAR_H = 16

/**
 * The outcome of a schedule's recent runs, oldest left: one bar per handled slot (green finished, amber skipped or
 * needing you, red failed; height = relative cost where known, otherwise a fixed low bar). Read through the peek
 * channel so Home never clears the Schedules unread count. Fewer than 3 entries, or no answer: nothing is drawn.
 */
function ScheduleBar({ scheduleId, refreshKey }: { scheduleId: string; refreshKey: string }): ReactElement | null {
  const entries = useScheduleOutcomes(scheduleId, refreshKey)
  const now = useNow()
  const bars = useMemo(() => (entries ? nightlyBars(entries, now) : null), [entries, now])
  if (!bars) return null
  const w = bars.length * (BAR_W + BAR_GAP) - BAR_GAP
  return (
    <svg className="home-nightly" width={w} height={BAR_H} viewBox={`0 0 ${w} ${BAR_H}`} role="img" aria-label={nightlySummary(bars)} data-testid="home-nightly">
      {bars.map((b, i) => {
        const h = Math.max(3, Math.round((b.height / 100) * BAR_H))
        return (
          <rect key={i} className="home-nightly-bar" data-tone={b.tone} x={i * (BAR_W + BAR_GAP)} y={BAR_H - h} width={BAR_W} height={h} rx={1}>
            <title>{b.label}</title>
          </rect>
        )
      })}
    </svg>
  )
}

// ---------- "> new run" ----------

function NewRunBox({ project, hasRuns }: { project: Project; hasRuns: boolean }): ReactElement {
  const [text, setText] = useState('')
  const id = useId()
  const mod = modKeyLabel(currentPlatform())
  const start = (message: string): void => openNewRunWith(project.id, message)
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      start(text)
    }
  }
  return (
    <section className="home-section home-newrun glass" aria-labelledby={`${id}-h`} data-testid="home-new-run">
      <h2 id={`${id}-h`} className="home-section-title home-prompt-mark">
        {'> new run'}
      </h2>
      <label htmlFor={`${id}-t`} className="home-sr">
        What should the team build or fix?
      </label>
      <textarea
        id={`${id}-t`}
        className="home-newrun-text"
        rows={2}
        value={text}
        placeholder="What should the team build or fix?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        aria-describedby={`${id}-hint`}
        data-testid="home-new-run-text"
      />
      <div className="home-newrun-actions">
        <span className="home-quick" role="group" aria-label="Ways to start">
          {QUICK_STARTS.filter((q) => hasRuns || q !== 'Review my last change').map((q) => (
            <button key={q} type="button" className="home-quick-chip" onClick={() => start(q)} data-testid="home-quick">
              {q}
            </button>
          ))}
        </span>
        <span className="home-spacer" />
        <Button variant="primary" onClick={() => start(text)} testId="home-start-run">
          Start run
        </Button>
      </div>
      <p id={`${id}-hint`} className="home-hint">
        Opens the New run page with your message, where you pick a model and send. {mod}+Enter does the same.
      </p>
    </section>
  )
}

// ---------- running now ----------

function RunningBody({ run, now, projectId }: { run: NonNullable<ReturnType<typeof runningNow>>; now: number; projectId: string }): ReactElement {
  const title = useAppStore((s) => displayRunName(s.runs[run.runId]?.summary))
  const line = runningLine(run)
  void now
  void projectId
  return (
    <>
      <p className="home-run-title" title={title}>
        {title}
      </p>
      {run.marks.length > 0 && (
        <div className="home-marks" role="img" aria-label={run.summary} data-testid="home-running-marks">
          {run.marks.slice(0, RUNNING_MARKS_MAX).map((m, i) => (
            <span
              key={m.id}
              className={`home-mark${m.state === 'working' && i < BAND_BREATHING_MAX ? ' motion-pulse' : ''}${m.state === 'waiting' ? ' motion-breathe' : ''}`}
              data-state={m.state}
              style={{ '--i': i } as CSSProperties}
            />
          ))}
          {run.more > 0 && <span className="home-marks-more">+{run.more}</span>}
        </div>
      )}
      <p className="home-run-line" data-testid="home-running-line">
        {line.parts.map((p, i) => (
          <span key={i}>{i > 0 ? ' · ' : ''}{p}</span>
        ))}
        {line.waitingText && (
          <span>
            {line.parts.length > 0 ? ' · ' : ''}
            <span className="home-waiting">{line.waitingText}</span>
          </span>
        )}
        {line.cost && (
          <span>
            {line.parts.length > 0 || line.waitingText ? ' · ' : ''}
            {line.cost}
          </span>
        )}
      </p>
    </>
  )
}

// ---------- to-dos ----------

function TodosBox({ rows, open }: { rows: TodoHomeRow[]; open: number }): ReactElement {
  const setView = useAppStore((s) => s.setView)
  const { confirm, dialog } = useConfirm()
  const [error, setError] = useState<string | null>(null)
  const run = async (item: TodoItem): Promise<void> => {
    setError(null)
    try {
      await startSessionFromTodo(item, confirm)
    } catch (e) {
      setError(cleanIpcError(e, 'The session could not be prepared.'))
    }
  }
  return (
    <HomeSection title="to-dos" testId="home-todos" enter={1} note={`${open} open`} action={<HomeLink onClick={() => setView('todos')} testId="home-todos-open">All to-dos</HomeLink>}>
      <ul className="home-rows" aria-label="Open to-dos">
        {rows.map((r) => (
          <li key={r.id} className="home-row-line">
            <span className="home-todo-box" aria-hidden="true" />
            <span className="home-row-title home-wrap" title={r.title}>
              {r.title}
              {r.fromTeam && <span className="home-muted"> · from the team</span>}
            </span>
            <button type="button" className="home-mini-btn" onClick={() => void run(r.item)} aria-label={`Run: ${r.title}`} data-testid="home-todo-run">
              Run
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="home-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </HomeSection>
  )
}
