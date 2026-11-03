import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project, ProjectPathCheck, QuickRunTeam } from '@shared/types'
import { QUICK_RUN_MAX_PROMPT_CHARS } from '@shared/types'
import { chatSummaryLine, START_PAGE_COPY } from '../../lib/assistants'
import { useAssistantRunsOn } from '../../lib/assistantModels'
import { folderName } from '../../lib/paths'
import { pathStatus } from '../../lib/projectsForm'
import { CONNECTION_NAME } from '../../lib/settingsCopy'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { newRunDraftKey, useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Input } from '../ui/Input'
import Composer from '../Composer'

const TEAMS: { value: QuickRunTeam; label: string }[] = [
  { value: 'single', label: 'One assistant' },
  { value: 'default', label: 'Use the app’s default team' }
]

/**
 * The Chat start page: a folder (typed, pasted or browsed; or a scratch area), a team, whether edits are allowed,
 * then the composer. The typed path is checked like the New project form's (checkPath, 300 ms debounce). Starting
 * calls startQuick; a rejection shows in the composer and keeps the draft.
 */
export default function ChatStartPage({ project }: { project: Project }): ReactElement {
  const copy = START_PAGE_COPY.quick
  const startQuick = useAppStore((s) => s.startQuick)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const defaultConnection = useAppStore((s) => s.defaultConnection)
  const mock = useAppStore((s) => s.appInfo?.mockAdapter ?? false)
  const model = useAssistantRunsOn('quickRunModel').label
  const [text, setText] = useState('')
  const [checked, setChecked] = useState<{ path: string; result: ProjectPathCheck } | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [team, setTeam] = useState<QuickRunTeam>('single')
  const [allowEdits, setAllowEdits] = useState(false)
  const teamName = useId()
  const folderId = useId()
  const statusId = useId()
  const editsLabel = useId()
  const editsHint = useId()
  const typed = text.trim()

  useEffect(() => {
    if (!typed) return
    let live = true
    const t = setTimeout(() => {
      window.orgai.projects.checkPath(typed).then(
        (result) => {
          if (live) setChecked({ path: typed, result })
        },
        () => undefined
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [typed])

  const current = checked && checked.path === typed ? checked.result : null
  const status = typed ? pathStatus('existing', typed, current) : null
  const blocked = status?.blocking ? status.text : null
  // The folder the chat will use: a typed path counts until the check says it cannot.
  const folder = typed && !blocked ? typed : null
  const scratch = folder === null
  const existing = current?.existingProjectId ? { id: current.existingProjectId, name: current.existingProjectName ?? folderName(typed) } : null

  const browse = async (): Promise<void> => {
    setPickError(null)
    try {
      const picked = await window.orgai.projects.pickDirectory()
      if (picked) setText(picked)
    } catch (e) {
      setPickError(e instanceof Error ? e.message : 'Could not open the folder chooser.')
    }
  }
  const clear = (): void => {
    setText('')
    setAllowEdits(false)
  }

  const summary = chatSummaryLine({
    scratch,
    folderName: folder ? folderName(folder) : undefined,
    allowEdits,
    model,
    connection: defaultConnection ? CONNECTION_NAME[defaultConnection] : undefined,
    mock
  })

  return (
    <div className="new-run" data-testid="assistant-start-quick">
      <div className="new-run-inner">
        <EmptyState title={copy.title} description={copy.description} />

        <div className="chat-options">
          <div className="chat-folder" data-testid="chat-folder">
            <label className="chat-folder-label" htmlFor={folderId}>
              Work in a folder
            </label>
            <Input
              id={folderId}
              mono
              data-testid="chat-folder-input"
              value={text}
              placeholder="No folder (a scratch area)"
              title={typed || undefined}
              invalid={!!blocked}
              aria-describedby={blocked ? statusId : undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={setText}
            />
            <span className="chat-folder-actions">
              <Button size="sm" testId="chat-folder-browse" onClick={() => void browse()}>
                Browse
              </Button>
              {text && (
                <Button size="sm" variant="ghost" testId="chat-folder-clear" onClick={clear}>
                  Clear
                </Button>
              )}
            </span>
          </div>
          {blocked && (
            <p className="chat-note is-error" id={statusId} role="status" data-testid="chat-folder-error">
              {blocked}
            </p>
          )}
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

          <div className="chat-options-row">
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
              <div className="assistant-switch-text">
                <span id={editsLabel}>Allow edits in this folder</span>
                {scratch && (
                  <span className="muted chat-edits-hint" id={editsHint}>
                    Choose a folder to allow edits.
                  </span>
                )}
              </div>
              {/* aria-disabled, not disabled: the switch stays in the tab order and its hint is read. */}
              <button
                type="button"
                role="switch"
                className="switch"
                data-testid="chat-allow-edits"
                aria-checked={allowEdits && !scratch}
                aria-labelledby={editsLabel}
                aria-describedby={scratch ? editsHint : undefined}
                aria-disabled={scratch || undefined}
                onClick={() => {
                  if (!scratch) setAllowEdits(!allowEdits)
                }}
              >
                <span className="switch-thumb" />
              </button>
            </div>
          </div>

          <p className="muted chat-summary" data-testid="chat-summary">
            {summary}
          </p>
          <button
            type="button"
            className="link-btn chat-model-change"
            data-testid="chat-model-change"
            onClick={() => {
              requestAppSettingsSection(APP_SETTINGS_SECTIONS.assistantModels)
              setView('appSettings')
              window.dispatchEvent(new Event('orgai:settings-section'))
            }}
          >
            Change in App settings
          </button>
        </div>

        <Composer
          draftKey={newRunDraftKey(project.id)}
          modeLabel="New chat"
          primaryLabel="Start"
          placeholder="Describe the task"
          autoFocus
          onSubmit={async (prompt, images) => {
            if (prompt.length > QUICK_RUN_MAX_PROMPT_CHARS) {
              throw new Error(`That message is too long (the limit is ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString()} characters). Shorten it and try again.`)
            }
            // Check the folder again at Start: the debounced check may not have answered yet.
            if (typed) {
              const fresh = await window.orgai.projects.checkPath(typed).catch(() => null)
              const problem = pathStatus('existing', typed, fresh)
              if (problem?.blocking) throw new Error(`Cannot start in that folder. ${problem.text} Clear the folder to chat in a scratch area.`)
            }
            await startQuick({ prompt, ...(typed ? { folder: typed } : {}), team, allowEdits: allowEdits && !scratch, ...(images ? { images } : {}) })
          }}
        />
      </div>
    </div>
  )
}
