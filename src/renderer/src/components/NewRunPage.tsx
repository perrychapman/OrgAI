import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Project } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { setupPending } from '@shared/setup'
import { projectKindOf } from '@shared/defaults'
import { newRunLead, projectKindCopy, projectNoun } from '../lib/projectKindCopy'
import { SegmentedControl } from './ui/SegmentedControl'
import { isRunLive, newRunDraftKey, useAppStore, useRunIndexes } from '../store/useAppStore'
import { promptLine, runTitle } from '../lib/runLabels'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import TeamFilesPointer from './team/TeamFilesPointer'
import Composer from './Composer'
import McpAuthNotice from './mcp/McpAuthNotice'
import FolderTrustNotice from './FolderTrustNotice'

const SCAFFOLD_PROMPT =
  'The project folder is empty or nearly empty. If it is not a git repository yet, run git init and make an initial commit before delegating, so reports can work in isolated worktrees. Then scaffold the project according to .orgai/ARCHITECTURE.md: create the structure, tooling, build and test commands, and a minimal end-to-end slice that runs. Keep every decision consistent with the architecture document, and report what you created.'

type NewRunMode = 'team' | 'ask'
const newRunModeKey = (projectId: string): string => `orgai.newRunMode.${projectId}`
function readNewRunMode(projectId: string): NewRunMode {
  try {
    return localStorage.getItem(newRunModeKey(projectId)) === 'ask' ? 'ask' : 'team'
  } catch {
    return 'team'
  }
}

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
  const kind = projectKindOf(project)
  const engagement = kind === 'engagement'
  const rootName =project.roles.find((r) => r.reportsTo === null)?.name ?? 'the orchestrator'
  const canChooseMode = !needsSetup && !isVirtualProjectId(project.id)
  const [mode, setModeState] = useState<NewRunMode>(() => readNewRunMode(project.id))
  useEffect(() => setModeState(readNewRunMode(project.id)), [project.id])
  const ask = canChooseMode && mode === 'ask'
  const setMode = (m: NewRunMode): void => {
    setModeState(m)
    try {
      localStorage.setItem(newRunModeKey(project.id), m)
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  }
  const noun = projectNoun(kind)
  const hasReferences = (project.referenceDirectories?.length ?? 0) > 0
  const askLead = `One assistant answers here as a conversation. It can use this ${noun}'s folders, services and skills, with the same permissions. No team members start.${hasReferences ? ' It can read the reference folders but not change them.' : ''}`

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
        <TeamFilesPointer projectId={project.id} />
        {needsSetup ? (
          <EmptyState
            title={project.setup?.state === 'pending' ? 'Set this project up with the Architect' : 'Setup is not finished'}
            description={
              engagement
                ? projectKindCopy(kind).setupLead
                : project.setup?.kind === 'new'
                ? 'The Architect asks a few questions about your idea, then proposes the architecture, the org chart, and the run settings. You approve each one.'
                : 'The Architect scans the repository, reads the code, and proposes an architecture document, an org chart that fits the work already done, and run settings. You approve each one.'
            }
            actions={
              <Button variant="primary" loading={setupBusy} onClick={() => void beginSetup()}>
                {setupBusy ? 'Scanning…' : project.setup?.state === 'pending' ? 'Start setup' : 'Resume setup'}
              </Button>
            }
          />
        ) : ask ? (
          <EmptyState title="Ask one assistant" description={<span data-testid="new-run-ask-lead">{askLead}</span>} />
        ) : (
          <EmptyState
            title={`Give ${rootName} something to do`}
            description={
              newRunLead(kind, rootName) ??
              'Type a task below. The orchestrator plans it and delegates to its reports. Every subagent appears here the moment it is created, attached to the agent that spawned it.'
            }
            actions={
              <ul className="role-chips" aria-label="Roles in this project">
                {project.roles.map((r) => (
                  <li key={r.id} className="role-tag" style={{ ['--role' as string]: r.color }}>
                    {r.name}
                  </li>
                ))}
              </ul>
            }
          />
        )}

        <McpAuthNotice project={project} />
        <FolderTrustNotice project={project} />

        <Composer
          draftKey={newRunDraftKey(project.id)}
          modeLabel={
            ask
              ? 'Ask one assistant'
              : others.length > 0
                ? `New run: ${others.length} other run${others.length === 1 ? '' : 's'} keep${others.length === 1 ? 's' : ''} going`
                : 'New run'
          }
          primaryLabel={ask ? 'Ask' : 'Start'}
          placeholder={ask ? 'Ask a question or give a small task' : needsSetup ? 'Describe the task (setup is not finished)' : 'Describe the task'}
          modeSwitch={
            canChooseMode ? (
              <span className="new-run-mode" data-testid="new-run-mode">
                <SegmentedControl<NewRunMode>
                  label="Who works on it"
                  value={mode}
                  options={[
                    { value: 'team', label: 'Team' },
                    { value: 'ask', label: 'Ask' }
                  ]}
                  onChange={setMode}
                />
              </span>
            ) : undefined
          }
          notices={ask ? <p className="new-run-mode-desc" data-testid="new-run-mode-desc">New conversation with one assistant. No team is started.</p> : undefined}
          autoFocus
          focusToken={focusToken}
          onSubmit={async (text, images) => {
            await startRun(text, { ...(images ? { images } : {}), ...(ask ? { team: 'single' as const } : {}) })
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
                  <button type="button" className="link-btn" title={promptLine(o.prompt)} onClick={() => void openRun(o.id)}>
                    {runTitle(indexes.get(o.id), o)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!needsSetup && !engagement && project.setup?.kind === 'new' && project.setup.state === 'complete' && !project.setup.scaffoldedAt && (
          <section className="new-run-scaffold">
            <p>
              Setup is complete and the folder is still empty. The org chart can build the initial structure from the approved architecture
              document.{' '}
              {project.permissionMode === 'auto'
                ? "It runs unattended: the model's safety check approves each call and asks only when unsure."
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
