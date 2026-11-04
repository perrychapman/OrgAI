import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { MaintenanceResult, PendingWorktree, Project, WorktreeDiff } from '@shared/types'
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
import { MAINTENANCE_ENGAGEMENT_LINE } from '../../lib/settingsCopy'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** Leftover report branches, the architecture document, and (in a danger zone at the foot) removing OrgAI's files. */
export function MaintenanceSection({ project }: { project: Project }): ReactElement {
  const loadProjects = useAppStore((s) => s.loadProjects)
  const startSetup = useAppStore((s) => s.startSetup)
  const setView = useAppStore((s) => s.setView)
  const { confirm, dialog } = useConfirm()
  const [worktrees, setWorktrees] = useState<PendingWorktree[] | null>(null)
  const { forget, dialog: forgetDialog } = useForgetEngagement()
  const [forgetError, setForgetError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, WorktreeDiff | 'loading'>>({})

  // Engagements write nothing to their folder unless separate git copies are on. Branches are always looked up, and the
  // block shows whenever any exist, so leftovers can be discarded after isolation was turned off.
  const engagement = projectKindOf(project) === 'engagement'
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

      {project.setup?.architecturePath && (
        <SettingsCard>
          <SettingRow
            title="Architecture document"
            description={
              project.setup.architectureUpdatedAt
                ? `Updated ${new Date(project.setup.architectureUpdatedAt).toLocaleDateString()}.`
                : 'Not edited by agents since setup.'
            }
            control={
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setBusy('review')
                  void startSetup(
                    'Review .orgai/ARCHITECTURE.md against the current code and propose an updated architecture, then re-check the org chart and settings.'
                  )
                    .then(() => setView('run'))
                    .catch((e: Error) => setNotice({ ok: false, message: e.message }))
                    .finally(() => setBusy(null))
                }}
              >
                {busy === 'review' ? 'Starting…' : 'Review with the Architect'}
              </Button>
            }
          />
        </SettingsCard>
      )}

      {notice && <div className={`draft-box${notice.ok ? '' : ' is-error'}`} role={notice.ok ? 'status' : 'alert'}>{notice.message}</div>}

      {engagement && (
        <SettingsGroup title="Danger zone">
          <div className="danger-zone">
            <p className="danger-zone-text" data-testid="danger-zone-text">
              Deletes everything OrgAI keeps for this engagement: the plan, context notes, saved permission rules, run history and costs, and saved service values for it. Files in the working folder and in reference folders are not touched.
            </p>
            {forgetError && (
              <Banner tone="danger" title="Could not forget this engagement" testId="forget-error">
                {forgetError}
              </Banner>
            )}
            <div className="row gap-2">
              <Button variant="danger" size="sm" disabled={busy !== null} testId="forget-engagement" onClick={() => void forgetThis()}>
                {busy === 'forget' ? 'Forgetting…' : 'Forget this engagement…'}
              </Button>
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
