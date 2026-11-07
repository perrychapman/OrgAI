import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeGraph, MaintenanceResult, PendingWorktree, Project, WorktreeDiff } from '@shared/types'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { Banner } from '../ui/Banner'
import { useForgetEngagement } from '../dashboard/useForgetEngagement'
import DiffView from '../DiffView'
import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { SettingRow } from '../ui/SettingRow'
import { SettingsCard } from './SettingsCard'
import { useConfirm } from '../ui/ConfirmDialog'
import { isolateWritersOn, projectKindOf } from '@shared/defaults'
import { cleanIpcError } from '../../lib/ipcError'
import { clearCountsLine } from '../../lib/knowledge'
import { MAINTENANCE_ENGAGEMENT_LINE } from '../../lib/settingsCopy'
import { useOrgChange } from '../team/useOrgChange'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** The Maintenance notice after knowledge:clear (docs/design/knowledge.md section 9). */
export const KNOWLEDGE_CLEARED_NOTICE = 'Cleared everything the team recorded.'

/** The engagement danger-zone text; "what the team recorded" names the knowledge graph. */
export const ENGAGEMENT_DANGER_TEXT =
  'Deletes everything OrgAI keeps for this engagement: the plan, context notes, what the team recorded, saved permission rules, run history and costs, and saved service values for it. Files in the working folder and in reference folders are not touched.'

/** Leftover report branches, the org chart and setup review, and (in a danger zone at the foot) removing OrgAI's files. */
export function MaintenanceSection({ project }: { project: Project }): ReactElement {
  const loadProjects = useAppStore((s) => s.loadProjects)
  const orgChange = useOrgChange(project)
  const { confirm, dialog } = useConfirm()
  const [worktrees, setWorktrees] = useState<PendingWorktree[] | null>(null)
  const { forget, dialog: forgetDialog } = useForgetEngagement()
  const [forgetError, setForgetError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, WorktreeDiff | 'loading'>>({})
  // What the team recorded (engagements): the counts the Clear-everything confirm names; null until read.
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null)

  // Engagements write nothing to their folder unless separate git copies are on. Branches are always looked up, and the
  // block shows whenever any exist, so leftovers can be discarded after isolation was turned off.
  const engagement = projectKindOf(project) === 'engagement'

  useEffect(() => {
    if (!engagement) return
    let gone = false
    const read = (): void => {
      window.orgai.knowledge
        .get(project.id)
        .then((g) => {
          if (!gone) setGraph(g)
        })
        .catch(() => {
          if (!gone) setGraph((g) => g ?? { version: 1, nodes: [], edges: [] })
        })
    }
    setGraph(null)
    read()
    const off = window.orgai.onEngagementChanged((ev) => {
      if (ev.projectId === project.id && ev.what === 'knowledge') read()
    })
    return () => {
      gone = true
      off()
    }
  }, [engagement, project.id])

  const graphEmpty = graph !== null && graph.nodes.length === 0 && graph.edges.length === 0
  const noticeRef = useRef<HTMLDivElement>(null)
  const [noticeFocus, setNoticeFocus] = useState(0)
  useEffect(() => {
    if (noticeFocus > 0) noticeRef.current?.focus()
  }, [noticeFocus])

  const clearKnowledge = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear everything the team recorded?',
      body: (
        <p data-testid="knowledge-clear-body">
          Deletes {clearCountsLine(graph ?? { nodes: [], edges: [] })}. Agents and you can no longer see these. Context notes stay. Retire items on the Knowledge tab to keep records instead.
        </p>
      ),
      confirmLabel: 'Clear everything',
      danger: true,
      confirmTestId: 'knowledge-clear-confirm'
    })
    if (!ok) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=knowledge-clear]')?.focus())
      return
    }
    setBusy('knowledge-clear')
    setNotice(null)
    try {
      setGraph(await window.orgai.knowledge.clear(project.id))
      setNotice({ ok: true, message: KNOWLEDGE_CLEARED_NOTICE })
      // The button is disabled once the graph is empty, so after a clear focus moves to the notice (reviewer M1).
      setNoticeFocus((n) => n + 1)
    } catch (e) {
      setNotice({ ok: false, message: cleanIpcError(e) })
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=knowledge-clear]')?.focus())
    } finally {
      setBusy(null)
    }
  }
  const isolating = isolateWritersOn(project)
  const showBranches = !engagement || isolating || (worktrees !== null && worktrees.length > 0)

  const refresh = useCallback(async () => {
    try {
      setWorktrees(await window.orgai.maintenance.listWorktrees(project.id))
    } catch (e) {
      setNotice({ ok: false, message: (e as Error).message })
      setWorktrees([])
    }
  }, [project.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (key: string, fn: () => Promise<MaintenanceResult>): Promise<void> => {
    setBusy(key)
    setNotice(null)
    try {
      setNotice(await fn())
      await refresh()
      await loadProjects()
    } catch (e) {
      setNotice({ ok: false, message: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const hasFootprint = !!project.setup?.architecturePath

  const toggleDiff = async (branch: string): Promise<void> => {
    if (diffs[branch]) {
      setDiffs(({ [branch]: _drop, ...rest }) => rest)
      return
    }
    setDiffs((d) => ({ ...d, [branch]: 'loading' }))
    try {
      const diff = await window.orgai.maintenance.diffWorktree({ projectId: project.id, branch })
      setDiffs((d) => ({ ...d, [branch]: diff }))
    } catch (e) {
      setDiffs((d) => ({ ...d, [branch]: { stat: '', patch: `Could not load the diff: ${(e as Error).message}` } }))
    }
  }

  const discard = async (w: PendingWorktree): Promise<void> => {
    const ok = await confirm({
      title: `Discard ${w.branch}?`,
      body: `Its ${w.commitsAhead} commit${w.commitsAhead === 1 ? '' : 's'} and any uncommitted files are lost. This cannot be undone.`,
      confirmLabel: 'Discard branch',
      danger: true
    })
    if (ok) await act(w.branch, () => window.orgai.maintenance.discardWorktree({ projectId: project.id, branch: w.branch }))
  }

  const uninstall = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Remove OrgAI files from this repository?',
      body: 'The project itself stays in OrgAI; its approved architecture is cleared.',
      confirmLabel: 'Remove files',
      danger: true
    })
    if (ok) await act('uninstall', () => window.orgai.maintenance.uninstallRepo(project.id))
  }

  const forgetThis = async (): Promise<void> => {
    setBusy('forget')
    setForgetError(null)
    const openRuns = Object.values(useAppStore.getState().runs).filter(
      (r) => r.summary.projectId === project.id && (isRunLive(r) || r.summary.status === 'paused')
    ).length
    const out = await forget(project, openRuns)
    setBusy(null)
    if (out.status === 'cancelled') {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=forget-engagement]')?.focus())
    } else if (out.status === 'error') {
      setForgetError(out.message)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=forget-engagement]')?.focus())
    }
    else {
      // Done: the store already left this project for the Dashboard, where the notice shows (its Banner is the live region).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => (document.querySelector<HTMLElement>('[data-testid=new-project]') ?? document.querySelector<HTMLElement>('[data-testid=dash-start-choice] input:checked'))?.focus())
      )
    }
  }

  return (
    <SettingsSection id="settings-section-maintenance" title="Maintenance">
      {engagement && (
        <p className="settings-card-note" data-testid="maintenance-engagement-line">
          {isolating
            ? 'OrgAI keeps its notes for this engagement in its own data folder. Because separate git copies are on, it adds them and a .git/info/exclude line in the working folder.'
            : MAINTENANCE_ENGAGEMENT_LINE}
        </p>
      )}
      {showBranches && <div className="field">
        {worktrees === null ? (
          <span className="settings-quiet">Looking…</span>
        ) : worktrees.length === 0 ? (
          <div className="settings-quiet">
            <span>No report branches waiting</span>
            <IconButton icon={RefreshCw} label="Refresh" size="sm" onClick={() => void refresh()} disabled={busy !== null} />
          </div>
        ) : (
          <div className="maint-list">
            {worktrees.map((w) => {
              const diff = diffs[w.branch]
              return (
                <div key={w.branch} className="maint-row">
                  <div className="row gap-2 wrap">
                    <code>{w.branch}</code>
                    {!w.exists && <span className="chip">directory missing</span>}
                    {w.uncommittedFiles > 0 && <span className="chip warn">{w.uncommittedFiles} uncommitted</span>}
                    <span className="chip">
                      {w.commitsAhead} commit{w.commitsAhead === 1 ? '' : 's'} ahead
                    </span>
                    <span className="grow" />
                    <span className="maint-when">{w.lastCommitAt ? new Date(w.lastCommitAt).toLocaleString() : ''}</span>
                  </div>
                  {w.lastSubject && <div className="maint-subject">{w.lastSubject}</div>}
                  {w.changedFiles.length > 0 && (
                    <div className="mono-dim">
                      {w.changedFiles.slice(0, 10).join(', ')}
                      {w.changedFiles.length > 10 ? `, +${w.changedFiles.length - 10} more` : ''}
                    </div>
                  )}
                  <div className="row gap-2 wrap">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void act(w.branch, () => window.orgai.maintenance.integrateWorktree({ projectId: project.id, branch: w.branch }))}
                    >
                      {busy === w.branch ? 'Merging…' : 'Merge into main checkout'}
                    </Button>
                    <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void discard(w)}>
                      Discard
                    </Button>
                    <Button variant="ghost" size="sm" disabled={diff === 'loading'} onClick={() => void toggleDiff(w.branch)}>
                      {diff === 'loading' ? 'Loading…' : diff ? 'Hide diff' : 'View diff'}
                    </Button>
                  </div>
                  {diff && diff !== 'loading' && <DiffView stat={diff.stat} patch={diff.patch} />}
                </div>
              )
            })}
          </div>
        )}
        {worktrees !== null && worktrees.length > 0 && (
          <div className="row gap-2 wrap">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy !== null}>
              Refresh
            </Button>
            <span className="hint">Left by conflicts or interrupted runs.</span>
            <details className="setting-row-more">
              <summary>Learn more</summary>
              <div className="setting-row-more-body">Merging commits any leftovers first. Conflicts are reported and the branch is kept.</div>
            </details>
          </div>
        )}
      </div>}

      <SettingsCard>
        <SettingRow
          title="Org chart and setup"
          description={`The Architect reviews the ${engagement ? 'engagement' : 'code'}, the org chart and the settings${
            project.setup?.architecturePath ? `, and the ${engagement ? 'plan' : 'architecture document'}` : ''
          }, then proposes changes for you to approve. It opens as an org change session on Live.${
            project.setup?.architecturePath
              ? project.setup.architectureUpdatedAt
                ? ` The ${engagement ? 'plan' : 'architecture document'} was updated ${new Date(project.setup.architectureUpdatedAt).toLocaleDateString()}.`
                : ` The ${engagement ? 'plan' : 'architecture document'} has not been edited by agents since setup.`
              : ''
          }`}
          control={
            <Button
              size="sm"
              testId="maintenance-org-review"
              disabled={busy !== null}
              onClick={() => {
                setBusy('review')
                // One start path with the Team tab: while a session is open this only opens it.
                void orgChange
                  .revise('')
                  .catch((e: Error) => setNotice({ ok: false, message: cleanIpcError(e) }))
                  .finally(() => setBusy(null))
              }}
            >
              {busy === 'review' ? 'Starting…' : orgChange.liveRunId ? 'Open the org change session' : 'Review the org chart and setup'}
            </Button>
          }
        />
      </SettingsCard>

      {notice && (
        <div ref={noticeRef} tabIndex={-1} className={`draft-box${notice.ok ? '' : ' is-error'}`} role={notice.ok ? 'status' : 'alert'} data-testid="maintenance-notice">
          {notice.message}
        </div>
      )}

      {engagement && (
        <SettingsGroup title="Danger zone">
          <div className="danger-zone">
            <p className="danger-zone-text" data-testid="danger-zone-text">
              {ENGAGEMENT_DANGER_TEXT}
            </p>
            {forgetError && (
              <Banner tone="danger" title="Could not forget this engagement" testId="forget-error">
                {forgetError}
              </Banner>
            )}
            <div className="row gap-2 wrap">
              <Button variant="danger" size="sm" disabled={busy !== null} testId="forget-engagement" onClick={() => void forgetThis()}>
                {busy === 'forget' ? 'Forgetting…' : 'Forget this engagement…'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy !== null || graph === null || graphEmpty}
                testId="knowledge-clear"
                onClick={() => void clearKnowledge()}
              >
                {busy === 'knowledge-clear' ? 'Clearing…' : 'Clear everything…'}
              </Button>
              {graphEmpty && (
                <span className="settings-quiet" data-testid="knowledge-clear-empty">
                  Nothing recorded yet.
                </span>
              )}
            </div>
          </div>
        </SettingsGroup>
      )}

      {!engagement && (
        <SettingsGroup title="Danger zone">
          <div className="danger-zone">
            <p className="danger-zone-text">Deletes the files OrgAI created in this repository. Your own files stay.</p>
            <details className="setting-row-more">
              <summary>Learn more</summary>
              <div className="setting-row-more-body">
                {hasFootprint
                  ? `${project.setup?.architecturePath} and a short section in CLAUDE.md, plus a .git/info/exclude entry for agent worktrees.`
                  : 'None recorded. Any leftover worktrees and the .git/info/exclude entry are still removed.'}
              </div>
            </details>
            <div className="row gap-2">
              <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void uninstall()}>
                {busy === 'uninstall' ? 'Removing…' : 'Remove OrgAI files from repository'}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      )}
      {dialog}
      {forgetDialog}
    </SettingsSection>
  )
}
