import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Project, ProjectPathCheck, QuickRunTeam } from '@shared/types'
import { QUICK_RUN_MAX_PROMPT_CHARS } from '@shared/types'
import { chatSummaryLine, START_PAGE_COPY } from '../../lib/assistants'
import { useAssistantModelName } from '../../lib/assistantModels'
import { folderName } from '../../lib/paths'
import { CONNECTION_LABEL } from '../../lib/usage'
import { newRunDraftKey, useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Switch } from '../ui/Switch'
import Composer from '../Composer'

const TEAMS: { value: QuickRunTeam; label: string }[] = [
  { value: 'single', label: 'One assistant' },
  { value: 'default', label: 'Use the app’s default team' }
]

/**
 * The Chat start page: a folder (or a scratch area), a team, whether edits are allowed, then the composer. Starting
 * calls startQuick; a rejection shows in the composer and keeps the draft.
 */
export default function ChatStartPage({ project }: { project: Project }): ReactElement {
  const copy = START_PAGE_COPY.quick
  const startQuick = useAppStore((s) => s.startQuick)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const model = useAssistantModelName('quickRunModel')
  const [folder, setFolder] = useState<string | null>(null)
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [team, setTeam] = useState<QuickRunTeam>('single')
  const [allowEdits, setAllowEdits] = useState(false)
  const check = useRef(0)
  const teamName = useId()
  const editsHint = useId()
  const scratch = folder === null

  useEffect(() => {
    const n = ++check.current
    setExisting(null)
    if (!folder) return
    void window.orgai.projects.checkPath(folder).then(
      (r: ProjectPathCheck) => {
        if (n === check.current && r.existingProjectId) setExisting({ id: r.existingProjectId, name: r.existingProjectName ?? folderName(folder) })
      },
      () => undefined
    )
  }, [folder])

  const browse = async (): Promise<void> => {
    setPickError(null)
    try {
      const picked = await window.orgai.projects.pickDirectory()
      if (picked) setFolder(picked)
    } catch (e) {
      setPickError(e instanceof Error ? e.message : 'Could not open the folder chooser.')
    }
  }
  const clear = (): void => {
    setFolder(null)
    setAllowEdits(false)
  }

  const summary = chatSummaryLine({
    scratch,
    folderName: folder ? folderName(folder) : undefined,
    allowEdits,
    model,
    connection: CONNECTION_LABEL[defaultConnection ?? 'anthropic'],
    mock
  })

  return (
    <div className="new-run" data-testid="assistant-start-quick">
      <div className="new-run-inner">
        <EmptyState title={copy.title} description={copy.description} />

        <div className="chat-options">
          <div className="chat-folder" data-testid="chat-folder">
            <span className="chat-folder-label" id="chat-folder-label">
              Work in a folder
            </span>
            <span className="chat-folder-value" title={folder ?? undefined} aria-labelledby="chat-folder-label">
              {folder ? folderName(folder) : 'No folder (a scratch area)'}
            </span>
            <span className="chat-folder-actions">
              <Button size="sm" testId="chat-folder-browse" onClick={() => void browse()}>
                Browse
              </Button>
              {folder && (
                <Button size="sm" variant="ghost" testId="chat-folder-clear" onClick={clear}>
                  Clear
                </Button>
              )}
            </span>
          </div>
          {pickError && (
            <p className="chat-note is-error" role="alert">
              {pickError}
            </p>
          )}
          {existing && (
            <p className="chat-note" data-testid="chat-existing-project">
              This folder is the project {existing.name}.{' '}
              <Button
                size="sm"
                testId="chat-open-project"
                onClick={() => {
                  void openProject(existing.id).then(() => setView('run'))
                }}
              >
                Open {existing.name}
              </Button>
            </p>
          )}

          <details className="chat-team" data-testid="chat-team">
            <summary>Team</summary>
            <fieldset className="chat-team-options">
              <legend className="sr-only">Team</legend>
              {TEAMS.map((t) => (
                <label key={t.value} className="chat-radio">
                  <input type="radio" name={teamName} value={t.value} checked={team === t.value} onChange={() => setTeam(t.value)} />
                  {t.label}
                </label>
              ))}
            </fieldset>
          </details>

          <div className="assistant-switch-row">
            <span>
              Allow edits in this folder
              {scratch && (
                <span className="muted chat-edits-hint" id={editsHint}>
                  {' '}
                  Choose a folder to allow edits.
                </span>
              )}
            </span>
            <Switch
              testId="chat-allow-edits"
              label="Allow edits in this folder"
              describedBy={scratch ? editsHint : undefined}
              checked={allowEdits && !scratch}
              disabled={scratch}
              onChange={setAllowEdits}
            />
          </div>

          <p className="muted chat-summary" data-testid="chat-summary">
            {summary}
          </p>
        </div>

        <Composer
          draftKey={newRunDraftKey(project.id)}
          modeLabel="New chat"
          primaryLabel="Start"
          placeholder="Describe the task"
          autoFocus
          onSubmit={async (text, images) => {
            if (text.length > QUICK_RUN_MAX_PROMPT_CHARS) {
              throw new Error(`That message is too long (the limit is ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString()} characters). Shorten it and try again.`)
            }
            await startQuick({ prompt: text, ...(folder ? { folder } : {}), team, allowEdits: allowEdits && !scratch, ...(images ? { images } : {}) })
          }}
        />
      </div>
    </div>
  )
}
