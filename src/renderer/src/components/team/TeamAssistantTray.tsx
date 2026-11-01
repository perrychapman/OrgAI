import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { useTeamAssistantStore, useTeamReviewSummary } from '../../store/teamAssistant'
import {
  capabilitiesApi,
  clampText,
  foldProgress,
  fromRecommendations,
  fromReview,
  newRequestId,
  sourceProblems,
  suggestionsLine,
  type AssistantResult,
  type ProgressRow
} from '../../lib/capabilities'
import { cleanIpcError } from '../../lib/ipcError'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import DraftPanel from '../DraftPanel'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { Select } from '../ui/Select'
import { Tabs, panelDomId } from '../ui/Tabs'
import { AppliedRow, CapabilityCard, type AppliedInfo } from './CapabilityCard'
import { CapabilityGaps } from './CapabilityGaps'

/** What the Team assistant is looking at: the whole team, or one role. Follows the canvas selection unless pinned. */
export type TeamScope = { kind: 'team' } | { kind: 'role'; roleId: string }

/** Which mode the tray shows. Recommend finds tools and skills; Design is the Architect (always the whole team). */
export type TeamAssistantMode = 'recommend' | 'design'

const MODE_TABS = [
  { id: 'recommend', label: 'Recommend', testId: 'team-mode-recommend' },
  { id: 'design', label: 'Design', testId: 'architect-open' }
]

const outsideKey = (projectId: string): string => `orgai.teamOutside.${projectId}`
function readOutside(projectId: string): boolean {
  try {
    return window.localStorage.getItem(outsideKey(projectId)) === '1'
  } catch {
    return false
  }
}

interface CardState {
  busy?: boolean
  error?: string | null
  applied?: AppliedInfo
}

/**
 * Body of the canvas frame's tray on the Team tab: the Team assistant. Both modes stay mounted (the inactive one is
 * hidden) so a search keeps running while the user designs, and the other way round. Nothing here is a Live run.
 */
export default function TeamAssistantTray({
  project,
  scope,
  mode,
  onModeChange
}: {
  project: Project
  scope?: TeamScope
  mode: TeamAssistantMode
  onModeChange: (mode: TeamAssistantMode) => void
}): ReactElement {
  return (
    <div className="team-assistant" data-testid="team-assistant" data-mode={mode}>
      <div className="team-tray-head">
        <h2>Team assistant</h2>
        <div className="grow" />
        <Tabs tabs={MODE_TABS} value={mode} onChange={(id) => onModeChange(id as TeamAssistantMode)} label="Assistant mode" idPrefix="team-mode" compact />
      </div>
      <div role="tabpanel" id={panelDomId('team-mode', 'recommend')} hidden={mode !== 'recommend'} className="team-mode-pane">
        <RecommendPane project={project} scope={scope} active={mode === 'recommend'} onDesign={() => onModeChange('design')} />
      </div>
      <div role="tabpanel" id={panelDomId('team-mode', 'design')} hidden={mode !== 'design'} className="team-mode-pane team-tray-body">
        <DraftPanel project={project} variant="tray" />
      </div>
    </div>
  )
}

function RecommendPane({ project, scope, active, onDesign }: { project: Project; scope?: TeamScope; active: boolean; onDesign: () => void }): ReactElement {
  const replaceProject = useAppStore((s) => s.replaceProject)
  const summary = useTeamReviewSummary(project.id)
  const rootRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const openedFor = useRef<string | null>(null)
  const reqRef = useRef<string | null>(null)
  const [result, setResult] = useState<AssistantResult | null>(null)
  const [phase, setPhase] = useState<'idle' | 'working' | 'error'>('idle')
  const [working, setWorking] = useState<'recommend' | 'recheck'>('recommend')
  const [progress, setProgress] = useState<ProgressRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [outside, setOutside] = useState(() => readOutside(project.id))
  const [pinned, setPinned] = useState<string | null>(null)
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [gapsHidden, setGapsHidden] = useState<Set<string>>(new Set())
  const [announce, setAnnounce] = useState('')
  const [sinceLine, setSinceLine] = useState<string | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Another project: start clean.
  useEffect(() => {
    setOutside(readOutside(project.id))
    setResult(null)
    setCards({})
    setDismissed(new Set())
    setGapsHidden(new Set())
    setPhase('idle')
    setError(null)
    setPinned(null)
    setSinceLine(null)
  }, [project.id])

  // Opening the Team tab: show the last review at once, then re-check once per mount (main throttles an unchanged one).
  useEffect(() => {
    if (openedFor.current === project.id) return
    openedFor.current = project.id
    void capabilitiesApi
      .lastReview(project.id)
      .then((r) => {
        if (alive.current && r) setResult((prev) => prev ?? fromReview(r))
      })
      .catch(() => {})
    void capabilitiesApi
      .review(project.id, 'opened')
      .then((r) => {
        if (alive.current) setResult((prev) => (prev && prev.origin === 'recommend' ? prev : fromReview(r)))
      })
      .catch(() => {})
  }, [project.id])

  // The "N suggestions since your last run" line is read once, then the count of new items is cleared (the tray was viewed).
  useEffect(() => {
    if (!summary || summary.projectId !== project.id) return
    if (summary.newCount > 0 && !sinceLine) setSinceLine(suggestionsLine(summary))
    if (active && summary.newCount > 0) useTeamAssistantStore.getState().clearNew(project.id)
  }, [summary, active, project.id, sinceLine])

  useEffect(
    () =>
      capabilitiesApi.onProgress((e) => {
        if (e.projectId !== project.id || e.requestId !== reqRef.current) return
        setProgress((rows) => foldProgress(rows, e))
      }),
    [project.id]
  )

  const roleId = pinned !== null ? (pinned === 'team' ? undefined : pinned) : scope?.kind === 'role' ? scope.roleId : undefined
  const scopeRole = roleId ? project.roles.find((r) => r.id === roleId) : undefined
  const scopeValue = scopeRole ? scopeRole.id : 'team'
  const scopeName = scopeRole ? scopeRole.name : 'the whole team'

  const focusPrimary = useCallback((): void => {
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid=team-recommend]')?.focus())
  }, [])

  const run = async (kind: 'recommend' | 'recheck'): Promise<void> => {
    const id = newRequestId()
    reqRef.current = id
    setWorking(kind)
    setPhase('working')
    setProgress([])
    setError(null)
    setAnnounce(kind === 'recommend' ? 'Looking at this repo and your tools.' : 'Re-checking the setup.')
    try {
      const out =
        kind === 'recommend'
          ? fromRecommendations(await capabilitiesApi.recommend(project.id, id, outside, roleId))
          : fromReview(await capabilitiesApi.review(project.id, 'manual', id, outside))
      if (!alive.current) return
      setResult(out)
      setCards({})
      setDismissed(new Set())
      setGapsHidden(new Set())
      setPhase('idle')
      const n = out.recommendations.length
      setAnnounce(`${out.partial ? 'Partial results: ' : ''}Found ${n} recommendation${n === 1 ? '' : 's'} and ${out.gaps.length} gap${out.gaps.length === 1 ? '' : 's'}.`)
    } catch (e) {
      if (!alive.current) return
      setError(cleanIpcError(e))
      setPhase('error')
    } finally {
      if (reqRef.current === id) reqRef.current = null
    }
  }

  const cancel = (): void => {
    if (reqRef.current) void capabilitiesApi.cancel(reqRef.current).catch(() => {})
    setAnnounce('Cancelled. Anything already found is kept.')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && phase === 'working') {
      e.stopPropagation()
      cancel()
    }
  }

  const patch = (recId: string, p: CardState): void => setCards((c) => ({ ...c, [recId]: { ...c[recId], ...p } }))

  const apply = async (recId: string, candidateId: string, name: string, roleIds: string[], access: 'read' | 'full', recAccess: 'read' | 'full'): Promise<void> => {
    if (!result) return
    patch(recId, { busy: true, error: null })
    try {
      // Access is sent only when the user changed it; otherwise the recommendation keeps its own.
      const out = await capabilitiesApi.apply({
        projectId: project.id,
        digest: result.digest,
        recommendationId: recId,
        candidateId,
        roleIds,
        ...(access !== recAccess ? { access } : {})
      })
      replaceProject(out.project)
      const names = roleIds.map((id) => project.roles.find((r) => r.id === id)?.name ?? id)
      patch(recId, {
        busy: false,
        applied: { name: out.applied.name || name, roleNames: names, access: out.applied.access, undoId: out.undoId, needsSetup: out.needsSetup, notes: out.notes }
      })
      setAnnounce(`Applied ${clampText(out.applied.name || name, 60)} to ${names.join(', ')}.`)
    } catch (e) {
      patch(recId, { busy: false, error: `${cleanIpcError(e)} Re-check the setup and try again.` })
    }
  }

  const undo = async (recId: string): Promise<void> => {
    const info = cards[recId]?.applied
    if (!info) return
    patch(recId, { busy: true, error: null })
    try {
      const out = await capabilitiesApi.undo(project.id, info.undoId)
      replaceProject(out.project)
      setCards((c) => ({ ...c, [recId]: {} }))
      setAnnounce('Undone.')
      focusPrimary()
    } catch (e) {
      patch(recId, { busy: false, error: cleanIpcError(e) })
    }
  }

  const dismiss = (recId: string): void => {
    void capabilitiesApi.dismiss(project.id, recId).catch(() => {})
    setDismissed((d) => new Set(d).add(recId))
    window.requestAnimationFrame(() => {
      const root = rootRef.current
      ;(root?.querySelector<HTMLElement>('[data-testid=capability-card] button:not([disabled])') ?? root?.querySelector<HTMLElement>('[data-testid=team-recommend]'))?.focus()
    })
  }

  const finishSetup = (): void => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.mcpLibrary)
    useAppStore.getState().setView('appSettings')
  }

  const shown = (result?.recommendations ?? []).filter((r) => {
    if (dismissed.has(r.id) || !result?.items[r.candidateId]) return false
    return cards[r.id]?.applied ? true : !roleId || r.roleIds.includes(roleId)
  })
  const open = shown.filter((r) => !cards[r.id]?.applied)
  const problems = result ? sourceProblems(result.sources) : []
  const working_ = phase === 'working'
  const gaps = (result?.gaps ?? []).filter((g, i) => (!roleId || g.roleId === roleId) && !gapsHidden.has(`${g.roleId}:${i}`))
  const line = open.length > 0 ? (sinceLine ?? suggestionsLine(summary)) : null
  const empty = !result || (result.origin === 'review' && shown.length === 0 && gaps.length === 0)

  return (
    <div className="team-recommend" ref={rootRef} onKeyDown={onKeyDown} data-testid="team-recommend-pane" data-phase={phase}>
      <p className="sr-only" role="status" aria-live="polite" data-testid="team-announce">
        {announce}
      </p>
      <div className="team-controls">
        <div className="team-scope" data-testid="team-scope">
          <label className="team-scope-label" htmlFor="team-scope-select">
            For
          </label>
          <Select
            id="team-scope-select"
            value={scopeValue}
            onChange={(v) => setPinned(v)}
            disabled={working_}
            options={[{ value: 'team', label: 'The whole team' }, ...project.roles.map((r) => ({ value: r.id, label: clampText(r.name, 40) }))]}
          />
          {pinned !== null && (
            <Button size="sm" variant="ghost" onClick={() => setPinned(null)} title="Follow the role selected on the chart again">
              Pinned
            </Button>
          )}
        </div>
        <div className="team-actions">
          {working_ ? (
            <>
              <Button variant="primary" size="sm" loading disabled testId="team-recommend">
                Looking…
              </Button>
              <Button size="sm" icon={X} onClick={cancel} testId="team-cancel">
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" icon={Sparkles} onClick={() => void run('recommend')} testId="team-recommend">
                Recommend tools and skills
              </Button>
              <Button size="sm" icon={RefreshCw} onClick={() => void run('recheck')} testId="team-recheck">
                Re-check setup
              </Button>
            </>
          )}
        </div>
      </div>
      <Checkbox
        checked={outside}
        disabled={working_}
        onChange={(v) => {
          setOutside(v)
          try {
            window.localStorage.setItem(outsideKey(project.id), v ? '1' : '0')
          } catch {
            /* the choice just is not remembered */
          }
        }}
        label="Also search outside sources (MCP Registry, anthropics/skills, GitHub)"
        description="Searches the internet. Results are unverified."
        testId="team-include-outside"
      />
      <p className="hint team-cost">Recommend asks the AI and counts toward your usage. Re-check setup is free.</p>

      {working_ && (
        <ul className="team-progress" data-testid="team-progress" aria-label="Progress">
          {progress.length === 0 && (
            <li className="team-progress-row">
              <Icon icon={Loader2} size="sm" />
              <span>{working === 'recommend' ? 'Starting' : 'Re-checking'}…</span>
            </li>
          )}
          {progress.map((p) => (
            <li key={p.label} className="team-progress-row" data-state={p.state}>
              {p.state === 'running' ? <Icon icon={Loader2} size="sm" /> : <span className={`team-progress-dot state-${p.state}`} aria-hidden="true" />}
              <span>
                {p.label}
                {p.state === 'skipped' ? ' (skipped)' : p.state === 'error' ? ' (failed)' : p.state === 'rateLimited' ? ' (busy)' : p.state === 'done' && p.count !== undefined ? ` (${p.count})` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {phase === 'error' && (
        <Banner
          tone="danger"
          title="Could not finish"
          testId="team-error"
          actions={
            <Button size="sm" onClick={() => void run(working)}>
              Try again
            </Button>
          }
        >
          {error}
        </Banner>
      )}

      {result?.fallbackReason && (
        <Banner tone="info" testId="team-fallback" title={`Recommended without the AI because ${result.fallbackReason}.`}>
          These matches use keywords only.
        </Banner>
      )}
      {result?.partial && (
        <p className="hint" data-testid="team-partial">
          Partial results: the search stopped early.
        </p>
      )}
      {problems.map((p) => (
        <p key={p.source} className="hint team-problem" data-testid="team-source-problem">
          {p.text}
        </p>
      ))}
      {line && (
        <p className="team-since" data-testid="team-since">
          {line}
        </p>
      )}

      {empty && !working_ && (
        <div className="team-empty" data-testid="team-empty">
          <p className="rationale">
            Find tools and skills for your team. I look at this repo, your computer and your library first.
            {summary && summary.evidenceCount > 0 ? ` ${summary.evidenceCount} signal${summary.evidenceCount === 1 ? '' : 's'} from past runs will inform the choice.` : ''}
          </p>
        </div>
      )}
      {result && !empty && shown.length === 0 && gaps.length === 0 && !working_ && (
        <div className="team-empty" data-testid="team-no-match">
          <p className="rationale">Nothing matched {scopeName}. Add one yourself from What it can use, or describe the need to the Architect.</p>
          <Button size="sm" onClick={onDesign}>
            Open the Architect
          </Button>
        </div>
      )}

      <div className="capability-list" data-testid="capability-list">
        {shown.map((rec) => {
          const item = result!.items[rec.candidateId]
          const st = cards[rec.id] ?? {}
          if (st.applied) {
            return (
              <AppliedRow
                key={rec.id}
                info={st.applied}
                busy={st.busy}
                error={st.error}
                onUndo={() => void undo(rec.id)}
                onSetup={st.applied.needsSetup ? finishSetup : undefined}
              />
            )
          }
          return (
            <CapabilityCard
              key={rec.id}
              item={item}
              rec={rec}
              roles={project.roles}
              busy={st.busy}
              error={st.error}
              primary={open[0]?.id === rec.id}
              onApply={(roleIds, access) => void apply(rec.id, rec.candidateId, item.name, roleIds, access, rec.access)}
              onDismiss={() => dismiss(rec.id)}
            />
          )
        })}
      </div>

      <CapabilityGaps
        gaps={gaps}
        roles={project.roles}
        onAsk={onDesign}
        onDismiss={(i) => {
          const g = gaps[i]
          const idx = (result?.gaps ?? []).indexOf(g)
          setGapsHidden((h) => new Set(h).add(`${g.roleId}:${idx}`))
        }}
      />

      {result && result.sources.length > 0 && (
        <details className="disclosure team-looked" data-testid="team-looked">
          <summary>What I looked at</summary>
          <ul className="disclosure-body team-looked-list">
            {result.sources.map((s) => (
              <li key={s.source}>
                <span>{clampText(s.label, 60)}</span>
                <span className="hint">
                  {s.state === 'found' ? `${s.count} found` : s.state === 'empty' ? 'nothing usable' : s.state === 'missing' ? 'not present' : s.state === 'skipped' ? 'skipped' : s.state === 'rateLimited' ? 'busy' : 'did not answer'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
