import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project, SkillInfo } from '@shared/types'
import { SKILL_BODY_MAX_CHARS, SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from '@shared/types'
import { cleanIpcError } from '../../lib/ipcError'
import { draftProblems, hasDraftProblems } from '../../lib/skills'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { SkillRoleChecklist } from './SkillRoleAccess'
import type { ProjectSkills } from './useSkills'

type Field = 'name' | 'description' | 'body'

/** Create or edit a skill written in OrgAI (or imported from the repo). Linked skills are edited in the library, never here. */
export default function SkillForm({
  project,
  skillsApi,
  editing,
  onClose
}: {
  project: Project
  skillsApi: ProjectSkills
  editing?: SkillInfo
  onClose: () => void
}): ReactElement {
  const base = useId()
  const [name, setName] = useState(editing?.spec.name ?? '')
  const [description, setDescription] = useState(editing?.spec.description ?? '')
  const [body, setBody] = useState('')
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [loading, setLoading] = useState(!!editing)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [touched, setTouched] = useState({ name: false, description: false, body: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!editing) return undefined
    let live = true
    window.orgai.skills
      .read({ projectId: project.id, skillId: editing.spec.id })
      .then((c) => {
        if (!live) return
        setBody(c.body)
        setLoading(false)
      })
      .catch((e) => {
        if (!live) return
        setLoadError(cleanIpcError(e))
        setLoading(false)
      })
    return () => {
      live = false
    }
  }, [editing, project.id])

  const problems = draftProblems({ name, description, body })
  const blocked = hasDraftProblems(problems) || loading || !!loadError
  const show = (k: Field): string | null => (touched[k] ? problems[k] : null)
  const touch = (k: Field): void => setTouched((t) => ({ ...t, [k]: true }))

  const save = async (): Promise<void> => {
    setTouched({ name: true, description: true, body: true })
    if (blocked) return
    setBusy(true)
    setError(null)
    try {
      const draft = { name, description, body }
      if (editing) await skillsApi.update({ skillId: editing.spec.id, draft })
      else await skillsApi.create(draft, roleIds.length ? roleIds : undefined)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={editing ? `Edit ${editing.spec.name}` : 'New skill'}
      description="A skill is instructions an agent loads when its description matches the task."
      size="lg"
      testId="skill-form"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={loading || !!loadError} testId="skill-save" onClick={() => void save()}>
            {editing ? 'Save skill' : 'Create skill'}
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" title="Could not save the skill">
          {error}
        </Banner>
      )}
      {loadError && (
        <Banner tone="danger" title="Could not read the skill">
          {loadError}
        </Banner>
      )}
      <div className="field mcp-field">
        <label htmlFor={`${base}-name`}>Name</label>
        <Input
          id={`${base}-name`}
          mono
          data-testid="skill-name"
          data-autofocus=""
          value={name}
          invalid={!!show('name')}
          aria-describedby={`${base}-name-msg`}
          autoComplete="off"
          spellCheck={false}
          maxLength={SKILL_NAME_MAX + 20}
          onChange={setName}
          onBlur={() => touch('name')}
        />
        <span id={`${base}-name-msg`} className={show('name') ? 'field-error' : 'hint'}>
          {show('name') ?? 'Lowercase letters, numbers and hyphens, like api-design.'}
        </span>
      </div>
      <div className="field mcp-field">
        <label htmlFor={`${base}-desc`}>Description</label>
        <Textarea
          id={`${base}-desc`}
          data-testid="skill-description"
          rows={2}
          value={description}
          invalid={!!show('description')}
          aria-describedby={`${base}-desc-msg`}
          onChange={setDescription}
          onBlur={() => touch('description')}
        />
        <span id={`${base}-desc-msg`} className={show('description') ? 'field-error' : 'hint'}>
          {show('description') ?? `When to use it, in one or two sentences (${description.length} of ${SKILL_DESCRIPTION_MAX}).`}
        </span>
      </div>
      <div className="field mcp-field">
        <label htmlFor={`${base}-body`}>Instructions</label>
        <Textarea
          id={`${base}-body`}
          data-testid="skill-body"
          mono
          rows={10}
          value={body}
          disabled={loading}
          invalid={!!show('body')}
          aria-describedby={`${base}-body-msg`}
          spellCheck={false}
          onChange={setBody}
          onBlur={() => touch('body')}
        />
        <span id={`${base}-body-msg`} className={show('body') ? 'field-error' : 'hint'}>
          {show('body') ?? (loading ? 'Reading the skill' : `Shown to the agent as written (${body.length.toLocaleString('en-US')} of ${SKILL_BODY_MAX_CHARS.toLocaleString('en-US')}).`)}
        </span>
      </div>
      {!editing && (
        <fieldset className="mcp-vars">
          <legend>Who can load it? (optional)</legend>
          <SkillRoleChecklist roles={project.roles} value={roleIds} onChange={setRoleIds} label="Role access" />
        </fieldset>
      )}
    </Dialog>
  )
}
