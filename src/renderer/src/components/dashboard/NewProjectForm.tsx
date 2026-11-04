import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, Lock, Plus, X } from 'lucide-react'
import type { Project, ProjectKind, ProjectPathCheck, SetupKind } from '@shared/types'
import { PROJECT_CLIENT_MAX_CHARS } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { examplePath } from '../../lib/platform'
import { effectiveSetupChoice, foundLine, importChoiceLabel, setupSubmitLabel, totalAgents, type SetupChoice } from '../../lib/agentImport'
import { REFERENCE_FOLDERS_HINT } from '../settings/AllowedDirectoriesSection'
import { firstWorkingFolderConflict } from '../../lib/folderLists'
import { addReferenceFolder,effectiveName, newProjectConnectionView, pathStatus, readLastProjectKind, submitBlocker, writeLastProjectKind } from '../../lib/projectsForm'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { IconButton } from '../ui/IconButton'
import { Input } from '../ui/Input'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Icon } from '../ui/Icon'
import { Textarea } from '../ui/Textarea'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'

const KINDS: { value: SetupKind; label: string }[] = [
  { value: 'new', label: 'New idea' },
  { value: 'existing', label: 'Existing code' }
]

const PROJECT_KIND_CARDS: { value: ProjectKind; title: string; text: string }[] = [
  {
    value: 'code',
    title: 'Code project',
    text: 'Software in a repository. Agents read and change the code, run tests and work in separate copies when several write at once.'
  },
  {
    value: 'engagement',
    title: 'Engagement',
    text: 'Work for a client or a case: research, analysis and documents. Agents read the material you point them to and write deliverables in one working folder.'
  }
]

/**
 * The New project form's typed values, kept while its "Change" / "Connect" link visits App settings > Connections
 * (the view unmounts the form). Read once by the next form mount, then cleared. Session memory only.
 */
interface NewProjectDraft {
  projectKind: ProjectKind | null
  client: string
  refs: string[]
  kind: SetupKind
  name: string
  path: string
  brief: string
  architect: boolean
  picked: SetupChoice | null
  useMock: boolean
}
let parkedDraft: NewProjectDraft | null = null

/** True when a form parked by its connection link should come back open. */
export function hasParkedDraft(): boolean {
  return parkedDraft !== null
}

/**
 * 'card' (default): its own card with an h2 and a ghost Cancel in the header. 'dialog': inside a Dialog, so no h2 and no
 * second card border. 'inline': in a page panel (first launch), no h2. In 'dialog' and 'inline' Cancel (when given) is a
 * secondary Button in the submit row, so the submit stays the only primary.
 */
export type NewProjectFormVariant = 'card' | 'dialog' | 'inline'

export function NewProjectForm({
  mockAvailable,
  onCancel,
  variant = 'card',
  autoFocus = true
}: {
  mockAvailable: boolean
  onCancel?: () => void
  variant?: NewProjectFormVariant
  /** Put the cursor in the project kind choice on mount (default). Off where the form sits beside other controls. */
  autoFocus?: boolean
}): ReactElement {
  const createProject = useAppStore((s) => s.createProject)
  const connections = useAppStore((s) => s.connections)
  useEffect(() => {
    void useAppStore.getState().loadDefaultConnection()
    if (!useAppStore.getState().connections) void useAppStore.getState().loadConnections()
  }, [])
  const startSetup = useAppStore((s) => s.startSetup)
  const uid = useId()
  const ids = { client: `${uid}-client`, ref: `${uid}-ref`, refErr: `${uid}-ref-err`, extrasErr: `${uid}-extras-err`, name: `${uid}-name`, brief: `${uid}-brief`, path: `${uid}-path`, pathMsg: `${uid}-path-msg`, foundMsg: `${uid}-found-msg`, dupMsg: `${uid}-dup-msg`, pathErr: `${uid}-path-err`, why: `${uid}-why` }

  const [draft] = useState(() => {
    const d = parkedDraft
    parkedDraft = null
    return d
  })
  // None picked on first launch; afterwards the kind of the last project created here.
  const [projectKind, setProjectKind] = useState<ProjectKind | null>(draft ? draft.projectKind : readLastProjectKind())
  const [client, setClient] = useState(draft?.client ?? '')
  const [refs, setRefs] = useState<string[]>(draft?.refs ?? [])
  const [refInput, setRefInput] = useState('')
  const [refError, setRefError] = useState<string | null>(null)
  /** Set when the project was created but its client / reference folders did not save: the form waits for the user. */
  const [pending, setPending] = useState<{ project: Project; message: string } | null>(null)
  const engagement = projectKind === 'engagement'
  const [pickedKind, setKind] = useState<SetupKind>(draft?.kind ?? 'new')
  // An engagement always works on an existing folder (main profiles it either way).
  const kind: SetupKind = engagement ? 'existing' : pickedKind
  const [name, setName] = useState(draft?.name ?? '')
  const [path, setPath] = useState(draft?.path ?? '')
  const [brief, setBrief] = useState(draft?.brief ?? '')
  const [architect, setArchitect] = useState(draft?.architect ?? true)
  const [picked, setPicked] = useState<SetupChoice | null>(draft?.picked ?? null)
  const [useMock, setUseMock] = useState(draft?.useMock ?? true)
  const connectionView = newProjectConnectionView(connections, mockAvailable && useMock)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [check, setCheck] = useState<{ path: string; result: ProjectPathCheck } | null>(null)

  // The form opens with the cursor in the kind choice: the checked card, else the first.
  const kindRef = useRef<HTMLFieldSetElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    const radios = kindRef.current?.querySelectorAll<HTMLInputElement>('input[type=radio]')
    const target = Array.from(radios ?? []).find((r) => r.checked) ?? radios?.[0]
    target?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced live check of the folder; stale answers are dropped.
  useEffect(() => {
    const p = path.trim()
    if (!p) return undefined
    let live = true
    const t = setTimeout(() => {
      window.orgai.projects
        .checkPath(p)
        .then((result) => {
          if (live) setCheck({ path: p, result })
        })
        .catch(() => {})
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [path])

  const current = check && check.path === path.trim() ? check.result : null
  const status = pathStatus(kind, path, current, projectKind ?? 'code')
  const agentTotal = totalAgents(current)
  const hasAgents = agentTotal > 0
  // An engagement hides instruction-file talk (CLAUDE.md, AGENTS.md) unless saved team members were found.
  const found = engagement && !hasAgents ? null : foundLine(current)
  const choice = effectiveSetupChoice(hasAgents, picked, architect)
  const repoHint = !hasAgents || choice === 'architect'
    ? 'The Architect scans it and reads the code before proposing anything. Nothing is modified until you approve.'
    : choice === 'import'
      ? 'The agent files are read, not changed. You review the roles before they join the chart.'
      : 'Nothing in the folder is modified.'
  const blocker = projectKind ? submitBlocker({ kind, name, path, brief, status, projectKind }) : 'Choose what this project is for.'

  const setPathValue = (v: string): void => {
    setPath(v)
    setError(null)
  }
  const pick = async (): Promise<void> => {
    const dir = await window.orgai.projects.pickDirectory()
    if (dir) setPathValue(dir)
  }
  const addRef = (value: string): void => {
    const r = addReferenceFolder(refs, value, path, 'engagement')
    if ('error' in r) {
      setRefError(r.error)
      return
    }
    setRefs(r.list)
    setRefInput('')
    setRefError(null)
  }
  const pickRef = async (): Promise<void> => {
    const dir = await window.orgai.projects.pickDirectory()
    if (dir) addRef(dir)
  }
  const removeRef = (p: string): void => {
    setRefs((list) => list.filter((x) => x !== p))
    setRefError(null)
    // The removed row held focus: land on the add field.
    document.getElementById(ids.ref)?.focus()
  }

  /** Steps after the project exists: the agent import review or the setup interview, then focus on the new heading. */
  const finish = async (created: Project): Promise<void> => {
    // Import never writes blind: the project starts with the default chart and the review opens on the Team tab.
    if (choice === 'import') useAppStore.getState().requestImport({ projectId: created.id, fresh: true })
    if (choice === 'architect') await startSetup()
    // The form is gone: land focus on the new project's heading instead of letting it fall to the page.
    requestAnimationFrame(() => {
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  }
  const openPending = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    try {
      useAppStore.getState().selectProject(pending.project.id)
      useAppStore.getState().setView('team')
      await finish(pending.project)
    } catch (err) {
      setError(cleanIpcError(err))
    } finally {
      setBusy(false)
    }
  }

  const existingId = current?.existingProjectId
  const openExisting = (): void => {
    useAppStore.getState().selectProject(existingId ?? null)
    useAppStore.getState().setView('run')
  }

  const submit = async (e: React.FormEvent | null, duplicate = false): Promise<void> => {
    e?.preventDefault()
    if (pending) {
      void openPending()
      return
    }
    if (blocker || busy || !projectKind) return
    // A folder that is already a project opens it; a duplicate is a separate, deliberate choice.
    if (existingId && !duplicate) {
      openExisting()
      return
    }
    // The working folder may have changed since the folders were added: main would drop any that now overlap it.
    if (engagement) {
      const conflict = firstWorkingFolderConflict(refs, path, 'engagement')
      if (conflict) {
        setRefError(`${conflict.path}: ${conflict.problem}`)
        document.getElementById(ids.ref)?.focus()
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const trimmedClient = client.trim()
      const input = {
        name: effectiveName(name, path, current),
        path: path.trim(),
        brief: brief.trim(),
        setupKind: choice === 'architect' ? kind : undefined,
        kind: projectKind,
        ...(engagement && trimmedClient ? { client: trimmedClient } : {}),
        ...(engagement && refs.length > 0 ? { referenceDirectories: refs } : {}),
        ...(mockAvailable && useMock ? { mock: true } : {})
      }
      const extras: { failed: string | null } = { failed: null }
      const created = await createProject(input, { onExtrasError: (err) => void (extras.failed = cleanIpcError(err)) })
      writeLastProjectKind(projectKind)
      if (extras.failed) {
        // The project exists; wait for the user rather than leaving the form with the problem unseen.
        setPending({ project: created, message: extras.failed })
        return
      }
      await finish(created)
    } catch (err) {
      setError(cleanIpcError(err))
      document.getElementById(ids.path)?.focus()
    } finally {
      setBusy(false)
    }
  }

  const pathField = (label: string, placeholder: string, hint: string): ReactElement => (
    <div className="field">
      <label htmlFor={ids.path}>{label}</label>
      <div className="row">
        <div className="grow">
          <Input
            id={ids.path}
            mono
            value={path}
            onChange={setPathValue}
            placeholder={placeholder}
            invalid={!!error || status?.tone === 'error'}
            aria-describedby={[error ? ids.pathErr : '', status ? ids.pathMsg : '', found ? ids.foundMsg : '', current?.existingProjectId ? ids.dupMsg : ''].filter(Boolean).join(' ') || undefined}
          />
        </div>
        <Button icon={FolderOpen} onClick={() => void pick()}>
          Browse
        </Button>
      </div>
      {error && (
        <span id={ids.pathErr} className="field-msg error" role="alert">
          {error}
        </span>
      )}
      {status && (
        <span id={ids.pathMsg} className={`field-msg ${status.tone}`}>
          {status.text}
        </span>
      )}
      {found && (
        <span id={ids.foundMsg} className="field-msg info" data-testid="agents-found">
          {found}
        </span>
      )}
      {current?.existingProjectId && (
        <span id={ids.dupMsg} className="field-msg warn" data-testid="already-project">
          This folder is already a project: {current.existingProjectName}.
        </span>
      )}
      <span className="hint">{hint}</span>
    </div>
  )

  const nameField = (placeholder: string): ReactElement => (
    <div className="field">
      <label htmlFor={ids.name}>Name</label>
      <Input id={ids.name} value={name} onChange={setName} placeholder={placeholder} />
    </div>
  )

  return (
    <form
      className={`card project-form${variant === 'dialog' ? ' in-dialog' : variant === 'inline' ? ' in-panel' : ''}`}
      aria-label={variant === 'inline' ? 'New project' : undefined}
      onSubmit={submit}
    >
      {variant === 'card' && (
        <div className="row between">
          <h2 className="form-title">New project</h2>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
      <fieldset className="project-kind" data-testid="project-kind" ref={kindRef} disabled={!!pending}>
        <legend>What is this project for?</legend>
        <div className="project-kind-options">
          {PROJECT_KIND_CARDS.map((c) => (
            <label key={c.value} className="project-kind-option" data-kind={c.value} data-testid="project-kind-option">
              <input
                type="radio"
                name={`${uid}-project-kind`}
                value={c.value}
                checked={projectKind === c.value}
                onChange={() => {
                  setProjectKind(c.value)
                  setError(null)
                }}
                aria-labelledby={`${uid}-kind-${c.value}-t`}
                aria-describedby={`${uid}-kind-${c.value}-d`}
              />
              <span id={`${uid}-kind-${c.value}-t`} className="project-kind-title">
                {c.title}
              </span>
              <span id={`${uid}-kind-${c.value}-d`} className="project-kind-text">
                {c.text}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {projectKind === 'code' && (
        <SegmentedControl
          label="Project type"
          value={kind}
          options={KINDS}
          onChange={(k) => {
            setKind(k)
            setError(null)
          }}
        />
      )}

      {engagement ? (
        <>
          {nameField('Client or case name')}
          <div className="field">
            <label htmlFor={ids.client}>Client or case (optional)</label>
            <Input id={ids.client} value={client} onChange={setClient} maxLength={PROJECT_CLIENT_MAX_CHARS} data-testid="new-project-client" />
          </div>
          {pathField('Working folder', examplePath('engagement'), 'Where the team saves deliverables. Your files stay where they are.')}
          <div className="field ref-folders">
            <label htmlFor={ids.ref}>Folders the team may read (optional)</label>
            <ul className="ref-folder-list" aria-label="Folders the team may read">
              {refs.map((p) => (
                <li key={p} className="ref-folder-row" data-testid="new-project-ref-row">
                  <Icon icon={Lock} size="sm" />
                  <span className="ref-folder-path" title={p}>
                    {p}
                  </span>
                  <IconButton icon={X} size="sm" label={`Remove ${p}`} onClick={() => removeRef(p)} />
                </li>
              ))}
            </ul>
            <div className="ref-folder-add">
              <div className="grow">
                <Input
                  id={ids.ref}
                  mono
                  value={refInput}
                  onChange={(v) => {
                    setRefInput(v)
                    setRefError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addRef(refInput)
                    }
                  }}
                  placeholder={examplePath('shared')}
                  invalid={!!refError}
                  aria-describedby={[refError ? ids.refErr : '', `${ids.ref}-hint`].join(' ')}
                  data-testid="new-project-ref-input"
                />
              </div>
              <Button icon={FolderOpen} onClick={() => void pickRef()} testId="new-project-ref-browse">
                Browse
              </Button>
              <Button icon={Plus} onClick={() => addRef(refInput)} testId="new-project-ref-add">
                Add
              </Button>
            </div>
            {refError && (
              <span id={ids.refErr} className="field-msg error" role="alert" data-testid="new-project-ref-error">
                {refError}
              </span>
            )}
            <span id={`${ids.ref}-hint`} className="hint">
              {REFERENCE_FOLDERS_HINT}
            </span>
          </div>
          {(!hasAgents || choice === 'architect') && (
            <div className="field">
              <label htmlFor={ids.brief}>What is the engagement about? (optional)</label>
              <Textarea
                id={ids.brief}
                value={brief}
                onChange={setBrief}
                placeholder="Who the client is, what you deliver, and anything the team must not touch. The setup interview asks about the rest."
              />
            </div>
          )}
        </>
      ) : projectKind === null ? null : kind === 'new' ? (
        <>
          {nameField('My app')}
          <div className="field">
            <label htmlFor={ids.brief}>What do you want to build?</label>
            <Textarea
              id={ids.brief}
              rows={5}
              value={brief}
              onChange={setBrief}
              placeholder="Describe the idea, who it is for, and anything you already know you want: stack, constraints, must-haves. The Architect asks about the rest."
            />
          </div>
          {pathField('Folder to create it in', examplePath('new-folder'), 'An empty folder is best. It is created if it does not exist.')}
        </>
      ) : (
        <>
          {pathField('Repository folder', examplePath('repo'), repoHint)}
          {nameField('Defaults to the folder name')}
          {(!hasAgents || choice === 'architect') && (
            <div className="field">
              <label htmlFor={ids.brief}>Anything the Architect should know? (optional)</label>
              <Textarea
                id={ids.brief}
                value={brief}
                onChange={setBrief}
                placeholder="e.g. the kind of work you mostly do here, areas to leave alone, or team conventions not written down."
              />
            </div>
          )}
        </>
      )}

      {projectKind && (
      <div className="stack-2 form-options">
        {hasAgents ? (
          <fieldset className="import-choice" data-testid="setup-choice">
            <legend>How should the org chart start?</legend>
            {(['import', 'architect', 'default'] as const).map((c) => (
              <label key={c}>
                <input type="radio" name={`${uid}-setup`} value={c} checked={choice === c} onChange={() => setPicked(c)} />
                {importChoiceLabel(c, agentTotal)}
              </label>
            ))}
            {choice === 'import' && <span className="hint">The project is created first; you review the roles next. Nothing is added until you import.</span>}
          </fieldset>
        ) : (
          <Checkbox
            checked={architect}
            onChange={setArchitect}
            label={engagement ? 'Start with the setup interview (recommended)' : 'Set up with the Architect (recommended)'}
            description={engagement ? 'Turn off to start with the standard engagement team.' : 'Turn off to start with the default roles and skip the interview.'}
            testId="architect-setup"
          />
        )}
        {mockAvailable && <div className="form-mock"><Checkbox checked={useMock} onChange={setUseMock} label="Use the mock adapter (no tokens are spent)" testId="use-mock" /></div>}
      </div>
      )}

      <p className="form-connection muted" data-testid="new-project-connection">
        {connectionView.text}
        {connectionView.link && (
          <>
            {' '}
            <button
              type="button"
              className="link-btn"
              data-testid="new-project-connection-change"
              onClick={() => {
                parkedDraft = { projectKind, client, refs, kind: pickedKind, name, path, brief, architect, picked, useMock }
                requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
                useAppStore.getState().setView('appSettings')
              }}
            >
              {connectionView.link}
            </button>
          </>
        )}
      </p>

      {pending && (
        <p id={ids.extrasErr} className="field-msg error" role="alert" data-testid="new-project-extras-error">
          The project was created, but not everything was saved. {pending.message} Open the project and set the rest in its settings.
        </p>
      )}

      <div className="row form-submit">
        {/* A blocked submit stays focusable (aria-disabled) so the keyboard reaches it and hears the reason; submit() ignores it. */}
        {!pending && blocker && !busy ? (
          <button type="submit" className="btn primary" aria-disabled="true" aria-describedby={ids.why} data-testid="new-project-submit" onClick={(e) => e.preventDefault()}>
            {existingId ? `Open ${current?.existingProjectName ?? 'project'}` : setupSubmitLabel(choice, busy, projectKind ?? 'code')}
          </button>
        ) : (
          <Button type="submit" variant="primary" loading={busy} testId="new-project-submit">
            {pending
              ? 'Open project'
              : existingId
                ? `Open ${current?.existingProjectName ?? 'project'}`
                : setupSubmitLabel(choice, busy, projectKind ?? 'code')}
          </Button>
        )}
        {variant !== 'card' && onCancel && !pending && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {existingId && !pending && (
          <Button onClick={() => void submit(null, true)} disabled={!!blocker || busy}>
            {setupSubmitLabel(choice, busy, projectKind ?? 'code')} anyway
          </Button>
        )}
        {blocker && !busy && !pending && (
          <span id={ids.why} className="hint">
            {blocker}
          </span>
        )}
      </div>
    </form>
  )
}
