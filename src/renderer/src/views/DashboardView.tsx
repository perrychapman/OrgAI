import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import { setupPending } from '@shared/setup'
import { openNewChat, useAppStore } from '../store/useAppStore'
import { initials } from '../lib/layout'
import { Button } from '../components/ui/Button'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { NewProjectForm, hasParkedDraft } from '../components/dashboard/NewProjectForm'

/** The last openNewProject() request this view acted on, so a request is consumed once. */
let consumedNewProjectRequest = 0

/** Move focus to the topbar heading (the page's landmark) after the control that was focused is gone. */
function focusHeading(): void {
  requestAnimationFrame(() => {
    const h = document.querySelector<HTMLElement>('main .topbar h1')
    if (!h) return
    h.tabIndex = -1
    h.focus({ preventScroll: true })
  })
}

export default function DashboardView(): ReactElement {
  const projects = useAppStore((s) => s.projects)
  const selectProject = useAppStore((s) => s.selectProject)
  const setView = useAppStore((s) => s.setView)
  const removeProject = useAppStore((s) => s.removeProject)
  const appInfo = useAppStore((s) => s.appInfo)
  const loadAppInfo = useAppStore((s) => s.loadAppInfo)
  const newProjectRequest = useAppStore((s) => s.newProjectRequest)
  const { confirm, dialog } = useConfirm()
  // A form parked by its connection link comes back open.
  const [formOpen, setFormOpen] = useState(() => hasParkedDraft())

  useEffect(() => {
    void loadAppInfo()
  }, [loadAppInfo])

  // openNewProject() opens the form once, whether it fired before or after this view mounted.
  useEffect(() => {
    if (newProjectRequest > consumedNewProjectRequest) {
      consumedNewProjectRequest = newProjectRequest
      setFormOpen(true)
    }
  }, [newProjectRequest])

  const mockAvailable = !!appInfo?.mockAdapter
  const empty = projects.length === 0

  const remove = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: 'This only removes the project from OrgAI. Files in its folder are untouched.',
      confirmLabel: 'Delete project',
      danger: true
    })
    if (ok) await removeProject(id)
  }

  const cancelForm = (): void => {
    setFormOpen(false)
    // The Cancel button unmounts with the form: hand focus back to the button that opened it.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid=new-project]')?.focus())
  }

  return (
    <>
      <div className="topbar">
        <h1>Dashboard</h1>
        <div className="spacer" />
        {!empty && !formOpen && (
          <>
            <Button variant="secondary" icon={MessageSquare} onClick={() => void openNewChat()} testId="projects-new-chat">
              New chat
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setFormOpen(true)} testId="new-project">
              New project
            </Button>
          </>
        )}
      </div>
      <div className="projects">
        {empty ? (
          <div className="projects-empty">
            <div className="projects-empty-main">
              <div className="projects-intro">
                <h2>Start with a project</h2>
                <p>
                  Describe a new idea or point at an existing repository. The Architect interviews you, reads what is there, and proposes the
                  architecture, the org chart of agent roles, and the run settings. You approve each step before it is applied.
                </p>
              </div>
              <NewProjectForm mockAvailable={mockAvailable} />
            </div>
            <section className="card chat-now" aria-labelledby="chat-now-title">
              <h2 id="chat-now-title" className="form-title">
                Chat now
              </h2>
              <p>Ask a question or hand over a task without making a project.</p>
              <Button variant="primary" icon={MessageSquare} testId="empty-chat-now" onClick={() => void openNewChat()}>
                Chat now
              </Button>
            </section>
          </div>
        ) : (
          formOpen && <NewProjectForm mockAvailable={mockAvailable} onCancel={cancelForm} />
        )}
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
                    focusHeading()
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
