import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { MaintenanceResult, PendingWorktree, Project, WorktreeDiff } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import DiffView from '../DiffView'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** Leftover report branches, the architecture document, and (in a danger zone at the foot) removing OrgAI's files. */
export function MaintenanceSection({ project }: { project: Project }): ReactElement {
  const loadProjects = useAppStore((s) => s.loadProjects)
  const startSetup = useAppStore((s) => s.startSetup)
  const setView = useAppStore((s) => s.setView)
  const { confirm, dialog } = useConfirm()
  const [worktrees, setWorktrees] = useState<PendingWorktree[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, WorktreeDiff | 'loading'>>({})

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

  return (
    <SettingsSection id="settings-section-maintenance" title="Maintenance">
      <div className="field">
        <span className="field-label">Report branches waiting in the repository</span>
        {worktrees === null ? (
          <span className="hint">Looking…</span>
        ) : worktrees.length === 0 ? (
          <span className="hint">None. Every report branch has been merged or discarded.</span>
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
        <div className="row gap-2 wrap">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy !== null}>
            Refresh
          </Button>
          <span className="hint">Left by merge conflicts or interrupted runs. Merging commits any leftovers first; conflicts are reported and the branch is kept.</span>
        </div>
      </div>

      {project.setup?.architecturePath && (
        <div className="field">
          <span className="field-label">Architecture document</span>
          <span className="hint">
            {project.setup.architectureUpdatedAt
              ? `Architecture document last updated ${new Date(project.setup.architectureUpdatedAt).toLocaleString()}.`
              : `${project.setup.architecturePath} has not been edited by agents since setup.`}
          </span>
          <div className="row gap-2">
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
          </div>
        </div>
      )}

      {notice && <div className={`draft-box${notice.ok ? '' : ' is-error'}`}>{notice.message}</div>}

      <SettingsGroup title="Danger zone">
        <div className="danger-zone">
          <div className="field">
            <span className="field-label">Files OrgAI added to the repository</span>
            <span className="hint">
              {hasFootprint
                ? `${project.setup?.architecturePath} and a short section in CLAUDE.md, plus a .git/info/exclude entry for agent worktrees.`
                : 'None recorded. Any leftover worktrees and the .git/info/exclude entry are still removed.'}
            </span>
          </div>
          <div className="row gap-2">
            <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => void uninstall()}>
              {busy === 'uninstall' ? 'Removing…' : 'Remove OrgAI files from repository'}
            </Button>
          </div>
        </div>
      </SettingsGroup>
      {dialog}
    </SettingsSection>
  )
}
