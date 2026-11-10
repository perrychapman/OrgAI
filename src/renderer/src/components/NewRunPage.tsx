import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Effort, PermissionMode, Project, StaffingGoal } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { setupPending } from '@shared/setup'
import { projectConnection, projectKindOf } from '@shared/defaults'
import { projectStartRefusal } from '../lib/remap'
import { Banner } from './ui/Banner'
import { newRunLead, projectKindCopy, projectNoun } from '../lib/projectKindCopy'
import { SegmentedControl } from './ui/SegmentedControl'
import { isRunLive, newRunDraftKey, useAppStore, useRunIndexes } from '../store/useAppStore'
import { promptLine, runTag } from '../lib/runLabels'
import { displayRunName, isOrgChangeRun } from '../lib/orgChange'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import TeamFilesPointer from './team/TeamFilesPointer'
import Composer from './Composer'
import { goalToSend, selectedGoal, showsGoalChoice } from '../lib/runGoal'
import { staffingGoalOf } from '@shared/defaults'
import { EMPTY_RUN_SETTINGS, defaultRunEffort, defaultRunModel, isWideningMode, newRunPermissionChoices, startChoicesToSend, wideningConfirmOptions } from '../lib/runSettings'
import { useConfirm } from './ui/ConfirmDialog'
import type { RunModel } from '../lib/runSettings'
import { useAssistantModel } from '../lib/assistantModels'
import McpAuthNotice from './mcp/McpAuthNotice'
import FolderTrustNotice from './FolderTrustNotice'
import { RunSettingsRow } from './runSettings/RunSettingsRow'
import { StartModelControl } from './runSettings/StartModelControl'
import { EffortControl } from './runSettings/EffortControl'
import { PermissionModeControl } from './runSettings/PermissionModeControl'
import { GoalControl } from './runSettings/GoalControl'

/** Role chips shown on the empty state; the rest are behind "+N more" (Team view). */
const ROLE_CHIP_LIMIT = 5

const SCAFFOLD_PROMPT =
  'The project folder is empty or nearly empty. If it is not a git repository yet, run git init and make an initial commit before delegating, so reports can work in isolated worktrees. Then scaffold the project according to .orgai/ARCHITECTURE.md: create the structure, tooling, build and test commands, and a minimal end-to-end slice that runs. Keep every decision consistent with the architecture document, and report what you created.'

/** Thrown from onSubmit when the user declines the confirmation at Start: the draft comes back and no error is shown. */
class DeclinedStart extends Error {}

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
  const setView = useAppStore((s) => s.setView)
  const focusToken = useAppStore((s) => s.composerFocusToken)
  const runs = useAppStore((s) => s.runs)
  const others = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.summary.projectId === project.id && isRunLive(r))
        .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
        .map((r) => ({ id: r.summary.id, kind: r.summary.kind, prompt: r.summary.prompt, title: r.summary.title })),
    [runs, project.id]
  )
  const liveSetup = useMemo(() => [...others].reverse().find((o) => o.kind === 'setup'), [others])
  const indexes = useRunIndexes()
  const connections = useAppStore((s) => s.connections)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const loadModels = useAppStore((s) => s.loadModels)
  const ownConnection = projectConnection(project)
  const catalog = useAppStore((s) => s.models[ownConnection])
  const virtual = isVirtualProjectId(project.id)
  useEffect(() => {
    if (virtual) return
    if (!connections) void loadConnections()
    if (!catalog) void loadModels(ownConnection)
  }, [virtual, connections, catalog, ownConnection, loadConnections, loadModels])
  const startRefusalText = useMemo(
    () => (virtual || setupPending(project) ? null : projectStartRefusal(project, connections, catalog ?? [])),
    [virtual, project, connections, catalog]
  )
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
  // Run settings for this draft only: not remembered across starts or projects, kept when a start is refused.
  const [pickedGoal, setPickedGoal] = useState<StaffingGoal | null>(null)
  const [pickedModel, setPickedModel] = useState<RunModel | null>(null)
  const [pickedEffort, setPickedEffort] = useState<Effort | null>(null)
  const [pickedMode, setPickedMode] = useState<PermissionMode | null>(null)
  // The project mode the staged mode was chosen against (and confirmed against, when it widened).
  const [pickedModeBaseline, setPickedModeBaseline] = useState<PermissionMode | null>(null)
  const { confirm, dialog } = useConfirm()
  const resetMode = (): void => {
    setPickedMode(null)
    setPickedModeBaseline(null)
  }
  const resetPicks = (): void => {
    setPickedGoal(null)
    setPickedModel(null)
    setPickedEffort(null)
    resetMode()
  }
  useEffect(resetPicks, [project.id])
  // The project's own mode changed in its settings: a staged narrowing may now be a widening nobody confirmed.
  useEffect(resetMode, [project.permissionMode])
  const showGoal = canChooseMode && showsGoalChoice(project, ask)
  const goal = selectedGoal(project, pickedGoal)
  const quickRunModel = useAssistantModel('quickRunModel')
  const tierModels = connections?.find((c) => c.connection.id === ownConnection)?.connection.tierModels
  const defaultModel = useMemo(
    () => defaultRunModel(project, { ask, quickRunModel, tierModels, catalog }),
    [project, ask, quickRunModel, tierModels, catalog]
  )
  const defaultEffort = defaultRunEffort(project, ask)
  const runAdapter = (pickedModel ?? defaultModel)?.adapter ?? null
  const permissionChoices = useMemo(() => newRunPermissionChoices(), [])
  const shownMode = pickedMode ?? project.permissionMode
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
              // An open Architect session (setup or org change) is offered instead of a second one (UX re-walk M-new-2).
              liveSetup ? (
                <Button variant="primary" testId="new-run-open-setup" onClick={() => void openRun(liveSetup.id)}>
                  {isOrgChangeRun(liveSetup) ? 'Open the org change session' : 'Open the setup session'}
                </Button>
              ) : (
                <Button variant="primary" loading={setupBusy} onClick={() => void beginSetup()}>
                  {setupBusy ? 'Scanning…' : project.setup?.state === 'pending' ? 'Start setup' : 'Resume setup'}
                </Button>
              )
            }
          />
        ) : ask ? (
          <EmptyState title="Ask one assistant" description={<span data-testid="new-run-ask-lead">{askLead}</span>} />
        ) : (
          <EmptyState
            title={`Give ${rootName} something to do`}
            description={newRunLead(kind, rootName) ?? 'The orchestrator plans the task and hands parts to its team.'}
            actions={
              <ul className="role-chips" aria-label="Roles in this project">
                {project.roles.slice(0, ROLE_CHIP_LIMIT).map((r) => (
                  <li key={r.id} className="role-tag" style={{ ['--role' as string]: r.color }}>
                    {r.name}
                  </li>
                ))}
                {project.roles.length > ROLE_CHIP_LIMIT && (
                  <li>
                    <button
                      type="button"
                      className="link-btn"
                      data-testid="new-run-more-roles"
                      title={project.roles.map((r) => r.name).join(', ')}
                      onClick={() => setView('team')}
                    >
                      +{project.roles.length - ROLE_CHIP_LIMIT} more
                    </button>
                  </li>
                )}
              </ul>
            }
          />
        )}

        <McpAuthNotice project={project} />
        <FolderTrustNotice project={project} />
        {/* Ask runs one assistant on the project's connection and never bridges, so roles' connections do not apply. */}
        {startRefusalText && !ask && (
          <Banner tone="warning" testId="new-run-start-refusal">
            {startRefusalText} Start still tries; the run reports the same problem if it cannot begin.
          </Banner>
        )}

        <Composer
          draftKey={newRunDraftKey(project.id)}
          modeLabel={ask ? 'Ask one assistant' : 'New run'}
          primaryLabel={ask ? 'Ask' : needsSetup ? 'Start without setup' : 'Start'}
          primaryVariant={needsSetup ? 'secondary' : 'primary'}
          plainPlaceholder
          placeholder={ask ? 'Ask a question or give a small task' : 'Describe the task'}
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
          settings={
            canChooseMode ? (
              <>
                <RunSettingsRow surface="start">
                  <StartModelControl picked={pickedModel} defaultModel={defaultModel} ask={ask} mockProject={project.provider.id === 'mock'} onChange={setPickedModel} />
                  <EffortControl picked={pickedEffort} defaultEffort={defaultEffort} adapter={runAdapter} onChange={setPickedEffort} />
                  <PermissionModeControl
                    value={shownMode}
                    choices={permissionChoices}
                    baseline={project.permissionMode}
                    isDefault={pickedMode === null}
                    defaultMode={project.permissionMode}
                    onChoose={(m) => {
                      const same = m === project.permissionMode
                      setPickedMode(same ? null : m)
                      setPickedModeBaseline(same ? null : project.permissionMode)
                    }}
                  />
                  {showGoal && <GoalControl goal={goal} isDefault={pickedGoal === null} onChange={(g) => setPickedGoal(g === staffingGoalOf(project) ? null : g)} />}
                </RunSettingsRow>
                <p className="run-settings-note" data-testid="run-settings-note">
                  These choices apply to this run only. Project settings stay as they are.
                </p>
              </>
            ) : undefined
          }
          notices={
            needsSetup ? (
              <p className="new-run-mode-desc" data-testid="new-run-skip-setup">
                Skips the Architect: the run uses the current team and settings.
              </p>
            ) : undefined
          }
          autoFocus
          focusToken={focusToken}
          onFail={(err) => err instanceof DeclinedStart}
          onSubmit={async (text, images) => {
            // A staged mode that asks less than the project's mode now and was not confirmed against it is confirmed first.
            if (canChooseMode && pickedMode && isWideningMode(project.permissionMode, pickedMode) && pickedModeBaseline !== project.permissionMode) {
              const accepted = await confirm(wideningConfirmOptions(project.permissionMode, pickedMode))
              if (!accepted) {
                resetMode()
                throw new DeclinedStart()
              }
            }
            const sendGoal = goalToSend(project, ask, pickedGoal)
            // Setup pending and virtual projects show no settings row, so nothing of the draft applies there.
            const choices = canChooseMode
              ? startChoicesToSend(
                  { ...EMPTY_RUN_SETTINGS, model: pickedModel ? { model: pickedModel.model, connection: pickedModel.connection } : null, effort: pickedEffort, permissionMode: pickedMode },
                  { model: defaultModel, effort: defaultEffort, permissionMode: project.permissionMode },
                  runAdapter
                )
              : {}
            await startRun(text, { ...(images ? { images } : {}), ...(ask ? { team: 'single' as const } : {}), ...(sendGoal ? { goal: sendGoal } : {}), ...choices })
            // Started: the next draft begins from the project's defaults again. A refused start throws above and keeps every pick.
            resetPicks()
          }}
        />

        {dialog}

        {others.length > 0 && (
          <section className="new-run-others" aria-label="Other runs of this project">
            <h3>
              {others.length} other run{others.length === 1 ? '' : 's'} keep{others.length === 1 ? 's' : ''} going
            </h3>
            <ul>
              {others.map((o) => (
                <li key={o.id}>
                  <button type="button" className="link-btn" title={promptLine(o.prompt)} onClick={() => void openRun(o.id)}>
                    {`${runTag(indexes.get(o.id))}: ${displayRunName(o)}`}
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
