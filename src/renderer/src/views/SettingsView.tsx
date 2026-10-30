import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { MaintenanceResult, PendingWorktree, WorktreeDiff } from '@shared/types'
import { DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS } from '@shared/types'
import type { PermissionMode, Project } from '@shared/types'
import { Switch } from '../components/ui/Switch'
import { runMessagingOn, MAX_AUTO_CONTINUES_LIMIT,MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import DiffView from '../components/DiffView'
import ProjectConnection from '../components/connections/ProjectConnection'
import RemapNotices from '../components/RemapNotices'
import McpSection from '../components/mcp/McpSection'
import PluginsSection from '../components/mcp/PluginsSection'
import PermissionRulesPanel from '../components/PermissionRulesPanel'

/** Project settings tab. The org chart and the AI draft panel live on the Org chart tab (OrgChartView). */
export default function SettingsView({ project }: { project: Project }): ReactElement {
  const updateProject = useAppStore((s) => s.updateProject)
  return (
    <div className="editor single">
      <div style={{ padding: 24, overflow: 'auto' }}>
        <ProjectSettings project={project} onChange={updateProject} />
        <MaintenancePanel project={project} />
      </div>
    </div>
  )
}

function MaintenancePanel({ project }: { project: Project }): ReactElement {
  const loadProjects = useAppStore((s) => s.loadProjects)
  const startSetup = useAppStore((s) => s.startSetup)
  const setView = useAppStore((s) => s.setView)
  const [worktrees, setWorktrees] = useState<PendingWorktree[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)

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

  const [diffs, setDiffs] = useState<Record<string, WorktreeDiff | 'loading'>>({})
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

  return (
    <div style={{ maxWidth: 640, marginTop: 28 }}>
      <div className="side-section-title" style={{ margin: '0 0 10px' }}>
        Maintenance
      </div>

      <div className="field">
        <label>Report branches waiting in the repository</label>
        {worktrees === null ? (
          <span className="hint">Looking…</span>
        ) : worktrees.length === 0 ? (
          <span className="hint">None. Every report branch has been merged or discarded.</span>
        ) : (
          <div className="maint-list">
            {worktrees.map((w) => (
              <div key={w.branch} className="maint-row">
                <div className="row" style={{ gap: 8 }}>
                  <code>{w.branch}</code>
                  {!w.exists && <span className="chip">directory missing</span>}
                  {w.uncommittedFiles > 0 && <span className="chip" style={{ color: 'var(--warn)' }}>{w.uncommittedFiles} uncommitted</span>}
                  <span className="chip">{w.commitsAhead} commit{w.commitsAhead === 1 ? '' : 's'} ahead</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 11 }}>
                    {w.lastCommitAt ? new Date(w.lastCommitAt).toLocaleString() : ''}
                  </span>
                </div>
                {w.lastSubject && <div style={{ fontSize: 12.5 }}>{w.lastSubject}</div>}
                {w.changedFiles.length > 0 && (
                  <div className="mono-dim">
                    {w.changedFiles.slice(0, 10).join(', ')}
                    {w.changedFiles.length > 10 ? `, +${w.changedFiles.length - 10} more` : ''}
                  </div>
                )}
                <div className="row" style={{ marginTop: 4 }}>
                  <button
                    className="btn primary sm"
                    disabled={busy !== null}
                    onClick={() => void act(w.branch, () => window.orgai.maintenance.integrateWorktree({ projectId: project.id, branch: w.branch }))}
                  >
                    {busy === w.branch ? 'Merging…' : 'Merge into main checkout'}
                  </button>
                  <button
                    className="btn sm danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (confirm(`Discard ${w.branch}? Its ${w.commitsAhead} commit(s) and any uncommitted files are lost.`))
                        void act(w.branch, () => window.orgai.maintenance.discardWorktree({ projectId: project.id, branch: w.branch }))
                    }}
                  >
                    Discard
                  </button>
                  <button className="btn ghost sm" disabled={diffs[w.branch] === 'loading'} onClick={() => void toggleDiff(w.branch)}>
                    {diffs[w.branch] === 'loading' ? 'Loading…' : diffs[w.branch] ? 'Hide diff' : 'View diff'}
                  </button>
                </div>
                {diffs[w.branch] && diffs[w.branch] !== 'loading' && (
                  <DiffView stat={(diffs[w.branch] as WorktreeDiff).stat} patch={(diffs[w.branch] as WorktreeDiff).patch} />
                )}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn ghost sm" onClick={() => void refresh()} disabled={busy !== null}>
            Refresh
          </button>
          <span className="hint">Left by merge conflicts or interrupted runs. Merging commits any leftovers first; conflicts are reported and the branch is kept.</span>
        </div>
      </div>

      {project.setup?.architecturePath && (
        <div className="field">
          <label>Architecture document</label>
          <span className="hint">
            {project.setup.architectureUpdatedAt
              ? `Architecture document last updated ${new Date(project.setup.architectureUpdatedAt).toLocaleString()}.`
              : `${project.setup.architecturePath} has not been edited by agents since setup.`}
          </span>
          <div className="row" style={{ marginTop: 4 }}>
            <button
              className="btn sm"
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
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label>Files OrgAI added to the repository</label>
        <span className="hint">
          {hasFootprint
            ? `${project.setup?.architecturePath} and a short section in CLAUDE.md, plus a .git/info/exclude entry for agent worktrees.`
            : 'None recorded. Any leftover worktrees and the .git/info/exclude entry are still removed.'}
        </span>
        <div className="row" style={{ marginTop: 4 }}>
          <button
            className="btn sm danger"
            disabled={busy !== null}
            onClick={() => {
              if (confirm('Remove the OrgAI files from this repository? The project itself stays in OrgAI; its approved architecture is cleared.'))
                void act('uninstall', () => window.orgai.maintenance.uninstallRepo(project.id))
            }}
          >
            {busy === 'uninstall' ? 'Removing…' : 'Remove OrgAI files from repository'}
          </button>
        </div>
      </div>

      {notice && (
        <div className="draft-box" style={notice.ok ? undefined : { borderColor: 'rgba(255,107,107,0.5)', color: 'var(--danger)' }}>
          {notice.message}
        </div>
      )}
    </div>
  )
}

function ProjectSettings({ project, onChange }: { project: Project; onChange: (p: Project) => void }): ReactElement {
  const patch = (p: Partial<Project>): void => onChange({ ...project, ...p })
  const [opusGuard, setOpusGuard] = useState<number | null>(null)
  useEffect(() => {
    window.orgai.settings
      .get()
      .then((s) => setOpusGuard(s.opusGuardThreshold))
      .catch(() => setOpusGuard(null))
  }, [])
  return (
    <div className="settings-col flow">
      <RemapNotices projectId={project.id} />
      <div className="field">
        <label>Name</label>
        <input className="input" value={project.name} onChange={(e) => patch({ name: e.target.value })} />
      </div>
      <div className="field">
        <label>Working directory</label>
        <div className="row">
          <input className="input" value={project.path} onChange={(e) => patch({ path: e.target.value })} />
          <button
            className="btn"
            onClick={async () => {
              const dir = await window.orgai.projects.pickDirectory()
              if (dir) patch({ path: dir })
            }}
          >
            Browse
          </button>
        </div>
      </div>
      <div className="field">
        <label>Project brief</label>
        <textarea className="textarea" style={{ minHeight: 110 }} value={project.brief} onChange={(e) => patch({ brief: e.target.value })} />
        <span className="hint">Appended to every role's system prompt and used by the org chart drafter.</span>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Permission mode</label>
          <select className="select" value={project.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value as PermissionMode })}>
            {PERMISSION_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="hint">
            {project.permissionMode === 'auto'
              ? 'Unattended mode still asks when the classifier is unsure; saved rules below never ask.'
              : 'Prompts appear as approval cards in the live view.'}
          </span>
        </div>
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label id="run-messaging-label">Let runs message each other</label>
            <Switch checked={runMessagingOn(project)} label="Let runs message each other" onChange={(next) => patch({ runMessaging: next })} />
          </div>
          <span className="hint">
            Orchestrators of this project&apos;s runs can read each other&apos;s prompts and exchange short notes. Off by default; messages between projects need it on in both.
          </span>
        </div>
        <div className="field">
          <label>Estimated-cost cap per run (API-equivalent USD)</label>
          <input
            className="input"
            type="number"
            min={0}
            step={0.5}
            value={project.maxBudgetUsd ?? ''}
            onChange={(e) => patch({ maxBudgetUsd: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="No cap"
          />
          <span className="hint">Measured at API prices. On a subscription this is a safety cap, not money you are billed.</span>
        </div>
        <div className="field">
          <label>Max subagent depth</label>
          <input
            className="input"
            type="number"
            min={1}
            max={MAX_SUBAGENT_DEPTH_LIMIT}
            value={project.maxSubagentDepth}
            onChange={(e) => patch({ maxSubagentDepth: Math.min(MAX_SUBAGENT_DEPTH_LIMIT, Number(e.target.value) || 1) })}
          />
          <span className="hint">1 means reports cannot spawn their own subagents.</span>
        </div>
        <div className="field">
          <label>Max concurrent subagents</label>
          <input
            className="input"
            type="number"
            min={1}
            max={MAX_CONCURRENT_SUBAGENTS_LIMIT}
            value={project.maxConcurrentSubagents}
            onChange={(e) => patch({ maxConcurrentSubagents: Math.min(MAX_CONCURRENT_SUBAGENTS_LIMIT, Number(e.target.value) || 1) })}
          />
          <span className="hint">Reports that may run at the same time across the whole org.</span>
        </div>
      </div>
      <div className="field">
        <label>Unattended execution</label>
        <label className={`check ${project.autoContinue !== false ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={project.autoContinue !== false} onChange={(e) => patch({ autoContinue: e.target.checked })} /> Keep the
          orchestrator going until the plan is complete
        </label>
        <span className="hint">
          The orchestrator plans each task with set_plan. Whenever a turn ends with steps left, the harness reminds it what remains, unless reports are
          still running, a card waits for you, or the run is stopping. It stops for genuine decisions (ask_user, mark_blocked); interrupting a turn
          also pauses it until you reply.
        </span>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <span>Max automatic continues per run</span>
          <input
            className="input"
            type="number"
            min={0}
            max={MAX_AUTO_CONTINUES_LIMIT}
            style={{ width: 90 }}
            disabled={project.autoContinue === false}
            value={project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ maxAutoContinues: Number.isFinite(v) ? Math.min(MAX_AUTO_CONTINUES_LIMIT, Math.max(0, Math.floor(v))) : DEFAULT_MAX_AUTO_CONTINUES })
            }}
          />
        </div>
        <span className="hint">When the limit is reached the orchestrator waits for you and the transcript says why.</span>
      </div>
      <div className="field">
        <label>Subscription limits</label>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Stop when one run uses more than</span>
          <input
            className="input"
            type="number"
            min={1}
            max={100}
            style={{ width: 80 }}
            value={project.maxWindowShare ?? ''}
            onChange={(e) => {
              const v = Number(e.target.value)
              patch({ maxWindowShare: e.target.value && Number.isFinite(v) && v > 0 ? Math.min(100, v) : undefined })
            }}
            placeholder="off"
          />
          <span>% of the five-hour window</span>
        </div>
        <span className="hint">
          Blank turns it off. The run is interrupted and waits for you; the orchestrator is told why with your next message.
        </span>
        <label className={`check ${project.preferSonnetNearLimit ? 'on' : ''}`} style={{ alignSelf: 'flex-start', marginTop: 6 }}>
          <input type="checkbox" checked={!!project.preferSonnetNearLimit} onChange={(e) => patch({ preferSonnetNearLimit: e.target.checked })} /> Prefer Sonnet
          for new reports when the Opus weekly window is above {opusGuard ?? 80}%
        </label>
        <span className="hint">
          Reports whose role uses Opus are spawned on Sonnet while the Opus weekly window (or the seven-day window, on plans without one) is at or above
          the threshold in app settings. Running agents are not changed.
        </span>
      </div>
      <div className="field">
        <label>Parallel work</label>
        <label className={`check ${project.isolateWriters !== false ? 'on' : ''}`} style={{ alignSelf: 'flex-start' }}>
          <input type="checkbox" checked={project.isolateWriters !== false} onChange={(e) => patch({ isolateWriters: e.target.checked })} /> Isolate writing reports in git worktrees
        </label>
        <span className="hint">
          Each report that can edit files works in its own git worktree. When it reports back, the harness commits its changes and merges them into the main
          checkout; conflicts are handed to the orchestrator. Needs a git repository.
        </span>
        <label className={`check ${project.reviewMerges ? 'on' : ''}`} style={{ alignSelf: 'flex-start', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={!!project.reviewMerges}
            disabled={project.isolateWriters === false}
            onChange={(e) => patch({ reviewMerges: e.target.checked })}
          />{' '}
          Review each report's changes before it is merged
        </label>
        <span className="hint">The live view shows each finished report's diff; you merge it, hold it for later, or discard it.</span>
      </div>
      <div className="field">
        <label>Runs to keep</label>
        <input
          className="input"
          type="number"
          min={1}
          max={5000}
          style={{ maxWidth: 160 }}
          value={project.keepRuns ?? DEFAULT_KEEP_RUNS}
          onChange={(e) => patch({ keepRuns: Math.max(1, Number(e.target.value) || DEFAULT_KEEP_RUNS) })}
        />
        <span className="hint">Older finished runs and their transcripts are deleted from disk when a run ends.</span>
      </div>
      <ProjectConnection project={project} />
      <PermissionRulesPanel project={project} />
      <McpSection project={project} />
      <PluginsSection project={project} />
    </div>
  )
}
