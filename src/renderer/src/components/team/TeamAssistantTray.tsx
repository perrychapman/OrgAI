import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, Settings2, Sparkles, X } from 'lucide-react'
import type { Project, TeamReview } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { EMPTY_SESSION, useTeamAssistantStore, useTeamReviewSummary, type CardState, type TeamSession } from '../../store/teamAssistant'
import {
  capabilitiesApi,
  clampText,
  foldProgress,
  fromRecommendations,
  fromReview,
  gapsJumpText,
  newRequestId,
  PROACTIVE_VISIBLE,
  readDismissed,
  resultsHeadText,
  sinceLine,
  skillsFirst,
  sourceProblems,
  teamSeenKey,
  unseenSuggestions,
  type AssistantResult,
  type DismissedEntry,
  type ProgressRow
} from '../../lib/capabilities'
import { cleanIpcError } from '../../lib/ipcError'
import { openConnectorSetup } from './openConnectorSetup'
import DraftPanel from '../DraftPanel'
import { OrgChangePointer } from './OrgChangePointer'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { openProjectSettings } from '../../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { Select } from '../ui/Select'
import { Tabs, panelDomId } from '../ui/Tabs'
import { AppliedRow, CapabilityCard, DismissedList, DismissedRow, type AppliedInfo } from './CapabilityCard'
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

function readSeenAt(projectId: string): string | null {
  try {
    return window.localStorage.getItem(teamSeenKey(projectId))
  } catch {
    return null
  }
}
function writeSeenAt(projectId: string): void {
  try {
    window.localStorage.setItem(teamSeenKey(projectId), new Date().toISOString())
  } catch {
    /* the visit just is not remembered */
  }
}

/**
 * Body of the canvas frame's tray on the Team tab: the Team assistant. Both modes stay mounted (the inactive one is
 * hidden) so a search keeps running while the user designs, and the other way round. Design starts an org change
 * session, an ordinary setup run on Live; the tray only points at it.
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
  const hasResults = useTeamAssistantStore((s) => !!s.sessions[project.id]?.result)
  const trayPhase = mode === 'design' ? 'design' : hasResults ? 'results' : 'recommend'
  return (
    <div className="team-assistant" data-testid="team-assistant" data-mode={mode} data-tray-phase={trayPhase}>
      <div className="team-tray-head">
        <h2>Team assistant</h2>
        <div className="grow" />
        <Tabs tabs={MODE_TABS} value={mode} onChange={(id) => onModeChange(id as TeamAssistantMode)} label="Assistant mode" idPrefix="team-mode" compact />
        {/* The Off / Free checks / AI suggestions select lives in Project settings > Permissions > Advanced (ux-review-config-2 N6). */}
        <IconButton
          icon={Settings2}
          size="sm"
          label="Team assistant settings"
          testId="team-assistant-settings"
          onClick={() => openProjectSettings(project.id, PROJECT_SETTINGS_SECTIONS.teamAssistant)}
        />
      </div>
      {/* Both modes: an open org change session is never hidden behind the Design tab (walk H1). */}
      <OrgChangePointer project={project} />
      <div role="tabpanel" id={panelDomId('team-mode', 'recommend')} hidden={mode !== 'recommend'} className="team-mode-pane">
        <RecommendPane project={project} scope={scope} active={mode === 'recommend'} onDesign={() => onModeChange('design')} />
      </div>
      <div role="tabpanel" id={panelDomId('team-mode', 'design')} hidden={mode !== 'design'} className="team-mode-pane team-tray-body">
        <DraftPanel project={project} />
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
  // The latest result, the card states and the dismissals live in the store: they survive a tab switch and a remount.
  const session = useTeamAssistantStore((s) => s.sessions[project.id]) ?? EMPTY_SESSION
  const update = useTeamAssistantStore((s) => s.updateSession)
  const result = session.result
  const cards = session.cards
  const dismissed = useMemo(() => new Set(session.dismissed), [session.dismissed])
  const dismissedCandidates = session.dismissedCandidates
  const gapsHidden = useMemo(() => new Set(session.gapsHidden), [session.gapsHidden])
  const pid = project.id
  const setResult = (v: AssistantResult | null | ((p: AssistantResult | null) => AssistantResult | null)): void =>
    update(pid, (s: TeamSession) => ({ result: typeof v === 'function' ? v(s.result) : v }))
  const setCards = (v: (c: Record<string, CardState>) => Record<string, CardState>): void => update(pid, (s) => ({ cards: v(s.cards) }))
  const resultRef = useRef<HTMLHeadingElement>(null)
  const [phase, setPhase] = useState<'idle' | 'working' | 'error'>('idle')
  const [working, setWorking] = useState<'recommend' | 'recheck'>('recommend')
  const [progress, setProgress] = useState<ProgressRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [outside, setOutside] = useState(() => readOutside(project.id))
  const [pinned, setPinned] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [sinceText, setSinceText] = useState<string | null>(null)
  // Just-dismissed cards: a one-row "Dismissed X. Undo" in the card's place for a few seconds.
  const [recent, setRecent] = useState<Record<string, { name: string; candidateId: string }>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [persisted, setPersisted] = useState<DismissedEntry[]>([])
  const [showAll, setShowAll] = useState(false)
  // The persisted review as read on mount, before an 'opened' re-check replaces it (feeds the since line).
  const [mountReview, setMountReview] = useState<{ trigger: TeamReview['trigger']; checkedAt: string; pendingCount: number } | null>(null)

  useEffect(() => {
    alive.current = true
    const t = timers.current
    return () => {
      alive.current = false
      for (const k of Object.keys(t)) clearTimeout(t[k])
    }
  }, [])

  // Another project: start clean.
  useEffect(() => {
    setOutside(readOutside(project.id))
    setPhase('idle')
    setError(null)
    setPinned(null)
    setSinceText(null)
    setRecent({})
    setPersisted([])
    setShowAll(false)
    setMountReview(null)
  }, [project.id])

  // Opening the Team tab: show the last review at once, then re-check once per mount (main throttles an unchanged one).
  useEffect(() => {
    if (openedFor.current === project.id) return
    openedFor.current = project.id
    void capabilitiesApi
      .lastReview(project.id)
      .then((r) => {
        if (!alive.current || !r) return
        setPersisted(readDismissed(r))
        setMountReview({ trigger: r.trigger, checkedAt: r.checkedAt, pendingCount: r.pendingCount })
        // A held review older than the persisted one (a run ended meanwhile) is replaced; a Recommend result is kept.
        setResult((prev) => (prev && (prev.origin === 'recommend' || (prev.checkedAt ?? '') >= r.checkedAt) ? prev : fromReview(r)))
      })
      .catch(() => {})
    void capabilitiesApi
      .review(project.id, 'opened')
      .then((r) => {
        if (!alive.current) return
        setPersisted(readDismissed(r))
        setResult((prev) => (prev && prev.origin === 'recommend' ? prev : fromReview(r)))
      })
      .catch(() => {})
  }, [project.id])

  // The "N suggestions since your last run" line is decided once per mount, the first time the pane is seen: a review
  // written after a run ended that is newer than the last visit (or main's newCount) shows it. Main's own newCount stays
  // 0 for a first review and for re-found items, and an 'opened' review replaces the summary, so the persisted review
  // read on mount and the summary at first sight are both looked at. Seeing the pane stamps the visit.
  const sinceDecided = useRef<string | null>(null)
  useEffect(() => {
    if (!active || sinceDecided.current === project.id) return
    const candidates = [summary && summary.projectId === project.id ? summary : undefined, mountReview ?? undefined]
    if (!candidates.some(Boolean)) return
    sinceDecided.current = project.id
    const seenAt = readSeenAt(project.id)
    const n = Math.max(...candidates.map((c) => unseenSuggestions(c, seenAt)))
    setSinceText(sinceLine(n))
    writeSeenAt(project.id)
  }, [summary, mountReview, active, project.id])
  // While the pane is seen, new items count as seen.
  useEffect(() => {
    if (active && summary && summary.projectId === project.id && summary.newCount > 0 && sinceDecided.current === project.id) useTeamAssistantStore.getState().clearNew(project.id)
  }, [summary, active, project.id])

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
  // Another scope starts on its top few again.
  useEffect(() => setShowAll(false), [roleId])

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
      const known = useTeamAssistantStore.getState().sessions[project.id] ?? EMPTY_SESSION
      const out =
        kind === 'recommend'
          ? fromRecommendations(await capabilitiesApi.recommend(project.id, id, outside, roleId))
          : // Main keeps what Recommend found that is still valid; the shown list also drops what was dismissed here.
            fromReview(await capabilitiesApi.review(project.id, 'manual', id, outside))
      // Always store, even when the pane was left meanwhile: the result is waiting when the user returns.
      update(project.id, () => ({ result: out, cards: {}, gapsHidden: [] }))
      setShowAll(false)
      if (!alive.current) return
      setPhase('idle')
      const n = out.recommendations.filter((r) => !known.dismissedCandidates.includes(r.candidateId)).length
      setAnnounce(`${out.partial ? 'Partial results: ' : ''}Found ${n} recommendation${n === 1 ? '' : 's'} and ${out.gaps.length} gap${out.gaps.length === 1 ? '' : 's'}.`)
      // The results are below the controls in a short tray: bring them into view and move focus to their heading.
      window.requestAnimationFrame(() => {
        const head = resultRef.current
        if (!head) return
        head.scrollIntoView?.({ block: 'start' })
        head.focus({ preventScroll: true })
      })
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
      setCards((c) => {
        // Only the newest apply can be undone: earlier Applied rows lose their Undo.
        const all: Record<string, CardState> = {}
        for (const [k, v] of Object.entries(c)) all[k] = v.applied ? { ...v, applied: { ...v.applied, superseded: true } } : v
        all[recId] = {
          ...all[recId],
          busy: false,
          applied: {
            name: out.applied.name || name,
            roleNames: names,
            access: out.applied.access,
            undoId: out.undoId,
            appliedId: out.applied.kind === 'mcp' ? out.applied.id : undefined,
            connectorId: out.needsSetup?.connectorId,
            libraryId: out.needsSetup?.libraryId,
            needsSetup: out.needsSetup,
            notes: out.notes
          }
        }
        return all
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
    const candidateId = result?.recommendations.find((r) => r.id === recId)?.candidateId
    const name = clampText((candidateId && result?.items[candidateId]?.name) || 'suggestion', 80)
    capabilitiesApi.dismiss(project.id, recId, candidateId).catch(() => {
      if (!alive.current) return
      // Main kept the card, so the UI must too.
      clearTimeout(timers.current[recId])
      delete timers.current[recId]
      setRecent((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== recId)))
      update(project.id, (s) => ({ dismissed: s.dismissed.filter((id) => id !== recId), dismissedCandidates: candidateId ? s.dismissedCandidates.filter((c) => c !== candidateId) : s.dismissedCandidates }))
      setAnnounce(`Could not dismiss ${name}.`)
      window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-rec="${CSS.escape(recId)}"] [data-testid=capability-apply]`)?.focus({ preventScroll: true }))
    })
    update(project.id, (s) => ({ dismissed: [...s.dismissed, recId], dismissedCandidates: candidateId ? [...s.dismissedCandidates, candidateId] : s.dismissedCandidates }))
    // The row keeps the card's place for 8 s, so the list does not jump and the heading stays in view.
    setRecent((r) => ({ ...r, [recId]: { name, candidateId: candidateId ?? '' } }))
    // A tall card became a short row: in a short tray the row (and its focused Undo) can end up above the visible part.
    // Bring just that row into view; the rest of the list keeps its place.
    window.requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>(`[data-testid=capability-dismissed][data-rec="${CSS.escape(recId)}"]`)?.scrollIntoView?.({ block: 'nearest' })
    )
    clearTimeout(timers.current[recId])
    timers.current[recId] = setTimeout(() => {
      delete timers.current[recId]
      if (!alive.current) return
      // The row goes away: if focus was inside it, move it to the next card's Apply (else the previous one, else Recommend).
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-testid=capability-dismissed][data-rec="${CSS.escape(recId)}"]`)
      if (row && row.contains(document.activeElement)) {
        const applies = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-testid=capability-card] [data-testid=capability-apply]') ?? [])
        const after = (n: HTMLElement): boolean => !!(row.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)
        const next = applies.find(after) ?? [...applies].reverse().find((n) => !after(n))
        if (next) window.requestAnimationFrame(() => next.focus({ preventScroll: true }))
        else focusPrimary()
      }
      setRecent((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== recId)))
    }, 8000)
    setAnnounce(`Dismissed ${name}.`)
  }

  /** Bring a dismissed card back (the row's Undo or the Dismissed list's Restore). */
  const restore = (candidateId: string, name: string): void => {
    const recs = (result?.recommendations ?? []).filter((r) => r.candidateId === candidateId).map((r) => r.id)
    const wasPersisted = persisted.filter((e) => e.candidateId === candidateId)
    const wasRecent = Object.entries(recent).filter(([k]) => recs.includes(k))
    for (const id of recs) {
      clearTimeout(timers.current[id])
      delete timers.current[id]
    }
    setRecent((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !recs.includes(k))))
    update(project.id, (s) => ({ dismissed: s.dismissed.filter((id) => !recs.includes(id)), dismissedCandidates: s.dismissedCandidates.filter((c) => c !== candidateId) }))
    setPersisted((p) => p.filter((e) => e.candidateId !== candidateId))
    const othersLeft = dismissedEntries.some((e) => e.candidateId !== candidateId)
    // A restored card beyond the proactive cap would stay hidden, so show them all.
    if (capped && !showAll && recs.length > 0 && open.length + 1 > PROACTIVE_VISIBLE) setShowAll(true)
    capabilitiesApi
      .restore(project.id, candidateId)
      .then((r) => {
        if (!alive.current) return
        setPersisted(readDismissed(r))
        setResult((prev) => (!prev || prev.origin === 'review' ? fromReview(r) : prev))
      })
      .catch(() => {
        if (!alive.current) return
        update(project.id, (s) => ({ dismissed: [...s.dismissed, ...recs.filter((id) => !s.dismissed.includes(id))], dismissedCandidates: s.dismissedCandidates.includes(candidateId) ? s.dismissedCandidates : [...s.dismissedCandidates, candidateId] }))
        setPersisted((p) => [...p, ...wasPersisted.filter((e) => !p.some((x) => x.candidateId === e.candidateId))])
        setRecent((r) => ({ ...r, ...Object.fromEntries(wasRecent) }))
        setAnnounce(`Could not restore ${name}.`)
      })
    setAnnounce(`Restored ${name}.`)
    // Focus the restored card's Apply; when it is not in the list, fall back to the Dismissed toggle, the results head or Recommend.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const root = rootRef.current
        const q = (sel: string): HTMLElement | null | undefined => root?.querySelector<HTMLElement>(sel)
        const target =
          (recs[0] && q(`[data-rec="${CSS.escape(recs[0])}"] [data-testid=capability-apply]`)) ||
          (othersLeft && q('[data-testid=team-dismissed-toggle]')) ||
          q('[data-testid=team-results-head]') ||
          q('[data-testid=team-recommend]')
        target?.focus({ preventScroll: true })
      })
    )
  }

  const finishSetup = (info: AppliedInfo): void => {
    const st = useAppStore.getState()
    if (info.connectorId || info.libraryId) {
      // A connector or library entry keeps its sign-in and secrets in App settings > Connectors.
      openConnectorSetup(info.connectorId, info.libraryId)
    } else {
      // A project-level server with a missing env var: Team > Catalog, its edit form on that variable.
      st.openProjectMcp(project.id, info.appliedId, { edit: true })
    }
  }

  const ordered = result ? (result.origin === 'review' ? skillsFirst(result.recommendations, result.items) : result.recommendations) : []
  const shown = ordered.filter((r) => {
    if (recent[r.id]) return true
    if (dismissed.has(r.id) || dismissedCandidates.includes(r.candidateId) || !result?.items[r.candidateId]) return false
    return cards[r.id]?.applied ? true : !roleId || r.roleIds.includes(roleId)
  })
  const open = shown.filter((r) => !cards[r.id]?.applied && !recent[r.id])
  const proactive = result?.origin === 'review'
  // The proactive list and a list scoped to one role show the top few first.
  const capped = proactive || !!roleId
  const hiddenCount = capped && !showAll ? Math.max(0, open.length - PROACTIVE_VISIBLE) : 0
  const visibleOpen = new Set(open.slice(0, hiddenCount ? PROACTIVE_VISIBLE : open.length).map((r) => r.id))
  const problems = result ? sourceProblems(result.sources) : []
  const working_ = phase === 'working'
  const gaps = (result?.gaps ?? []).filter((g, i) => (!roleId || g.roleId === roleId) && !gapsHidden.has(`${g.roleId}:${i}`))
  const line = open.length > 0 && proactive ? sinceText : null
  const dismissedEntries = useMemo<DismissedEntry[]>(() => {
    const seen = new Set<string>(Object.values(recent).map((r) => r.candidateId))
    const out: DismissedEntry[] = []
    for (const c of dismissedCandidates) {
      const it = result?.items[c]
      if (it && !seen.has(c)) {
        seen.add(c)
        out.push({ candidateId: c, name: clampText(it.name, 80), kind: it.kind, dismissedAt: '' })
      }
    }
    for (const e of persisted) {
      if (seen.has(e.candidateId)) continue
      seen.add(e.candidateId)
      out.push(e)
    }
    return out
  }, [dismissedCandidates, persisted, recent, result])
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
              Follow chart
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
              <Button variant={open.length > 0 ? 'secondary' : 'primary'} size="sm" icon={Sparkles} onClick={() => void run('recommend')} testId="team-recommend">
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

      {open.length > 0 && (
        <div className="team-results-row">
          <h3 className="team-results-head" ref={resultRef} tabIndex={-1} data-testid="team-results-head">
            {hiddenCount > 0 ? `Top ${PROACTIVE_VISIBLE} to review${roleId ? ` for ${clampText(scopeName, 40)}` : ''}` : resultsHeadText(open.length, clampText(scopeName, 40), summary?.pendingCount, !!roleId)}
          </h3>
          {gaps.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              testId="team-gaps-jump"
              onClick={() => {
                const h = rootRef.current?.querySelector<HTMLElement>('#capability-gaps-title')
                h?.scrollIntoView?.({ block: 'start' })
                h?.focus({ preventScroll: true })
              }}
            >
              {gapsJumpText(gaps.length)}
            </Button>
          )}
        </div>
      )}
      <div className="capability-list" data-testid="capability-list">
        {shown.map((rec) => {
          const item = result!.items[rec.candidateId]
          const st = cards[rec.id] ?? {}
          const gone = recent[rec.id]
          if (gone) return <DismissedRow key={rec.id} recId={rec.id} name={gone.name} onUndo={() => restore(gone.candidateId, gone.name)} />
          if (st.applied) {
            return (
              <AppliedRow
                key={rec.id}
                info={st.applied}
                busy={st.busy}
                error={st.error}
                onUndo={() => void undo(rec.id)}
                onSetup={st.applied.needsSetup ? () => finishSetup(st.applied!) : undefined}
              />
            )
          }
          if (!visibleOpen.has(rec.id)) return null
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
      {hiddenCount > 0 && (
        <div>
          <Button size="sm" onClick={() => setShowAll(true)} testId="team-show-all">
            Show all {open.length}
          </Button>
        </div>
      )}

      <CapabilityGaps
        gaps={gaps}
        roles={project.roles}
        onAsk={onDesign}
        onDismiss={(i) => {
          const g = gaps[i]
          const idx = (result?.gaps ?? []).indexOf(g)
          update(project.id, (s) => ({ gapsHidden: [...s.gapsHidden, `${g.roleId}:${idx}`] }))
        }}
      />

      <DismissedList entries={dismissedEntries} onRestore={(id) => restore(id, dismissedEntries.find((e) => e.candidateId === id)?.name ?? 'suggestion')} />

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
