import type { ReactElement } from 'react'
import { useState } from 'react'
import type { SetupKind } from '@shared/types'
import { setupPending } from '@shared/setup'
import { useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { examplePath } from '../lib/platform'

export default function ProjectsView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const createProject = useAppStore((s) => s.createProject)
  const startSetup = useAppStore((s) => s.startSetup)
  const selectProject = useAppStore((s) => s.selectProject)
  const setView = useAppStore((s) => s.setView)
  const removeProject = useAppStore((s) => s.removeProject)

  const [kind, setKind] = useState<SetupKind>('new')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [brief, setBrief] = useState('')
  const [skipSetup, setSkipSetup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (): Promise<void> => {
    const dir = await window.orgai.projects.pickDirectory()
    if (dir) {
      setPath(dir)
      if (!name) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? '')
    }
  }

  const valid = name.trim() && path.trim() && (kind === 'existing' || brief.trim())

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      await createProject({ name: name.trim(), path: path.trim(), brief: brief.trim(), setupKind: skipSetup ? undefined : kind })
      if (!skipSetup) await startSetup()
      setName('')
      setPath('')
      setBrief('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>Projects</h1>
        <div className="spacer" />
      </div>
      <div className="projects">
        <div>
          {projects.length === 0 ? (
            <div className="card" style={{ color: 'var(--text-dim)' }}>
              <h3 style={{ margin: '0 0 6px', color: 'var(--text)' }}>Start with a project</h3>
              Describe a new idea or point at an existing repository. The Architect interviews you, reads what is there, and proposes
              the architecture, the org chart of agent roles, and the run settings. You approve each step before it is applied.
            </div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="card project-card"
                  onClick={() => {
                    selectProject(p.id)
                    setView('run')
                  }}
                >
                  <h3>{p.name}</h3>
                  <div className="path">{p.path}</div>
                  <div className="roles">
                    {p.roles.slice(0, 8).map((r) => (
                      <span key={r.id} style={{ background: r.color }} title={r.name}>
                        {initials(r.name)}
                      </span>
                    ))}
                    {p.roles.length > 8 && <span style={{ background: 'var(--border-strong)' }}>+{p.roles.length - 8}</span>}
                  </div>
                  <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="chip">{p.roles.length} roles</span>
                      {setupPending(p) && (
                        <span className="chip" style={{ color: 'var(--warn)', borderColor: 'rgba(245,165,36,0.5)' }}>
                          setup pending
                        </span>
                      )}
                    </span>
                    <button
                      className="btn ghost sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Delete project "${p.name}"? This only removes it from OrgAI; files are untouched.`)) void removeProject(p.id)
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <form className="card" onSubmit={submit}>
          <h3 style={{ margin: '0 0 12px' }}>New project</h3>
          <div className="tabs" style={{ marginBottom: 14, display: 'flex' }}>
            <button type="button" className={kind === 'new' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setKind('new')}>
              New idea
            </button>
            <button type="button" className={kind === 'existing' ? 'active' : ''} style={{ flex: 1 }} onClick={() => setKind('existing')}>
              Existing repository
            </button>
          </div>

          {kind === 'new' ? (
            <>
              <div className="field">
                <label>Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My app" />
              </div>
              <div className="field">
                <label>What do you want to build?</label>
                <textarea
                  className="textarea"
                  style={{ minHeight: 120 }}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="Describe the idea, who it is for, and anything you already know you want: stack, constraints, must-haves. The Architect asks about the rest."
                />
              </div>
              <div className="field">
                <label>Folder to create it in</label>
                <div className="row">
                  <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder={examplePath('new-folder')} />
                  <button type="button" className="btn" onClick={pick}>
                    Browse
                  </button>
                </div>
                <span className="hint">An empty folder is best. It is created if it does not exist.</span>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>Repository folder</label>
                <div className="row">
                  <input className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder={examplePath('repo')} />
                  <button type="button" className="btn" onClick={pick}>
                    Browse
                  </button>
                </div>
                <span className="hint">The Architect scans it and reads the code before proposing anything. Nothing is modified until you approve.</span>
              </div>
              <div className="field">
                <label>Name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the folder name" />
              </div>
              <div className="field">
                <label>Anything the Architect should know? (optional)</label>
                <textarea
                  className="textarea"
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder="e.g. the kind of work you mostly do here, areas to leave alone, or team conventions not written down."
                />
              </div>
            </>
          )}

          <label className={`check ${skipSetup ? 'on' : ''}`} style={{ marginBottom: 12 }}>
            <input type="checkbox" checked={skipSetup} onChange={(e) => setSkipSetup(e.target.checked)} /> Skip AI setup, start with default roles
          </label>

          {error && (
            <div className="draft-box" style={{ borderColor: 'rgba(255,107,107,0.5)', color: 'var(--danger)', marginBottom: 10 }}>
              {error}
            </div>
          )}
          <button className="btn primary" disabled={busy || !valid}>
            {busy ? (
              <>
                <span className="spinner" /> {skipSetup ? 'Creating…' : 'Scanning and starting the Architect…'}
              </>
            ) : skipSetup ? (
              'Create project'
            ) : (
              'Create and start setup'
            )}
          </button>
        </form>
      </div>
    </>
  )
}
