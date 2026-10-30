import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileSearch } from 'lucide-react'
import type { Project, SkillImportApplyResult, SkillImportItem, SkillImportPreview } from '@shared/types'
import { SKILL_REPO_ROOTS } from '@shared/types'
import { buildSkillChoices, skillElevatedHint, skillImportButtonLabel, type SkillImportEdit } from '../../lib/skills'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { useConfirm } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const ACTION_LABEL: Record<SkillImportItem['action'], string> = {
  add: 'New',
  update: 'Update',
  unchanged: 'Unchanged',
  skip: 'Skipped'
}

const isActive = (i: SkillImportItem): boolean => i.action === 'add' || i.action === 'update'

function SkillRow({
  item,
  roles,
  edit,
  onEdit
}: {
  item: SkillImportItem
  roles: Project['roles']
  edit: SkillImportEdit | undefined
  onEdit: (patch: SkillImportEdit) => void
}): ReactElement {
  const uid = useId()
  const [bodyOpen, setBodyOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  const included = isActive(item)
  const locked = item.nameConflict === true || item.action === 'unchanged'
  const elevated = skillElevatedHint(item.scripts)
  const roleIds = edit?.roleIds ?? []
  return (
    <li className={`skill-import-row${included ? '' : ' is-skipped'}`} data-testid="skill-import-item" data-key={item.key}>
      <div className="import-row-head">
        <Checkbox checked={included} disabled={locked} onChange={(include) => onEdit({ include })} label={<strong>{item.name}</strong>} testId="skill-import-include" />
        <span className={`chip${item.action === 'update' ? ' warn' : ''}`}>{ACTION_LABEL[item.action]}</span>
        <span className="chip mono">{item.root}</span>
        {item.nameConflict && <span className="chip warn">Name already used</span>}
        {item.duplicateOf && <span className="chip">Same name as {item.duplicateOf}</span>}
        {elevated && <span className="chip warn">{elevated}</span>}
      </div>
      {item.description && <p className="import-desc muted">{item.description}</p>}
      {item.nameConflict && <p className="hint">Another skill in this project already has this name, so it cannot be added.</p>}
      {item.duplicateOf && <p className="hint">{item.duplicateOf} has the same name and wins. Include this one to use it instead.</p>}
      {item.notes.length > 0 && (
        <ul className="skill-import-notes hint">
          {item.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {elevated && (
        <p className="skill-import-scripts">
          <span className="muted">Scripts: </span>
          {item.scripts.map((s) => (
            <span key={s} className="chip mono">
              {s}
            </span>
          ))}
        </p>
      )}
      <div className="skill-import-toggles">
        <Button variant="ghost" size="sm" icon={filesOpen ? ChevronDown : ChevronRight} onClick={() => setFilesOpen((v) => !v)}>
          {item.files.length} file{item.files.length === 1 ? '' : 's'} · {formatBytes(item.totalBytes)}
        </Button>
        <Button variant="ghost" size="sm" icon={bodyOpen ? ChevronDown : ChevronRight} onClick={() => setBodyOpen((v) => !v)}>
          {bodyOpen ? 'Hide instructions' : 'Read instructions'}
        </Button>
      </div>
      {filesOpen && (
        <ul className="skill-import-files mono" aria-label={`Files of ${item.name}`}>
          {item.files.map((f) => (
            <li key={f.path}>
              <span>{f.path}</span>
              <span className="muted">{formatBytes(f.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {bodyOpen && (
        <div id={`${uid}-body`} className="import-prompt">
          <pre tabIndex={0} role="region" aria-label={`Instructions of ${item.name}`}>
            {item.body}
          </pre>
        </div>
      )}
      {item.action === 'add' && roles.length > 0 && (
        <fieldset className="skill-import-roles">
          <legend>Give to roles</legend>
          <div className="skill-import-role-list">
            {roles.map((r) => (
              <Checkbox
                key={r.id}
                checked={roleIds.includes(r.id)}
                onChange={(on) => onEdit({ roleIds: on ? [...roleIds, r.id] : roleIds.filter((x) => x !== r.id) })}
                label={r.name}
              />
            ))}
          </div>
        </fieldset>
      )}
      {item.action === 'update' && <p className="hint">Existing role grants are kept.</p>}
      <span className="muted mono import-file">{item.repoPath}</span>
    </li>
  )
}

/** Review before anything is written. Mount it only while open: its state is the review. */
export default function ImportSkillsDialog({
  project,
  onApplied,
  onClose
}: {
  project: Project
  onApplied: (result: SkillImportApplyResult) => void
  onClose: () => void
}): ReactElement {
  const [edits, setEdits] = useState<Record<string, SkillImportEdit>>({})
  const [preview, setPreview] = useState<SkillImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyErrorRef = useRef<HTMLSpanElement>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const { confirm, dialog } = useConfirm()
  const choices = useMemo(() => buildSkillChoices(edits), [edits])

  useEffect(() => {
    if (applyError) applyErrorRef.current?.focus()
  }, [applyError])

  // Every choice change asks main again, so the list shown is what main would save.
  useEffect(() => {
    let live = true
    setLoading(true)
    window.orgai.skills
      .previewImport({ projectId: project.id, choices })
      .then((p) => {
        if (!live) return
        setPreview(p)
        setError(null)
      })
      .catch((e) => {
        if (!live) return
        setPreview(null)
        setError(cleanIpcError(e))
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [project.id, choices, refresh])

  const edit = (key: string, patch: SkillImportEdit): void => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }))
  const active = (preview?.items ?? []).filter(isActive)
  const count = active.length
  const updates = active.filter((i) => i.action === 'update')

  const apply = async (): Promise<void> => {
    if (!preview || count === 0 || applying) return
    if (updates.length > 0) {
      const ok = await confirm({
        title: `Update ${updates.length} skill${updates.length === 1 ? '' : 's'}?`,
        body: `${updates.map((i) => i.name).join(', ')} will be replaced by the repository version. Role grants are kept. You can undo this right after the import.`,
        confirmLabel: `Update ${updates.length} skill${updates.length === 1 ? '' : 's'}`,
        danger: true
      })
      if (!ok) return
    }
    setApplying(true)
    setApplyError(null)
    try {
      const result = await window.orgai.skills.applyImport({ projectId: project.id, choices, digest: preview.digest })
      onApplied(result)
      onClose()
    } catch (e) {
      setApplyError(cleanIpcError(e))
    } finally {
      setApplying(false)
    }
  }

  const items = preview?.items ?? []
  const invalid = preview?.invalid ?? []
  const nothing = preview !== null && items.length === 0 && invalid.length === 0
  const footer = (
    <>
      {applyError ? (
        <span className="import-foot-error" role="alert" tabIndex={-1} ref={applyErrorRef} data-testid="skill-import-apply-error">
          <strong>Nothing was imported.</strong> {applyError}
          <Button
            size="sm"
            onClick={() => {
              setApplyError(null)
              setRefresh((n) => n + 1)
            }}
          >
            Refresh preview
          </Button>
        </span>
      ) : (
        <span className="import-foot-note muted">Nothing is written until you import. Your files are not changed.</span>
      )}
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => void apply()} disabled={!preview || count === 0 || loading} loading={applying} testId="skill-import-apply">
        {skillImportButtonLabel(count)}
      </Button>
    </>
  )

  return (
    <>
      <Dialog open onClose={onClose} title="Import skills" description="Review the skills found in this folder before they join the project." size="lg" footer={footer} testId="skill-import-dialog">
        <div className="import-body">
          {error && (
            <Banner tone="danger" title="Could not build the preview">
              {error}
            </Banner>
          )}
          {!preview && !error && (
            <p className="muted" role="status">
              Looking for skills…
            </p>
          )}
          {nothing && (
            <EmptyState
              compact
              icon={FileSearch}
              title="No skills found"
              description={`Searched ${SKILL_REPO_ROOTS.join(', ')} in ${project.path}.`}
              testId="skill-import-empty"
            />
          )}
          {preview && preview.warnings.length > 0 && (
            <Banner tone="warning" title={`${preview.warnings.length} thing${preview.warnings.length === 1 ? '' : 's'} to check`} testId="skill-import-warnings">
              <ul className="import-warn-list">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}
          {items.length > 0 && (
            <ul className="import-roles" aria-busy={loading} aria-label="Skills found">
              {items.map((item) => (
                <SkillRow key={item.key} item={item} roles={project.roles} edit={edits[item.key]} onEdit={(patch) => edit(item.key, patch)} />
              ))}
            </ul>
          )}
          {invalid.length > 0 && (
            <section className="skill-import-invalid" data-testid="skill-import-invalid" aria-label="Skills that cannot be imported">
              <h3 className="skill-import-invalid-title">Cannot be imported</h3>
              <ul>
                {invalid.map((i) => (
                  <li key={i.repoPath}>
                    <span className="mono">{i.repoPath}</span>
                    <span className="muted">{i.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Dialog>
      {dialog}
    </>
  )
}
