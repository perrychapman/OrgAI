import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { setupPending } from '@shared/setup'
import { isRunLive, newRunDraftKey, useAppStore, useRunIndexes } from '../store/useAppStore'
import { runTitle } from '../lib/runLabels'
import { Button } from './ui/Button'
import Composer from './Composer'
import McpAuthNotice from './mcp/McpAuthNotice'

const SCAFFOLD_PROMPT =
  'The project folder is empty or nearly empty. If it is not a git repository yet, run git init and make an initial commit before delegating, so reports can work in isolated worktrees. Then scaffold the project according to .orgai/ARCHITECTURE.md: create the structure, tooling, build and test commands, and a minimal end-to-end slice that runs. Keep every decision consistent with the architecture document, and report what you created.'

/**
 * The blank page behind "+": a draft of a new run. Nothing of any other run shows here; Start can only start a new
 * run. Other open runs of the project are listed as links that switch tab.
 */
export default function NewRunPage({ project }: { project: Project }): ReactElement {
  const startRun = useAppStore((s) => s.startRun)
  const startSetup = useAppStore((s) => s.startSetup)
  const openRun = useAppStore((s) => s.openRun)
  const focusToken = useAppStore((s) => s.composerFocusToken)
  const runs = useAppStore((s) => s.runs)
  const others = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.summary.projectId === project.id && isRunLive(r))
        .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
        .map((r) => ({ id: r.summary.id, prompt: r.summary.prompt })),
    [runs, project.id]
  )
  const indexes = useRunIndexes()
  const [busy, setBusy] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const needsSetup = setupPending(project)
  const rootName = project.roles.find((r) => r.reportsTo === null)?.name ?? 'the orchestrator'

  const beginSetup = async (): Promise<void> => {
    setSetupBusy(true)
    try {
      await startSetup()
    } finally {
      setSetupBusy(false)
    }
  }
  const scaffold = async (): Promise<void> => {
    setBusy(true)
    try {
      await startRun(SCAFFOLD_PROMPT, { scaffold: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="new-run">
      <div className="new-run-inner">
        {needsSetup ? (
          <section className="new-run-intro">
            <h2>{project.setup?.state === 'pending' ? 'Set this project up with the Architect' : 'Setup is not finished'}</h2>
            <p>
              {project.setup?.kind === 'new'
                ? 'The Architect asks a few questions about your idea, then proposes the architecture, the org chart, and the run settings. You approve each one.'
                : 'The Architect scans the repository, reads the code, and proposes an architecture document, an org chart that fits the work already done, and run settings. You approve each one.'}
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <Button variant="primary" loading={setupBusy} onClick={() => void beginSetup()}>
                {setupBusy ? 'Scanning…' : project.setup?.state === 'pending' ? 'Start setup' : 'Resume setup'}
              </Button>
            </div>
          </section>
        ) : (
          <section className="new-run-intro">
            <h2>Give {rootName} something to do</h2>
            <p>
              Type a task below. The orchestrator plans it and delegates to its reports. Every subagent appears here the moment it is created,
              attached to the agent that spawned it.
            </p>
            <ul className="role-chips" aria-label="Roles in this project">
              {project.roles.map((r) => (
                <li key={r.id} className="role-tag" style={{ ['--role' as string]: r.color }}>
                  {r.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        <McpAuthNotice project={project} />

        <Composer
          draftKey={newRunDraftKey(project.id)}
          modeLabel={others.length > 0 ? `New run: ${others.length} other run${others.length === 1 ? '' : 's'} keep${others.length === 1 ? 's' : ''} going` : 'New run'}
          primaryLabel="Start"
          placeholder={needsSetup ? 'Describe the task (setup is not finished)' : 'Describe the task'}
          autoFocus
          focusToken={focusToken}
          onSubmit={async (text, images) => {
            await startRun(text, images ? { images } : undefined)
          }}
        />

        {others.length > 0 && (
          <section className="new-run-others" aria-label="Other runs of this project">
            <h3>
              {others.length} other run{others.length === 1 ? '' : 's'} keep{others.length === 1 ? 's' : ''} going
            </h3>
            <ul>
              {others.map((o) => (
                <li key={o.id}>
                  <button type="button" className="link-btn" onClick={() => void openRun(o.id)}>
                    {runTitle(indexes.get(o.id), o.prompt, 60)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!needsSetup && project.setup?.kind === 'new' && project.setup.state === 'complete' && !project.setup.scaffoldedAt && (
          <section className="new-run-scaffold">
            <p>
              Setup is complete and the folder is still empty. The org chart can build the initial structure from the approved architecture
              document.{' '}
              {project.permissionMode === 'auto'
                ? 'It runs unattended: Claude approves each call and asks only when unsure.'
                : project.permissionMode === 'acceptEdits'
                  ? 'Edits are auto-accepted; shell commands still ask.'
                  : 'Approvals follow the project permission mode.'}
            </p>
            <Button variant="primary" loading={busy} onClick={() => void scaffold()}>
              {busy ? 'Starting…' : 'Scaffold the project'}
            </Button>
          </section>
        )}
      </div>
    </div>
  )
}
