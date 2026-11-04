import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Lock, Pencil, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { PROJECT_ALLOWED_DIRECTORIES_MAX } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { useConfirm } from '../ui/ConfirmDialog'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'
import { droppedFolderNotice, droppedFolders } from '../../lib/permissionCopy'
import { folderConflict, folderDraftProblem, moveConfirmCopy, moveFolder, type FolderListKind } from '../../lib/folderLists'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { cleanIpcError } from '../../lib/ipcError'
import { useAppStore } from '../../store/useAppStore'

export const allowedFoldersHint = (engagement: boolean): string =>
  `Agents may read and change files here, with the same permission mode as the ${engagement ? 'working' : 'project'} folder.`
export const REFERENCE_FOLDERS_HINT = 'Agents can read files here. They can never change, add or delete anything, in any permission mode.'

interface ListCopy {
  /** data-testid prefix: `${prefix}-row`, `-input`, `-add`, ... */
  prefix: string
  title: string
  hint: string
  accessWord: string
  inputLabel: string
  addLabel: string
  browseLabel: string
  moveWord: string
  movedTo: string
}

const COPY: Record<FolderListKind, ListCopy> = {
  allowed: {
    prefix: 'allowed-folder',
    title: 'Allowed folders (read and change)',
    hint: '',
    accessWord: 'Can change',
    inputLabel: 'Allowed folder path',
    addLabel: 'Add folder to allowed folders',
    browseLabel: 'Browse for an allowed folder',
    moveWord: 'Make read only',
    movedTo: 'allowed folders (read and change)'
  },
  reference: {
    prefix: 'reference-folder',
    title: 'Reference folders (read only)',
    hint: REFERENCE_FOLDERS_HINT,
    accessWord: 'Read only',
    inputLabel: 'Reference folder path',
    addLabel: 'Add folder to reference folders',
    browseLabel: 'Browse for a reference folder',
    moveWord: 'Allow changes',
    movedTo: 'reference folders (read only)'
  }
}

const listOf = (p: Project, kind: FolderListKind): string[] => (kind === 'allowed' ? p.allowedDirectories : p.referenceDirectories) ?? []

/**
 * Save one or both folder lists on the freshest copy of the project; returns the folders main dropped from each list
 * it was sent (compared with the project main returned).
 */
async function saveLists(
  project: Project,
  next: { allowedDirectories?: string[]; referenceDirectories?: string[] }
): Promise<Record<FolderListKind, string[]>> {
  const st = useAppStore.getState()
  const current = st.projects.find((p) => p.id === project.id) ?? project
  const updated: Project = { ...current, ...next }
  // Replace any pending debounced save with this snapshot first, so an older one cannot land after it.
  st.updateProject(updated)
  const saved = await st.saveProjectNow(updated)
  return {
    allowed: next.allowedDirectories ? droppedFolders(next.allowedDirectories, saved.allowedDirectories) : [],
    reference: next.referenceDirectories ? droppedFolders(next.referenceDirectories, saved.referenceDirectories) : []
  }
}

/**
 * One folder card of Project settings > Permissions: `reference` (read only) or `allowed` (read and change). Every
 * change saves at once through `saveProjectNow`; a folder main dropped while cleaning gets a quiet notice, and a row
 * action or a confirmed add moves a folder between the two lists in a single save.
 */
export function FolderListSection({ project, kind }: { project: Project; kind: FolderListKind }): ReactElement {
  const c = COPY[kind]
  const other: FolderListKind = kind === 'allowed' ? 'reference' : 'allowed'
  const p = c.prefix
  const dirs = listOf(project, kind)
  const otherDirs = listOf(project, other)
  const engagement = projectKindOf(project) === 'engagement'
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  /** Polite announcement of a finished add, remove or move. */
  const [announce, setAnnounce] = useState('')
  const inputId = useId()
  const errorId = `${inputId}-error`
  const listRef = useRef<HTMLUListElement>(null)
  const { confirm, dialog } = useConfirm()
  const full = dirs.length >= PROJECT_ALLOWED_DIRECTORIES_MAX
  const otherFull = otherDirs.length >= PROJECT_ALLOWED_DIRECTORIES_MAX

  /** Run a save; returns the dropped folders per list, or null on failure (the error shows inline). */
  const save = async (next: { allowedDirectories?: string[]; referenceDirectories?: string[] }): Promise<Record<FolderListKind, string[]> | null> => {
    setBusy(true)
    setError(null)
    try {
      return await saveLists(project, next)
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
    const buttons = listRef.current?.querySelectorAll<HTMLElement>(`[data-testid=${p}-remove]`)
    const target = index === null || !buttons?.length ? null : buttons[Math.min(index, buttons.length - 1)]
    if (target) target.focus()
    else document.getElementById(inputId)?.focus()
  }, [busy, dirs.length, inputId, p])

  /** Move `path` out of list `from` into the other list, in one save. */
  const relocate = async (path: string, from: FolderListKind): Promise<boolean> => {
    const to: FolderListKind = from === 'allowed' ? 'reference' : 'allowed'
    const moved = moveFolder(listOf(project, from), listOf(project, to), path)
    const next = from === 'allowed' ? { allowedDirectories: moved.from, referenceDirectories: moved.to } : { referenceDirectories: moved.from, allowedDirectories: moved.to }
    const dropped = await save(next)
    if (dropped === null) return false
    // Report drops from both lists; a folder the target dropped did not move, so it is not announced as moved.
    const mine = [...dropped[kind], ...dropped[to]].filter((x, i, all) => all.indexOf(x) === i)
    if (mine.length) setNotices((n) => [...n.filter((x) => !mine.includes(x)), ...mine])
    const targetDropped = dropped[to].length > 0
    setAnnounce(targetDropped ? '' : `Moved ${path} to ${COPY[to].movedTo}.`)
    return !targetDropped
  }

  const add = async (value = draft): Promise<void> => {
    if (busy) return
    const text = value.trim()
    const problem = folderDraftProblem(text, dirs, project.path, projectKindOf(project))
    if (problem) {
      setError(problem)
      return
    }
    setAnnounce('')
    const conflict = folderConflict(text, otherDirs)
    if (conflict) {
      const ok = await confirm(moveConfirmCopy(kind, conflict))
      // Cancel keeps both lists as they were.
      pendingFocus.current = null
      if (!ok) {
        document.getElementById(inputId)?.focus()
        return
      }
      if (await relocate(conflict, other)) {
        setDraft('')
        setNotices((n) => n.filter((x) => x !== text))
      }
      return
    }
    // Success, refusal or save error: the keyboard returns to the input (an error is linked by aria-describedby).
    pendingFocus.current = null
    const dropped = await save(kind === 'allowed' ? { allowedDirectories: [...dirs, text] } : { referenceDirectories: [...dirs, text] })
    if (dropped === null) return
    const mine = dropped[kind]
    if (mine.length) {
      setNotices((n) => [...n.filter((x) => !mine.includes(x)), ...mine])
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
    const dropped = await save(kind === 'allowed' ? { allowedDirectories: dirs.filter((d) => d !== dir) } : { referenceDirectories: dirs.filter((d) => d !== dir) })
    if (dropped !== null) setAnnounce(`Removed ${dir}.`)
  }

  const move = async (dir: string, index: number): Promise<void> => {
    setAnnounce('')
    pendingFocus.current = index
    await relocate(dir, kind)
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

  const emptyText =
    kind === 'reference'
      ? 'No reference folders. Add folders agents may read but never change.'
      : engagement
        ? 'No extra folders. Agents work in the working folder.'
        : 'No extra folders. Agents work in the project folder and its worktrees.'

  return (
    <SettingsSection
      id={kind === 'allowed' ? PROJECT_SETTINGS_SECTIONS.allowedFolders : 'settings-section-reference-folders'}
      title={c.title}
      testId={kind === 'allowed' ? 'allowed-folders-section' : 'reference-folders-section'}
    >
      <SettingsCard>
        <p className="settings-card-note allowed-folders-hint" data-testid={`${p}s-hint`}>
          {kind === 'allowed' ? allowedFoldersHint(engagement) : c.hint}
        </p>
        {dirs.length === 0 ? (
          <p className="settings-card-note" data-testid={`${p}s-empty`}>
            {emptyText}
          </p>
        ) : (
          <ul className="settings-card-list" aria-label={c.title} ref={listRef}>
            {dirs.map((dir, i) => (
              <li key={dir} className="settings-card-item" data-testid={`${p}-row`} data-path={dir}>
                <span className="allowed-folder-path" title={dir}>
                  {dir}
                </span>
                <span className="folder-access" data-testid={`${p}-access`} data-access={kind === 'reference' ? 'read' : 'write'}>
                  <Icon icon={kind === 'reference' ? Lock : Pencil} size="xs" />
                  {c.accessWord}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  testId={kind === 'allowed' ? `${p}-make-readonly` : `${p}-allow-changes`}
                  ariaLabel={`${c.moveWord}: ${dir}`}
                  disabled={busy || otherFull}
                  title={otherFull ? `A project can list at most ${PROJECT_ALLOWED_DIRECTORIES_MAX} folders in each list.` : undefined}
                  onClick={() => void move(dir, i)}
                >
                  {c.moveWord}
                </Button>
                <IconButton icon={X} size="sm" label={`Remove ${dir}`} disabled={busy} testId={`${p}-remove`} onClick={() => void remove(dir, i)} />
              </li>
            ))}
          </ul>
        )}
        <div className="settings-card-add">
          <div className="allowed-folder-add">
            <div className="grow">
              <Input
                id={inputId}
                aria-label={c.inputLabel}
                mono
                value={draft}
                readOnly={busy}
                aria-busy={busy || undefined}
                placeholder="An absolute folder path"
                spellCheck={false}
                autoComplete="off"
                invalid={!!error}
                aria-describedby={error ? errorId : undefined}
                data-testid={`${p}-input`}
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
            <Button size="sm" testId={`${p}-browse`} ariaLabel={c.browseLabel} disabled={busy || full} onClick={() => void browse()}>
              Browse
            </Button>
            <Button
              size="sm"
              testId={`${p}-add`}
              ariaLabel={c.addLabel}
              disabled={busy || full}
              title={full ? `A project can list at most ${PROJECT_ALLOWED_DIRECTORIES_MAX} folders.` : undefined}
              onClick={() => void add()}
            >
              Add folder
            </Button>
          </div>
          {error && (
            <span className="field-error" id={errorId} role="alert" data-testid={`${p}-error`}>
              {error}
            </span>
          )}
          <span className="sr-only" role="status" data-testid={`${p}-announce`}>
            {announce}
          </span>
          {/* Always mounted and never hidden (CSS collapses it while empty), so the first notice is announced too. */}
          <ul className="allowed-folder-notices" role="status">
            {notices.map((n) => (
              <li key={n} className="allowed-folder-notice" data-testid={`${p}-notice`}>
                <span>{droppedFolderNotice(n)}</span>
                <IconButton icon={X} size="sm" label="Dismiss notice" onClick={() => setNotices((all) => all.filter((x) => x !== n))} />
              </li>
            ))}
          </ul>
        </div>
      </SettingsCard>
      {dialog}
    </SettingsSection>
  )
}

/** Project settings > Permissions > Allowed folders (read and change) (`Project.allowedDirectories`). */
export function AllowedDirectoriesSection({ project }: { project: Project }): ReactElement {
  return <FolderListSection project={project} kind="allowed" />
}
