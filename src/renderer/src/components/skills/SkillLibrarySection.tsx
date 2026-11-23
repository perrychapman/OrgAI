import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { BookOpen, FolderPlus, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { DetailActions, DetailBlock, DetailHeader, DetailList, DetailNote, SettingsGallery, type GalleryItem } from '../settings/SettingsGallery'
import { useAppStore } from '../../store/useAppStore'
import type { SkillDraft, SkillLibraryInfo } from '@shared/types'
import { SKILL_BODY_MAX_CHARS } from '@shared/types'
import { draftProblems, hasDraftProblems, libraryRemoveLines, skillElevatedHint, skillScriptPaths, sourceLabel, usedByList } from '../../lib/skills'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { SettingsSection } from '../settings/SettingsSection'
import { APP_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { useSkillLibrary } from './useSkillLibrary'

type Modal = { kind: 'form'; editing?: SkillLibraryInfo } | null
const NEW_TILE = 'new-skill'

/** App settings: the skill library. A skill is defined here once and any project can link it. */
export default function SkillLibrarySection(): ReactElement {
  const lib = useSkillLibrary()
  const [modal, setModal] = useState<Modal>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  // Bumped when the edit form closes, so the detail panel re-reads the instructions (a body-only edit changes no
  // listed field, and the preview is where people check untrusted instructions).
  const [previewTick, setPreviewTick] = useState(0)
  const { confirm, dialog } = useConfirm()

  const addFolder = async (): Promise<void> => {
    setActionError(null)
    setAdding(true)
    try {
      await lib.addFromFolder()
    } catch (e) {
      setActionError(cleanIpcError(e))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (info: SkillLibraryInfo): Promise<void> => {
    const lines = libraryRemoveLines(info.usedBy)
    const ok = await confirm({
      title: `Remove ${info.entry.name} from the library?`,
      body:
        lines.length > 0 ? (
          <div className="stack-2" data-testid="skill-library-remove-body">
            <p>These projects lose the skill, and the roles named lose their access to it:</p>
            <ul className="skill-remove-list">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p>Its files are deleted from the library.</p>
          </div>
        ) : (
          <p>No project uses this skill. Its files are deleted from the library.</p>
        ),
      confirmLabel: 'Remove from library',
      danger: true
    })
    if (!ok) return
    setActionError(null)
    try {
      await lib.remove(info.entry.id)
      setSelected(null)
      setStatus(`Removed ${info.entry.name} from the library.`)
      // The removed skill's panel (and its Remove button) is gone: land on New skill, which is always there.
      window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid=skill-library-new]')?.focus(), 60)
    } catch (e) {
      setActionError(cleanIpcError(e))
    }
  }

  const list = lib.library
  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.skillLibrary}
      title="Your skills"
      description="Define a skill once; any project can link it."
      testId="skill-library"
      actions={
        <>
          <Button icon={Plus} testId="skill-library-new" onClick={() => setModal({ kind: 'form' })}>
            New skill
          </Button>
          <Button icon={FolderPlus} testId="skill-library-add-folder" disabled={adding} onClick={() => void addFolder()}>
            Add from folder
          </Button>
          <Button variant="ghost" icon={Sparkles} testId="skill-library-helper" onClick={() => void useAppStore.getState().openAssistant('skills', { fresh: true })}>
            Ask the Skills helper
          </Button>
        </>
      }
    >
      <div className="mcp-body">
        <p className="sr-only" role="status" aria-live="polite" data-testid="skill-library-status">
          {status}
        </p>
        {actionError && (
          <Banner tone="danger" title="That did not work">
            {actionError}
          </Banner>
        )}
        {lib.error && list === null ? (
          <Banner
            tone="danger"
            title="Could not load the skill library"
            actions={
              <Button size="sm" onClick={lib.refresh}>
                Retry
              </Button>
            }
          >
            {lib.error}
          </Banner>
        ) : list === null ? (
          <div className="card-block mcp-list" aria-busy="true" aria-label="Loading the skill library">
            {[0, 1].map((i) => (
              <div key={i} className="card-sec">
                <div className="skeleton mcp-sk" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="card-block mcp-empty">
            <Icon icon={BookOpen} size="lg" />
            <strong>No skills yet</strong>
            <p className="muted">Write a skill here, or add a folder that holds a SKILL.md.</p>
          </div>
        ) : (
          <SettingsGallery
            label="Library skills"
            testId="skill-gallery"
            searchLabel="Search skills"
            searchPlaceholder={`Search ${list.length} ${list.length === 1 ? 'skill' : 'skills'}`}
            filters={[
              { id: 'used', label: 'In use' },
              { id: 'unused', label: 'Not used yet' }
            ]}
            selected={selected}
            onSelect={setSelected}
            sections={[
              { id: 'skills', label: 'Your skills', note: `${list.length} ${list.length === 1 ? 'skill' : 'skills'}` },
              { id: 'new', label: 'Add more' }
            ]}
            items={[
              ...list.map((info): GalleryItem => {
                const used = usedByList(info.usedBy)
                const hint = skillElevatedHint(skillScriptPaths(info.entry.files))
                return {
                  id: info.entry.id,
                  name: info.entry.name,
                  section: 'skills',
                  filter: used.length > 0 ? 'used' : 'unused',
                  tag: `${sourceLabel(info.entry.source)} · ${info.entry.files.length} file${info.entry.files.length === 1 ? '' : 's'}`,
                  summary: info.entry.description ? <span className="mcp-clamp">{info.entry.description}</span> : undefined,
                  searchText: `${info.entry.description} ${sourceLabel(info.entry.source)}`,
                  status: hint
                    ? { text: hint, tone: 'warn' }
                    : used.length > 0
                      ? { text: `Used in ${used.length} ${used.length === 1 ? 'project' : 'projects'}`, tone: 'ok' }
                      : { text: 'Not used yet', tone: 'off' },
                  testId: 'skill-library-row',
                  data: { name: info.entry.name, id: info.entry.id }
                }
              }),
              { id: NEW_TILE, name: 'Write a skill', section: 'new', dashed: true, mark: '+', summary: 'Write one here, add a folder that holds a SKILL.md, or ask the Skills helper.', testId: 'skill-library-new-tile' }
            ]}
            renderDetail={(item) => {
              if (item.id === NEW_TILE) {
                return (
                  <>
                    <DetailHeader mark="+" name="Write a skill" tag="A SKILL.md: a name, when to use it, and the instructions" />
                    <DetailList
                      title="You will need"
                      mark="plain"
                      items={[{ text: 'A short name and one sentence on when to use it' }, { text: 'The instructions, in Markdown' }]}
                    />
                    <DetailActions>
                      <Button variant="primary" size="sm" icon={Plus} onClick={() => setModal({ kind: 'form' })}>
                        New skill
                      </Button>
                      <Button size="sm" icon={FolderPlus} disabled={adding} onClick={() => void addFolder()}>
                        Add from folder
                      </Button>
                    </DetailActions>
                  </>
                )
              }
              const info = list.find((i) => i.entry.id === item.id)
              return info ? (
                <SkillDetail key={info.entry.id} info={info} lib={lib} tick={previewTick} onEdit={() => setModal({ kind: 'form', editing: info })} onRemove={() => void remove(info)} />
              ) : null
            }}
          />
        )}
      </div>
      {modal?.kind === 'form' && (
        <LibraryForm
          key={modal.editing?.entry.id ?? 'new'}
          editing={modal.editing}
          lib={lib}
          takenNames={(list ?? []).filter((i) => i.entry.id !== modal.editing?.entry.id).map((i) => i.entry.name)}
          onClose={() => {
            setModal(null)
            setPreviewTick((t) => t + 1)
          }}
        />
      )}
      {dialog}
    </SettingsSection>
  )
}

/** Most characters of a skill's instructions shown in the detail panel's preview (plain text, never rendered). */
const PREVIEW_CHARS = 1200

/**
 * The Skills board's detail panel: what the skill is for, where it came from, a plain-text preview of its instructions
 * (read from the library on demand), which projects and roles use it, and Edit / Remove.
 */
function SkillDetail({
  info,
  lib,
  tick,
  onEdit,
  onRemove
}: {
  info: SkillLibraryInfo
  lib: ReturnType<typeof useSkillLibrary>
  tick: number
  onEdit: () => void
  onRemove: () => void
}): ReactElement {
  const { entry } = info
  const hint = skillElevatedHint(skillScriptPaths(entry.files))
  const used = usedByList(info.usedBy)
  const [body, setBody] = useState<string | null>(null)
  const [bodyError, setBodyError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setBody(null)
    setBodyError(null)
    lib
      .read(entry.id)
      .then((c) => live && setBody(c.body))
      .catch((e) => live && setBodyError(cleanIpcError(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.description, entry.files.length, tick])
  // Bidi overrides and isolates would let untrusted text reorder what the preview shows: shown as a visible mark instead.
  const visible = body === null ? null : body.replace(/[‪-‮⁦-⁩‎‏]/g, '�')
  const cut = visible !== null && visible.length > PREVIEW_CHARS
  const preview = visible === null ? null : cut ? visible.slice(0, PREVIEW_CHARS).trimEnd() : visible
  return (
    <div className="skill-detail" data-testid="skill-library-detail" data-id={entry.id}>
      <DetailHeader mark={entry.name.slice(0, 1).toUpperCase()} name={entry.name} tag={`${sourceLabel(entry.source)} · ${entry.files.length} file${entry.files.length === 1 ? '' : 's'}`} />
      {hint ? (
        <DetailNote tone="warn">{hint}. Look at its files before you give it to a role that can run commands.</DetailNote>
      ) : (
        entry.description && <DetailNote tone={used.length > 0 ? 'ok' : 'off'}>{entry.description}</DetailNote>
      )}
      <DetailBlock title="Instructions" testId="skill-library-preview">
        {bodyError ? (
          <p className="invalid-text">{bodyError}</p>
        ) : preview === null ? (
          <div className="skeleton w-70" aria-label="Loading the instructions" />
        ) : (
          // Scrolls when long, so it takes focus (keyboard scrolling) and is named.
          <pre className="skill-detail-body" tabIndex={0} role="region" aria-label={`Instructions of ${entry.name}`}>
            {preview || 'No instructions yet.'}
          </pre>
        )}
        {cut && body !== null && (
          <p className="settings-detail-hint muted" data-testid="skill-library-preview-cut">
            First {PREVIEW_CHARS.toLocaleString('en-US')} of {body.length.toLocaleString('en-US')} characters. Edit to read all of it.
          </p>
        )}
      </DetailBlock>
      <div className="settings-detail-block skill-used-by" data-testid="skill-library-used-by">
        <div className="settings-detail-label">Projects and roles that use it</div>
        {used.length === 0 ? (
          <span className="muted">Not used by any project</span>
        ) : (
          <ul>
            {used.map((p) => (
              <li key={p.projectId}>
                <span>{p.projectName}</span>
                {p.roles.length > 0 && <span className="muted"> · {p.roles.join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <DetailActions>
        <Button size="sm" icon={Pencil} ariaLabel={`Edit ${entry.name}`} onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="danger" icon={Trash2} ariaLabel={`Remove ${entry.name} from the library`} testId="skill-library-remove" onClick={onRemove}>
          Remove
        </Button>
      </DetailActions>
      <Button variant="ghost" size="sm" icon={Sparkles} className="settings-detail-help" onClick={() => void useAppStore.getState().openAssistant('skills', { fresh: true })}>
        Ask the Skills helper to improve it
      </Button>
    </div>
  )
}

function LibraryForm({
  editing,
  lib,
  takenNames,
  onClose
}: {
  editing?: SkillLibraryInfo
  lib: ReturnType<typeof useSkillLibrary>
  takenNames: string[]
  onClose: () => void
}): ReactElement {
  const [draft, setDraft] = useState<SkillDraft>({
    name: editing?.entry.name ?? '',
    description: editing?.entry.description ?? '',
    body: ''
  })
  const [loading, setLoading] = useState(!!editing)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const loadedBody = useRef('')
  const { confirm, dialog } = useConfirm()

  useEffect(() => {
    if (!editing) return undefined
    let live = true
    lib
      .read(editing.entry.id)
      .then((c) => {
        if (!live) return
        loadedBody.current = c.body
        setDraft((d) => ({ ...d, body: c.body }))
      })
      .catch((e) => live && setError(cleanIpcError(e)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.entry.id])

  const problems = draftProblems(draft)
  const duplicate = takenNames.some((n) => n.toLowerCase() === draft.name.trim().toLowerCase()) ? 'A library skill with this name already exists.' : null
  const nameProblem = problems.name ?? duplicate
  const invalid = hasDraftProblems(problems) || !!duplicate
  const show = touched
  const set = (p: Partial<SkillDraft>): void => setDraft((d) => ({ ...d, ...p }))

  const save = async (): Promise<void> => {
    setTouched(true)
    if (invalid || saving) return
    setSaving(true)
    setError(null)
    try {
      if (editing) await lib.update(editing.entry.id, draft)
      else await lib.create(draft)
      onClose()
    } catch (e) {
      setError(cleanIpcError(e))
    } finally {
      setSaving(false)
    }
  }

  const dirty = editing
    ? draft.name !== editing.entry.name || draft.description !== editing.entry.description || (!loading && draft.body !== loadedBody.current)
    : draft.name !== '' || draft.description !== '' || draft.body !== ''
  // Esc, the backdrop, the close button and Cancel all ask before they throw away typed work.
  const requestClose = async (): Promise<void> => {
    if (saving) return
    if (dirty) {
      const ok = await confirm({
        title: 'Discard your changes?',
        body: 'What you typed in this form is not saved.',
        confirmLabel: 'Discard',
        danger: true
      })
      if (!ok) return
    }
    onClose()
  }

  return (
    <>
      <Dialog
        open
        onClose={() => void requestClose()}
        size="lg"
        title={editing ? `Edit ${editing.entry.name}` : 'New skill'}
        description="A skill is a SKILL.md: a name, when to use it, and the instructions."
        testId="skill-library-form"
        footer={
          <>
            <Button onClick={() => void requestClose()}>Cancel</Button>
            <Button variant="primary" disabled={saving || loading} onClick={() => void save()}>
              {editing ? 'Save skill' : 'Create skill'}
            </Button>
          </>
        }
      >
        <div className="stack-3 skill-lib-form">
          {error && (
            <Banner tone="danger" title="Could not save the skill">
              {error}
            </Banner>
          )}
          <div className="field">
            <label htmlFor={`${id}-name`}>Name</label>
            <Input
              id={`${id}-name`}
              data-autofocus
              mono
              value={draft.name}
              invalid={show && !!nameProblem}
              aria-describedby={show && nameProblem ? `${id}-name-err` : undefined}
              onChange={(v) => set({ name: v })}
            />
            {show && nameProblem && (
              <span id={`${id}-name-err`} className="invalid-text">
                {nameProblem}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${id}-desc`}>Description</label>
            <Textarea
              id={`${id}-desc`}
              rows={2}
              value={draft.description}
              invalid={show && !!problems.description}
              aria-describedby={show && problems.description ? `${id}-desc-err` : undefined}
              onChange={(v) => set({ description: v })}
              placeholder="When should an agent use this skill?"
            />
            {show && problems.description && (
              <span id={`${id}-desc-err`} className="invalid-text">
                {problems.description}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor={`${id}-body`}>Instructions</label>
            <Textarea
              id={`${id}-body`}
              mono
              rows={10}
              value={draft.body}
              disabled={loading}
              invalid={show && !!problems.body}
              aria-describedby={show && problems.body ? `${id}-body-err` : `${id}-body-hint`}
              onChange={(v) => set({ body: v })}
            />
            {show && problems.body ? (
              <span id={`${id}-body-err`} className="invalid-text">
                {problems.body}
              </span>
            ) : (
              <span id={`${id}-body-hint`} className="hint">
                Markdown, at most {SKILL_BODY_MAX_CHARS.toLocaleString('en-US')} characters ({draft.body.length.toLocaleString('en-US')} used).
                {editing && editing.entry.files.length > 1 ? ' The skill’s other files are kept as they are.' : ''}
              </span>
            )}
          </div>
        </div>
      </Dialog>
      {dialog}
    </>
  )
}
