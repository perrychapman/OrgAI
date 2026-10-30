import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import type { ProjectPathCheck, SetupKind } from '@shared/types'
import { setupPending } from '@shared/setup'
import { useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { examplePath } from '../lib/platform'
import { effectiveName, newProjectConnectionLine, pathStatus, submitBlocker } from '../lib/projectsForm'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { Input } from '../components/ui/Input'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { Textarea } from '../components/ui/Textarea'

const KINDS: { value: SetupKind; label: string }[] = [
  { value: 'new', label: 'New idea' },
  { value: 'existing', label: 'Existing repository' }
]

function NewProjectForm({ mockAvailable, onCancel }: { mockAvailable: boolean; onCancel?: () => void }): ReactElement {
  const createProject = useAppStore((s) => s.createProject)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const connections = useAppStore((s) => s.connections)
  useEffect(() => {
    void useAppStore.getState().loadDefaultConnection()
    if (!useAppStore.getState().connections) void useAppStore.getState().loadConnections()
  }, [])
  const startSetup = useAppStore((s) => s.startSetup)
  const uid = useId()
  const ids = { name: `${uid}-name`, brief: `${uid}-brief`, path: `${uid}-path`, pathMsg: `${uid}-path-msg`, pathErr: `${uid}-path-err`, why: `${uid}-why` }

  const [kind, setKind] = useState<SetupKind>('new')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [brief, setBrief] = useState('')
  const [architect, setArchitect] = useState(true)
  const [useMock, setUseMock] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<{ path: string; result: ProjectPathCheck } | null>(null)

  // The form opens with the cursor in its first field.
  useEffect(() => {
    document.getElementById(ids.name)?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced live check of the folder; stale answers are dropped.
  useEffect(() => {
    const p = path.trim()
    if (!p) return undefined
    let live = true
    const t = setTimeout(() => {
      window.orgai.projects
        .checkPath(p)
        .then((result) => {
          if (live) setCheck({ path: p, result })
        })
        .catch(() => {})
    }, 250)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [path])

  const current = check && check.path === path.trim() ? check.result : null
  const status = pathStatus(kind, path, current)
  const blocker = submitBlocker({ kind, name, path, brief, status })

  const setPathValue = (v: string): void => {
    setPath(v)
    setError(null)
  }
  const pick = async (): Promise<void> => {
    const dir = await window.orgai.projects.pickDirectory()
    if (dir) setPathValue(dir)
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (blocker || busy) return
    setBusy(true)
    setError(null)
    try {
      // `mock` is accepted by projects.create (ProjectCreateInput); the store's input type has not caught up.
      const input = {
        name: effectiveName(name, path, current),
        path: path.trim(),
        brief: brief.trim(),
        setupKind: architect ? kind : undefined,
        ...(mockAvailable && useMock ? { mock: true } : {})
      }
      await createProject(input as Parameters<typeof createProject>[0])
      if (architect) await startSetup()
      // The form is gone: land focus on the new project's heading instead of letting it fall to the page.
      requestAnimationFrame(() => {
        const h = document.querySelector<HTMLElement>('main .topbar h1')
        if (!h) return
        h.tabIndex = -1
        h.focus({ preventScroll: true })
      })
    } catch (err) {
      setError((err as Error).message)
      document.getElementById(ids.path)?.focus()
    } finally {
      setBusy(false)
    }
  }

  const pathField = (label: string, placeholder: string, hint: string): ReactElement => (
    <div className="field">
      <label htmlFor={ids.path}>{label}</label>
      <div className="row">
        <div className="grow">
          <Input
            id={ids.path}
            mono
            value={path}
            onChange={setPathValue}
            placeholder={placeholder}
            invalid={!!error || status?.tone === 'error'}
            aria-describedby={[error ? ids.pathErr : '', status ? ids.pathMsg : ''].filter(Boolean).join(' ') || undefined}
          />
        </div>
        <Button icon={FolderOpen} onClick={() => void pick()}>
          Browse
        </Button>
      </div>
      {error && (
        <span id={ids.pathErr} className="field-msg error" role="alert">
          {error}
        </span>
      )}
      {status && (
        <span id={ids.pathMsg} className={`field-msg ${status.tone}`}>
          {status.text}
        </span>
      )}
      <span className="hint">{hint}</span>
    </div>
  )

  const nameField = (placeholder: string): ReactElement => (
    <div className="field">
      <label htmlFor={ids.name}>Name</label>
      <Input id={ids.name} value={name} onChange={setName} placeholder={placeholder} />
    </div>
  )

  return (
    <form className="card project-form" onSubmit={submit}>
      <div className="row between">
        <h2 className="form-title">New project</h2>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <SegmentedControl
        label="Project type"
        value={kind}
        options={KINDS}
        onChange={(k) => {
          setKind(k)
          setError(null)
        }}
      />

      {kind === 'new' ? (
        <>
          {nameField('My app')}
          <div className="field">
            <label htmlFor={ids.brief}>What do you want to build?</label>
            <Textarea
              id={ids.brief}
              rows={5}
              value={brief}
              onChange={setBrief}
              placeholder="Describe the idea, who it is for, and anything you already know you want: stack, constraints, must-haves. The Architect asks about the rest."
            />
          </div>
          {pathField('Folder to create it in', examplePath('new-folder'), 'An empty folder is best. It is created if it does not exist.')}
        </>
      ) : (
        <>
          {pathField('Repository folder', examplePath('repo'), 'The Architect scans it and reads the code before proposing anything. Nothing is modified until you approve.')}
          {nameField('Defaults to the folder name')}
          <div className="field">
            <label htmlFor={ids.brief}>Anything the Architect should know? (optional)</label>
            <Textarea
              id={ids.brief}
              value={brief}
              onChange={setBrief}
              placeholder="e.g. the kind of work you mostly do here, areas to leave alone, or team conventions not written down."
            />
          </div>
        </>
      )}

      <div className="stack-2 form-options">
        <Checkbox
          checked={architect}
          onChange={setArchitect}
          label="Set up with the Architect (recommended)"
          description="Turn off to start with the default roles and skip the interview."
          testId="architect-setup"
        />
        {mockAvailable && <Checkbox checked={useMock} onChange={setUseMock} label="Use the mock adapter (no tokens are spent)" testId="use-mock" />}
      </div>

      <p className="form-connection muted" data-testid="new-project-connection">
        {newProjectConnectionLine(defaultConnection, connections)}
      </p>

      <div className="row form-submit">
        <Button type="submit" variant="primary" loading={busy} disabled={!!blocker}>
          {busy ? (architect ? 'Scanning and starting the Architect…' : 'Creating…') : architect ? 'Create and start setup' : 'Create project'}
        </Button>
        {blocker && !busy && (
          <span id={ids.why} className="hint">
            {blocker}
          </span>
        )}
      </div>
    </form>
  )
}

export default function ProjectsView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const selectProject = useAppStore((s) => s.selectProject)
  const setView = useAppStore((s) => s.setView)
  const removeProject = useAppStore((s) => s.removeProject)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const { confirm, dialog } = useConfirm()
  const [formOpen, setFormOpen] = useState(false)

  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])

  const mockAvailable = !!appInfo?.mockAdapter
  const empty = projects.length === 0
  const showForm = empty || formOpen

  const remove = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: 'This only removes the project from OrgAI. Files in its folder are untouched.',
      confirmLabel: 'Delete project',
      danger: true
    })
    if (ok) await removeProject(id)
  }

  return (
    <>
      <div className="topbar">
        <h1>Projects</h1>
        {mockAvailable && (
          <Badge tone="warning" title="The mock adapter is available: new projects can run on scripted data">
            Mock mode
          </Badge>
        )}
        <div className="spacer" />
        {!empty && !formOpen && (
          <Button variant="primary" icon={Plus} onClick={() => setFormOpen(true)} testId="new-project">
            New project
          </Button>
        )}
      </div>
      <div className="projects">
        {empty && (
          <div className="projects-intro">
            <h2>Start with a project</h2>
            <p>
              Describe a new idea or point at an existing repository. The Architect interviews you, reads what is there, and proposes the
              architecture, the org chart of agent roles, and the run settings. You approve each step before it is applied.
            </p>
          </div>
        )}
        {showForm && <NewProjectForm mockAvailable={mockAvailable} onCancel={empty ? undefined : () => setFormOpen(false)} />}
        {!empty && (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id} className="card project-card">
                <button
                  type="button"
                  className="project-card-main"
                  aria-label={`Open ${p.name}, ${p.path}`}
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
                    {p.roles.length > 8 && <span className="more">+{p.roles.length - 8}</span>}
                  </div>
                </button>
                <div className="row between project-card-foot">
                  <span className="row gap-2">
                    <span className="chip">{p.roles.length} roles</span>
                    {setupPending(p) && <span className="chip warn">Setup pending</span>}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void remove(p.id, p.name)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialog}
    </>
  )
}
