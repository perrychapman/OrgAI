import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import { BookOpen, FolderPlus, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import type { SkillDraft, SkillLibraryInfo } from '@shared/types'
import { SKILL_BODY_MAX_CHARS } from '@shared/types'
import { draftProblems, hasDraftProblems, skillElevatedHint, skillScriptPaths, sourceLabel, usedByLine } from '../../lib/skills'
import { cleanIpcError } from '../../lib/ipcError'
import { Badge } from '../ui/Badge'
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

/** App settings: the skill library. A skill is defined here once and any project can link it. */
export default function SkillLibrarySection(): ReactElement {
  const lib = useSkillLibrary()
  const [modal, setModal] = useState<Modal>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
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
    const projects = [...new Set(info.usedBy.map((u) => u.projectName))]
    const ok = await confirm({
      title: `Remove ${info.entry.name} from the library?`,
      body: (
        <p>
          {projects.length > 0
            ? `${projects.join(', ')} will lose this skill and any role access to it.`
            : 'No project uses this skill.'}{' '}
          Its files are deleted from the library.
        </p>
      ),
      confirmLabel: 'Remove from library',
      danger: true
    })
    if (!ok) return
    setActionError(null)
    try {
      await lib.remove(info.entry.id)
    } catch (e) {
      setActionError(cleanIpcError(e))
    }
  }

  const list = lib.library
  return (
    <SettingsSection
      id={APP_SETTINGS_SECTIONS.skillLibrary}
      title="Skill library"
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
        </>
      }
    >
      <div className="mcp-body">
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
          <ul className="card-block mcp-list" aria-label="Library skills">
            {list.map((info) => (
              <LibraryRow key={info.entry.id} info={info} onEdit={() => setModal({ kind: 'form', editing: info })} onRemove={() => void remove(info)} />
            ))}
          </ul>
        )}
      </div>
      {modal?.kind === 'form' && (
        <LibraryForm
          key={modal.editing?.entry.id ?? 'new'}
          editing={modal.editing}
          lib={lib}
          takenNames={(list ?? []).filter((i) => i.entry.id !== modal.editing?.entry.id).map((i) => i.entry.name)}
          onClose={() => setModal(null)}
        />
      )}
      {dialog}
    </SettingsSection>
  )
}

function LibraryRow({ info, onEdit, onRemove }: { info: SkillLibraryInfo; onEdit: () => void; onRemove: () => void }): ReactElement {
  const { entry } = info
  const hint = skillElevatedHint(skillScriptPaths(entry.files))
  return (
    <li className="mcp-row skill-lib-row" data-testid="skill-library-row" data-name={entry.name} data-id={entry.id}>
      <div className="skill-lib-main">
        <div className="mcp-row-id">
          <span className="mcp-name">{entry.name}</span>
          {entry.description && <span className="muted mcp-clamp">{entry.description}</span>}
        </div>
        <div className="skill-lib-meta">
          <Badge>{sourceLabel(entry.source)}</Badge>
          <Badge>
            {entry.files.length} file{entry.files.length === 1 ? '' : 's'}
          </Badge>
          {hint && (
            <Badge tone="attention" icon={TriangleAlert}>
              {hint}
            </Badge>
          )}
          <span className="muted" data-testid="skill-library-used-by">
            {usedByLine(info.usedBy)}
          </span>
        </div>
        <div className="skill-lib-actions">
          <Button size="sm" icon={Pencil} ariaLabel={`Edit ${entry.name}`} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" variant="danger" icon={Trash2} ariaLabel={`Remove ${entry.name} from the library`} testId="skill-library-remove" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
    </li>
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
  const [draft, setDraft] = useState<SkillDraft>({ name: editing?.entry.name ?? '', description: editing?.entry.description ?? '', body: '' })
  const [loading, setLoading] = useState(!!editing)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  useEffect(() => {
    if (!editing) return undefined
    let live = true
    lib
      .read(editing.entry.id)
      .then((c) => live && setDraft((d) => ({ ...d, body: c.body })))
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

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${editing.entry.name}` : 'New skill'}
      description="A skill is a SKILL.md: a name, when to use it, and the instructions."
      testId="skill-library-form"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
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
  )
}
