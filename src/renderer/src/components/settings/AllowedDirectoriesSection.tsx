import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Project } from '@shared/types'
import { PROJECT_ALLOWED_DIRECTORIES_MAX } from '@shared/types'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import { allowedFolderDraftProblem, droppedFolderNotice, droppedFolders } from '../../lib/permissionCopy'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'

export const ALLOWED_FOLDERS_HINT =
  "Agents may read and edit files here without asking, under the same permission mode as the project folder. OrgAI's data folder can never be added."

/**
 * Project settings > Agents > Allowed folders (`Project.allowedDirectories`). Every change saves at once through
 * `saveProjectNow`; a folder main dropped while cleaning the list gets a quiet notice, derived by comparing the saved
 * project with what was sent.
 */
export function AllowedDirectoriesSection({ project }: { project: Project }): ReactElement {
  const dirs = project.allowedDirectories ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  /** Polite announcement of a finished add or remove ("Added <path>."). */
  const [announce, setAnnounce] = useState('')
  const inputId = useId()
  const errorId = `${inputId}-error`
  const listRef = useRef<HTMLUListElement>(null)
  const full = dirs.length >= PROJECT_ALLOWED_DIRECTORIES_MAX

  /** Save the new list on the freshest copy of the project; returns the folders main dropped, or null on failure. */
  const save = async (next: string[]): Promise<string[] | null> => {
    const st = useAppStore.getState()
    const current = st.projects.find((p) => p.id === project.id) ?? project
    const updated: Project = { ...current, allowedDirectories: next }
    setBusy(true)
    setError(null)
    try {
      // Replace any pending debounced save with this snapshot first, so an older one cannot land after it.
      st.updateProject(updated)
      const saved = await st.saveProjectNow(updated)
      return droppedFolders(next, saved.allowedDirectories)
    } catch (e) {
      setError(cleanIpcError(e, 'The folders could not be saved. Try again.'))
      return null
    } finally {
      setBusy(false)
    }
  }

  /**
   * Focus to restore once a save settles and the controls are enabled again: a remove button index (clamped to the
   * last row) or null for the folder input. Applied in an effect, so it never lands on a still-disabled control.
   */
  const pendingFocus = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (busy || pendingFocus.current === undefined) return
    const index = pendingFocus.current
    pendingFocus.current = undefined
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-testid=allowed-folder-remove]')
    const target = index === null || !buttons?.length ? null : buttons[Math.min(index, buttons.length - 1)]
    if (target) target.focus()
    else document.getElementById(inputId)?.focus()
  }, [busy, dirs.length, inputId])

  const add = async (value = draft): Promise<void> => {
    if (busy) return
    const text = value.trim()
    const problem = allowedFolderDraftProblem(text, dirs)
    if (problem) {
      setError(problem)
      return
    }
    setAnnounce('')
    // Success, refusal or save error: the keyboard returns to the input (an error is linked by aria-describedby).
    pendingFocus.current = null
    const dropped = await save([...dirs, text])
    if (dropped === null) return
    if (dropped.length) {
      setNotices((n) => [...n.filter((x) => !dropped.includes(x)), ...dropped])
    } else {
      setDraft('')
      setNotices((n) => n.filter((x) => x !== text))
      setAnnounce(`Added ${text}.`)
    }
  }

  const remove = async (dir: string, index: number): Promise<void> => {
    setAnnounce('')
    // Removed: the next row's remove button (the previous for the last row), else the input. Failed: the row is
    // still there, so its own remove button.
    pendingFocus.current = index
    const dropped = await save(dirs.filter((d) => d !== dir))
    if (dropped !== null) setAnnounce(`Removed ${dir}.`)
  }

  const browse = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await window.orgai.projects.pickDirectory()
      if (picked) {
        setDraft(picked)
        await add(picked)
      }
    } catch (e) {
      setError(cleanIpcError(e, 'Could not open the folder chooser.'))
    }
  }

  return (
    <SettingsSection id={PROJECT_SETTINGS_SECTIONS.allowedFolders} title="Allowed folders" testId="allowed-folders-section">
      <SettingsCard>
        <p className="settings-card-note allowed-folders-hint">{ALLOWED_FOLDERS_HINT}</p>
        {dirs.length === 0 ? (
          <p className="settings-card-note" data-testid="allowed-folders-empty">
            No extra folders. Agents work in the project folder and its worktrees.
          </p>
        ) : (
          <ul className="settings-card-list" aria-label="Allowed folders" ref={listRef}>
            {dirs.map((dir, i) => (
              <li key={dir} className="settings-card-item" data-testid="allowed-folder-row" data-path={dir}>
                <span className="allowed-folder-path" title={dir}>
                  {dir}
                </span>
                <IconButton icon={X} size="sm" label={`Remove ${dir}`} disabled={busy} testId="allowed-folder-remove" onClick={() => void remove(dir, i)} />
              </li>
            ))}
          </ul>
        )}
        <div className="settings-card-add">
          <div className="allowed-folder-add">
            <div className="grow">
              <Input
                id={inputId}
                aria-label="Folder path"
                mono
                value={draft}
                readOnly={busy}
                aria-busy={busy || undefined}
                placeholder="An absolute folder path"
                spellCheck={false}
                autoComplete="off"
                invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                data-testid="allowed-folder-input"
                onChange={(v) => {
                  setDraft(v)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void add()
                  }
                }}
              />
            </div>
            <Button size="sm" testId="allowed-folder-browse" disabled={busy || full} onClick={() => void browse()}>
              Browse
            </Button>
            <Button
              size="sm"
              variant="primary"
              testId="allowed-folder-add"
              disabled={busy || full}
              title={full ? `A project can list at most ${PROJECT_ALLOWED_DIRECTORIES_MAX} folders.` : undefined}
              onClick={() => void add()}
            >
              Add folder
            </Button>
          </div>
          {error && (
            <span className="field-error" id={errorId} role="alert" data-testid="allowed-folder-error">
              {error}
            </span>
          )}
          <span className="sr-only" role="status" data-testid="allowed-folder-announce">
            {announce}
          </span>
          {/* Always mounted and never hidden (CSS collapses it while empty), so the first notice is announced too. */}
          <ul className="allowed-folder-notices" role="status">
              {notices.map((n) => (
                <li key={n} className="allowed-folder-notice" data-testid="allowed-folder-notice">
                  <span>{droppedFolderNotice(n)}</span>
                  <IconButton icon={X} size="sm" label="Dismiss notice" onClick={() => setNotices((all) => all.filter((x) => x !== n))} />
                </li>
              ))}
          </ul>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
