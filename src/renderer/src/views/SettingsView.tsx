import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MaintenanceResult, PendingWorktree, WorktreeDiff } from '@shared/types'
import { DEFAULT_KEEP_RUNS, PERMISSION_MODE_OPTIONS } from '@shared/types'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Connection,
  type Edge,
  type NodeChange,
  type NodeMouseHandler
} from '@xyflow/react'
import type { PermissionMode, Project, Role } from '@shared/types'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT, ROLE_COLORS, newId, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { RoleNode, type RoleFlowNode } from '../components/RoleNode'
import RoleInspector from '../components/RoleInspector'
import DiffView from '../components/DiffView'
import DraftPanel from '../components/DraftPanel'
import ProviderAuthPicker from '../components/ProviderAuthPicker'
import { claudeProviderLabel } from '@shared/defaults'
import { treeLayout } from '../lib/layout'
import PermissionRulesPanel from '../components/PermissionRulesPanel'

const nodeTypes = { role: RoleNode }

export default function SettingsView({ project }: { project: Project }): ReactElement {
  const tab = useAppStore((s) => s.settingsTab)
  const setTab = useAppStore((s) => s.setSettingsTab)
  const selectedRoleId = useAppStore((s) => s.selectedRoleId)
  const selectRole = useAppStore((s) => s.selectRole)
  const updateRoles = useAppStore((s) => s.updateRoles)
  const updateProject = useAppStore((s) => s.updateProject)

  const nodes: RoleFlowNode[] = useMemo(
    () =>
      project.roles.map((role) => ({
        id: role.id,
        type: 'role',
        position: role.position,
        selected: role.id === selectedRoleId,
        data: { role, reportCount: project.roles.filter((r) => r.reportsTo === role.id).length }
      })),
    [project.roles, selectedRoleId]
  )

  const edges: Edge[] = useMemo(
    () =>
      project.roles
        .filter((r) => r.reportsTo && project.roles.some((x) => x.id === r.reportsTo))
        .map((r) => {
          const parent = project.roles.find((x) => x.id === r.reportsTo)!
          const allowed = parent.canSpawn && parent.spawnable.includes(r.id)
          return {
            id: `e-${parent.id}-${r.id}`,
            source: parent.id,
            target: r.id,
            style: { stroke: allowed ? r.color : 'var(--text-faint)', strokeDasharray: allowed ? undefined : '4 4' },
            markerEnd: { type: MarkerType.ArrowClosed, color: allowed ? r.color : '#646d84' },
            label: allowed ? undefined : 'not delegable',
            labelStyle: { fill: '#9aa3b8', fontSize: 10 },
            labelBgStyle: { fill: '#11141c' }
          }
        }),
    [project.roles]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<RoleFlowNode>[]) => {
      const moves = changes.filter((c) => c.type === 'position' && c.position)
      if (moves.length) {
        updateRoles(project.id, (roles) =>
          roles.map((r) => {
            const m = moves.find((c) => c.type === 'position' && c.id === r.id)
            return m && m.type === 'position' && m.position ? { ...r, position: m.position } : r
          })
        )
      }
    },
    [project.id, updateRoles]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      updateRoles(project.id, (roles) =>
        roles.map((r) => {
          if (r.id === c.target) return { ...r, reportsTo: c.source }
          if (r.id === c.source) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, c.target as string])] }
          return { ...r, spawnable: r.spawnable.filter((id) => id !== c.target) }
        })
      )
    },
    [project.id, updateRoles]
  )

  const onNodeClick: NodeMouseHandler<RoleFlowNode> = useCallback((_e, node) => selectRole(node.id), [selectRole])

  const addRole = (): void => {
    const root = project.roles.find((r) => r.reportsTo === null)
    const selected = project.roles.find((r) => r.id === selectedRoleId)
    const manager = selected ?? root
    const name = `New role ${project.roles.length + 1}`
    const role: Role = {
      id: newId('role'),
      slug: slugify(name),
      name,
      description: 'Describe when a manager should delegate to this role.',
      responsibilities: [],
      prompt: 'You are a specialist. Complete the assigned task and report back concisely.',
      tools: ['Read', 'Glob', 'Grep'],
      model: 'sonnet',
      canSpawn: false,
      spawnable: [],
      reportsTo: manager?.id ?? null,
      position: { x: (manager?.position.x ?? 0) + 120, y: (manager?.position.y ?? 0) + 210 },
      color: ROLE_COLORS[project.roles.length % ROLE_COLORS.length]
    }
    updateRoles(project.id, (roles) => [
      ...roles.map((r) => (r.id === manager?.id ? { ...r, canSpawn: true, spawnable: [...r.spawnable, role.id] } : r)),
      role
    ])
    selectRole(role.id)
  }

  const autoLayout = (): void => {
    const pos = treeLayout(
      project.roles.map((r) => ({ id: r.id, parentId: r.reportsTo, width: 220, height: 96 })),
      { nodesep: 60, ranksep: 110 }
    )
    updateRoles(project.id, (roles) => roles.map((r) => ({ ...r, position: pos[r.id] ?? r.position })))
  }

  const selectedRole = project.roles.find((r) => r.id === selectedRoleId)

  if (tab === 'project') {
    return (
      <div className="editor">
        <div style={{ padding: 24, overflow: 'auto' }}>
          <div className="tabs" style={{ marginBottom: 18 }}>
            <button onClick={() => setTab('org')}>Org chart</button>
            <button className="active">Project settings</button>
          </div>
          <ProjectSettings project={project} onChange={updateProject} />
          <MaintenancePanel project={project} />
        </div>
        <div className="side">
          <DraftPanel project={project} />
        </div>
      </div>
    )
  }

  return (
    <div className="editor">
      <div className="canvas">
        <div className="canvas-toolbar">
          <div className="tabs">
            <button className="active">Org chart</button>
            <button onClick={() => setTab('project')}>Project settings</button>
          </div>
          <button className="btn" onClick={addRole}>
            + Add role
          </button>
          <button className="btn" onClick={autoLayout}>
            Auto-layout
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={() => selectRole(null)}
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1f2432" />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="legend">
          <span>Drag from a node's bottom handle to another node to make it a report.</span>
        </div>
      </div>
      <div className="side">
        {selectedRole ? <RoleInspector project={project} role={selectedRole} /> : <DraftPanel project={project} />}
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
    <div style={{ maxWidth: 640 }}>
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
      <div className="field">
        <label>Provider</label>
        <div className="row">
          <span className="pill ok">
            <span className="dot" /> {project.provider.label}
          </span>
          <span className="hint">More providers plug in as runtime adapters. Claude is the only one wired up so far.</span>
        </div>
      </div>
      <div className="field">
        <label>Authentication for this project</label>
        <ProviderAuthPicker
          name={`project-auth-${project.id}`}
          value={project.provider.auth}
          onChange={(auth) => patch({ provider: { ...project.provider, auth, label: claudeProviderLabel(auth) } })}
        />
      </div>
      <PermissionRulesPanel project={project} />
    </div>
  )
}
