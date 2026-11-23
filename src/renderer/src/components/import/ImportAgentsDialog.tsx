import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, FileSearch, Package, TriangleAlert } from 'lucide-react'
import type { AgentImportAction, AgentImportItem, AgentImportMode, AgentImportPreview, AgentImportScan, Project } from '@shared/types'
import { projectConnection, projectKindLabel, projectKindOf } from '@shared/defaults'
import { roleModelSentenceFor } from '../../lib/roleModelSentence'
import { hasHidden, showHidden } from '../../lib/hiddenChars'
import { useAppStore } from '../../store/useAppStore'
import { connectionLabel } from '../../lib/connectionLabel'
import {
  buildChoices,
  elevatedLabels,
  foundSelectedLine,
  importButtonLabel,
  importCount,
  importGroups,
  importSourceSupport,
  importedSummary,
  levelOptions,
  managerSlug,
  modeLine,
  sourceLabel,
  teamSizeLine,
  toolsDroppedLine,
  writeBannerMemory,
  type ImportEdit,
  type ImportGroup
} from '../../lib/agentImport'
import { cleanIpcError } from '../../lib/ipcError'
import { PLAIN_TIER_WORD } from '../../lib/tierWords'
import { importedCount, importedLine } from '../../lib/kit'
import { kitApi, type KitImportPreview } from '../../lib/kitApi'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { useConfirm } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Select } from '../ui/Select'
import KitImportDialog from '../kit/KitImportDialog'

const MODES: { value: AgentImportMode; label: string; title: string }[] = [
  { value: 'merge', label: 'Add to the team', title: 'Keep the current roles and add the imported ones' },
  { value: 'replace', label: 'Replace the team', title: 'Swap the whole team for the imported roles' }
]

const CLASH_CHOICES: { value: AgentImportAction; label: string; title: string }[] = [
  { value: 'add', label: 'Keep both', title: 'Add it under another name' },
  { value: 'replace', label: 'Replace mine', title: 'Take the place of the existing role' },
  { value: 'skip', label: 'Skip', title: 'Leave it out' }
]

const SEARCHED = '.claude/agents, .opencode/agents, opencode.json, .codex/agents, .github/agents, .gemini/agents, .kiro/agents, .roomodes and .orgai/org.json'

function ImportRow({
  item,
  index,
  preview,
  project,
  edit,
  modelOptions,
  onEdit
}: {
  item: AgentImportItem
  index: number
  project: Project
  preview: AgentImportPreview
  edit: ImportEdit | undefined
  modelOptions: { value: string; label: string }[]
  onEdit: (patch: ImportEdit) => void
}): ReactElement {
  const uid = useId()
  // A role with elevated grants opens its prompt: the user should read what gets commands or file access.
  const [open, setOpen] = useState(item.elevatedTools.length > 0)
  const included = item.action !== 'skip'
  const unchecked = edit?.include === false
  const roles = preview.roles.filter((r) => r.id !== item.roleId)
  const manager = managerSlug(item, preview.roles)
  const full = item.prompt
  const hidden = Math.max(0, item.promptLength - full.length)
  const importedIds = new Set(preview.items.map((i) => i.roleId))
  const rootName = preview.roles.find((r) => r.reportsTo === null && r.id !== item.roleId)?.name
  const models = modelOptions.some((o) => o.value === item.model) ? modelOptions : [{ value: item.model, label: item.model }, ...modelOptions]
  const elevated = elevatedLabels(item.elevatedTools)
  const importedRole = preview.roles.find((r) => r.id === item.roleId)
  // Main's own "Tools with no OrgAI equivalent were dropped" note says what the quiet line below already says.
  const notes = item.toolsDropped.length > 0 ? item.notes.filter((n) => !/^Tools with no OrgAI equivalent/.test(n)) : item.notes
  // The imported slug may already carry main's "-2" rename, so the existing role is matched by slug or by name.
  const wanted = item.name.toLowerCase()
  const mine = project.roles.find((r) => r.slug === item.slug || r.slug.toLowerCase() === wanted || r.name.toLowerCase() === wanted)?.name ?? item.name
  // The same sentence the role editor opens its Model section with; a tier role maps its tier to its own model id.
  const spend = importedRole
    ? roleModelSentenceFor({ roles: preview.roles, staffing: project.staffing }, importedRole, importedRole.tier ? { [importedRole.tier]: importedRole.model } : {})
    : null
  return (
    <li
      className={`import-row motion-enter${included ? '' : ' is-skipped'}${item.slugConflict ? ' has-clash' : ''}`}
      style={{ '--i': index } as CSSProperties}
      data-testid="import-row"
      data-slug={item.slug}
    >
      <div className="import-row-main">
        <div className="import-id">
          <Checkbox checked={edit?.include ?? true} onChange={(include) => onEdit({ include })} label={<strong>{showHidden(item.name)}</strong>} testId="import-include" />
          {item.description && <p className="import-desc muted">{showHidden(item.description)}</p>}
          {(hasHidden(item.name) || hasHidden(item.description) || hasHidden(item.prompt)) && (
            <p className="import-hidden-note" data-testid="import-hidden-chars">
              Contains hidden characters (shown as codes). Read the prompt before adding it.
            </p>
          )}
        </div>
        <div className="import-picks">
          <div className="import-field">
            <label htmlFor={`${uid}-rt`}>Reports to</label>
            {item.reportsTo === null && !manager ? (
              <span className="muted import-static">Top of the team</span>
            ) : (
              <Select
                id={`${uid}-rt`}
                value={manager}
                options={[
                  { value: '', label: rootName ?? 'Top level', disabled: true },
                  ...roles.map((r) => ({ value: r.slug, label: importedIds.has(r.id) ? `${r.name} (imported)` : r.name }))
                ]}
                onChange={(reportsTo) => onEdit({ reportsTo })}
                disabled={!included}
              />
            )}
          </div>
          <div className="import-field">
            <label htmlFor={`${uid}-model`}>Model</label>
            <Select id={`${uid}-model`} value={item.model} options={models} onChange={(model) => onEdit({ model })} disabled={!included} />
          </div>
        </div>
      </div>
      <div className="import-meta">
        <span className="chip">{sourceLabel(item.source)}</span>
        <span className="mono muted import-slug">{showHidden(item.slug)}</span>
        {elevated.map((label) => (
          <span key={label} className="chip warn">
            {label}
          </span>
        ))}
        <span className="import-model">
          <span className="remap-from mono" title="Model in the source file">
            {item.originalModel ? showHidden(item.originalModel) : 'not set'}
          </span>
          <span className="remap-arrow">
            <Icon icon={ArrowRight} size="xs" />
          </span>
          <span className="mono">{item.model}</span>
        </span>
      </div>
      {(item.modelReason === 'default' || item.modelReason === 'inherit' || (item.tier && item.modelReason === 'tier') || spend) && (
        <p className="hint import-hints">
          {item.modelReason === 'default' && <span>Not recognised, so the Standard model was used.</span>}
          {item.modelReason === 'inherit' && <span>Inherit means it uses its parent&apos;s model. </span>}
          {item.tier && item.modelReason === 'tier' && <span>Mapped to your {PLAIN_TIER_WORD[item.tier]} model.</span>}
          {spend && <span data-testid="import-spend">{spend}</span>}
        </p>
      )}
      {item.slugConflict && (
        <div className="import-clash" role="group" aria-label={`Name clash for ${showHidden(item.name)}`}>
          <span className="import-clash-text">
            <Icon icon={TriangleAlert} size="sm" />
            <span>Your team already has a role called {showHidden(mine)}.</span>
          </span>
          <fieldset className="import-clash-pick" disabled={unchecked}>
            <SegmentedControl
              label={`What to do with ${showHidden(item.name)}`}
              value={item.action === 'skip' ? 'skip' : (edit?.action ?? item.action)}
              options={CLASH_CHOICES}
              onChange={(action) => onEdit({ action })}
            />
          </fieldset>
        </div>
      )}
      {item.toolsDropped.length > 0 && (
        <p className="import-dropped" data-testid="import-dropped">
          {toolsDroppedLine(item.toolsDropped)}
        </p>
      )}
      <div className="import-tools">
        {item.tools.length > 0 ? (
          <span>
            <span className="muted">Granted: </span>
            {item.tools.map((t) => (
              <span key={t} className="chip mono">
                {showHidden(t)}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">No tools granted.</span>
        )}
        {item.tools.includes('Edit') && item.tools.includes('Write') && <span className="muted">Edit includes Write in OrgAI.</span>}
      </div>
      {notes.length > 0 && <p className="hint">{notes.join(' ')}</p>}
      <div className="import-prompt-toggle">
        <Button variant="ghost" size="sm" icon={open ? ChevronDown : ChevronRight} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide prompt' : 'Read prompt'}
        </Button>
      </div>
      {open && (
        <div id={`${uid}-prompt`} className="import-prompt">
          <pre tabIndex={0} role="region" aria-label={`Prompt of ${showHidden(item.name)}`}>
            {full}
          </pre>
          <p className="hint">
            {hidden > 0 ? `${hidden} more characters. ` : ''}The full prompt is imported as-is. You can edit it afterwards in the role inspector.
          </p>
        </div>
      )}
      <span className="muted mono import-file">{showHidden(item.file)}</span>
    </li>
  )
}

/** The "What will change" card of one lead role: roles already there, then the ones the import adds (dashed, marked +). */
function GroupCard({ group }: { group: ImportGroup }): ReactElement {
  return (
    <li className="import-group" data-testid="import-group">
      <div className="import-group-head">
        <span className="import-dot" aria-hidden="true" style={{ background: group.color }} />
        <span className="import-group-name">{showHidden(group.name)}</span>
        <span className="muted import-group-count">{group.changed ? `+${group.changed}` : 'no change'}</span>
      </div>
      <ul className="import-chips" aria-label={`Roles in ${showHidden(group.name)}`}>
        {group.roles.map((r) => (
          <li key={r.id} className={`import-chip is-${r.state}`}>
            {r.state === 'new' && <span aria-hidden="true">+ </span>}
            {showHidden(r.name)}
            {r.state === 'new' && <span className="sr-only"> (new)</span>}
            {r.state === 'replaces' && <span className="import-chip-note"> replaces the old one</span>}
          </li>
        ))}
      </ul>
    </li>
  )
}

/** Review before anything is written. Mount it only while open: its state is the review. */
export default function ImportAgentsDialog({
  project,
  defaultMode,
  fresh,
  onClose
}: {
  project: Project
  defaultMode: AgentImportMode
  /** The chart is the untouched default chart, so Replace needs no confirmation. */
  fresh?: boolean
  onClose: () => void
}): ReactElement {
  const [scan, setScan] = useState<AgentImportScan | null>(null)
  // Where the agents come from: this project's folder, a folder the user picked, or another stored project.
  const [src, setSrc] = useState<{ kind: 'here' } | { kind: 'path'; path: string } | { kind: 'project'; projectId: string }>({ kind: 'here' })
  const [pickingProject, setPickingProject] = useState(false)
  const [srcError, setSrcError] = useState<string | null>(null)
  const allProjects = useAppStore((s) => s.projects)
  const otherProjects = useMemo(() => allProjects.filter((p) => p.id !== project.id), [allProjects, project.id])
  const srcInput = useMemo(
    () => (src.kind === 'path' ? { sourcePath: src.path } : src.kind === 'project' ? { fromProjectId: src.projectId } : {}),
    [src]
  )
  const [mode, setMode] = useState<AgentImportMode>(defaultMode)
  const [edits, setEdits] = useState<Record<string, ImportEdit>>({})
  const [preview, setPreview] = useState<AgentImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyErrorRef = useRef<HTMLSpanElement>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [kitPreview, setKitPreview] = useState<KitImportPreview | null>(null)
  const [kitBusy, setKitBusy] = useState(false)
  const [kitError, setKitError] = useState<string | null>(null)
  const [kitDone, setKitDone] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()
  const connection = projectConnection(project)
  const info = useAppStore((s) => s.connections?.find((c) => c.connection.id === connection))
  const catalog = useAppStore((s) => s.models[connection])
  const loadModels = useAppStore((s) => s.loadModels)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const connectionsLoaded = useAppStore((s) => s.connections !== null)
  const support = importSourceSupport()
  const kind = projectKindOf(project)
  const reasonId = useId()

  useEffect(() => {
    if (!connectionsLoaded) void loadConnections()
    if (!catalog) void loadModels(connection)
  }, [connectionsLoaded, catalog, connection, loadConnections, loadModels])

  useEffect(() => {
    if (applyError) applyErrorRef.current?.focus()
  }, [applyError])

  useEffect(() => {
    let live = true
    setEdits({})
    setPreview(null)
    if (src.kind === 'project') {
      // Another stored project: its roles are the agents (main builds the items from them, source 'orgai').
      const other = useAppStore.getState().projects.find((p) => p.id === src.projectId)
      const n = other?.roles.length ?? 0
      setScan({ sources: n > 0 ? [{ source: 'orgai', label: other?.name ?? 'Another project', files: [], agentCount: n }] : [], instructionFiles: [], warnings: [] })
      return undefined
    }
    setScan(null)
    window.orgai.projects
      .scanAgents(src.kind === 'path' ? src.path : project.path)
      .then((s) => live && setScan(s))
      .catch(() => live && setScan({ sources: [], instructionFiles: [], warnings: [] }))
    return () => {
      live = false
    }
  }, [project.path, src])

  const chooseFolder = async (): Promise<void> => {
    setSrcError(null)
    try {
      const path = await window.orgai.importSources.pickAgentFolder()
      if (path) setSrc({ kind: 'path', path })
    } catch (e) {
      setSrcError(cleanIpcError(e))
    }
  }

  const hasSources = (scan?.sources.length ?? 0) > 0
  const choices = useMemo(() => buildChoices(edits), [edits])

  // Every choice change asks main again, so the chart shown is the chart main would save.
  useEffect(() => {
    if (!scan || !hasSources) return undefined
    let live = true
    setLoading(true)
    window.orgai.projects
      .previewImport({ projectId: project.id, mode, choices, ...srcInput })
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
  }, [scan, hasSources, project.id, project.roles, mode, choices, refresh, srcInput])

  const modelOptions = useMemo(() => levelOptions(info?.connection.tierModels ?? {}, catalog), [info, catalog])

  const edit = (key: string, patch: ImportEdit): void => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }))
  const count = importCount(preview)
  const found = preview?.items.length ?? 0
  const groups = useMemo(() => (preview ? importGroups(preview) : []), [preview])

  const selectAll = (): void =>
    setEdits((e) => {
      const next = { ...e }
      for (const item of preview?.items ?? []) next[item.key] = { ...next[item.key], include: true, ...(next[item.key]?.action === 'skip' ? { action: undefined } : {}) }
      return next
    })

  const chooseKit = async (): Promise<void> => {
    const api = kitApi()
    if (!api || kitBusy) return
    setKitBusy(true)
    setKitError(null)
    setKitDone(null)
    try {
      const path = await api.pickImportPath()
      if (!path) return
      setKitPreview(await api.previewImport({ path }))
    } catch (e) {
      setKitError(cleanIpcError(e))
    } finally {
      setKitBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!preview || count === 0 || applying) return
    if (!fresh && preview.replacedRoleIds.length > 0) {
      const names = preview.replacedRoleIds.map((id) => project.roles.find((r) => r.id === id)?.name ?? id)
      const ok = await confirm({
        title: `Replace ${names.length} role${names.length === 1 ? '' : 's'}?`,
        body: `${names.join(', ')} will be replaced. You can undo this right after the import.`,
        confirmLabel: `Replace ${names.length} role${names.length === 1 ? '' : 's'}`,
        danger: true
      })
      if (!ok) return
    }
    setApplying(true)
    setApplyError(null)
    try {
      const result = await window.orgai.projects.applyImport({ projectId: project.id, mode, choices, digest: preview.digest, ...srcInput })
      useAppStore.getState().replaceProject(result.project)
      useAppStore.getState().recordImport(project.id, {
        count,
        summary: importedSummary(count, [...new Set(preview.items.filter((i) => i.action !== 'skip').map((i) => i.source))]),
        previousRoles: result.previousRoles,
        importedRoles: result.project.roles
      })
      writeBannerMemory(window.localStorage, project.id, 'imported')
      onClose()
    } catch (e) {
      setApplyError(cleanIpcError(e))
    } finally {
      setApplying(false)
    }
  }

  const mock = project.provider?.id === 'mock'
  // The instruction-files banner says it once; keep the roll-up line out of the list.
  const warnings = (preview?.warnings ?? []).filter((w) => !(preview && preview.instructionFiles.length > 0 && /instruction file/i.test(w)))
  const flat = (preview?.items ?? []).some((i) => i.source !== 'orgai')
  const footer = (
    <>
      {applyError ? (
        <span className="import-foot-error" role="alert" tabIndex={-1} ref={applyErrorRef} data-testid="import-apply-error">
          <strong>Nothing was imported.</strong> {applyError}
          <Button size="sm" onClick={() => { setApplyError(null); setRefresh((n) => n + 1) }}>
            Refresh preview
          </Button>
        </span>
      ) : (
        <span className="import-foot-note muted">You can undo the import from the Team tab afterwards.</span>
      )}
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => void apply()} disabled={!preview || count === 0 || loading} loading={applying} testId="import-apply">
        {importButtonLabel(count, mode)}
      </Button>
    </>
  )

  const projectName = showHidden(project.name)
  const kitOn = !!kitApi()
  const off = [!support.otherProject && 'Another OrgAI project', !support.chooseFolder && 'Choosing another folder', !kitOn && 'Kits'].filter(Boolean) as string[]
  const anyOff = off.length > 0
  const offLine = `${off.join(', ').replace(/, ([^,]*)$/, ' and $1')} ${off.length === 1 ? 'is' : 'are'} ${support.unavailable.toLowerCase()}.`
  const fromPath = src.kind === 'path' ? src.path : project.path
  const fromProject = src.kind === 'project' ? otherProjects.find((p) => p.id === src.projectId) : undefined
  const fromCard = (
    <div className="import-from" data-testid="import-from">
      <div className="import-from-row">
        <span className="import-from-label" id={`${reasonId}-from`}>
          From
        </span>
        <div className="import-srcs" role="group" aria-labelledby={`${reasonId}-from`}>
          <Button
            size="sm"
            className="import-src"
            pressed={src.kind !== 'project'}
            testId="import-src-folder"
            onClick={() => {
              setPickingProject(false)
              if (src.kind === 'project') setSrc({ kind: 'here' })
            }}
          >
            A folder of agent files
          </Button>
          <Button
            size="sm"
            className="import-src"
            pressed={src.kind === 'project' || pickingProject}
            inert={!support.otherProject || otherProjects.length === 0}
            title={!support.otherProject ? support.unavailable : otherProjects.length === 0 ? 'You have no other projects' : undefined}
            ariaDescribedBy={support.otherProject ? undefined : `${reasonId}-why`}
            testId="import-src-project"
            onClick={() => setPickingProject(true)}
          >
            Another OrgAI project
          </Button>
          <Button
            size="sm"
            className="import-src"
            pressed={false}
            icon={Package}
            loading={kitBusy}
            inert={!kitOn}
            title={kitOn ? undefined : support.unavailable}
            ariaDescribedBy={kitOn ? undefined : `${reasonId}-why`}
            testId="import-src-kit"
            onClick={() => void chooseKit()}
          >
            A kit
          </Button>
        </div>
      </div>
      {src.kind === 'project' || pickingProject ? (
        <div className="import-from-row">
          <label className="import-from-label" htmlFor={`${reasonId}-proj`}>
            Project
          </label>
          <Select
            id={`${reasonId}-proj`}
            value={src.kind === 'project' ? src.projectId : ''}
            options={[{ value: '', label: 'Choose a project', disabled: true }, ...otherProjects.map((p) => ({ value: p.id, label: `${showHidden(p.name)} (${p.roles.length} ${p.roles.length === 1 ? 'role' : 'roles'})` }))]}
            onChange={(id) => {
              if (id) setSrc({ kind: 'project', projectId: id })
            }}
          />
          {fromProject && <span className="muted">Imports its roles; this project keeps its own.</span>}
        </div>
      ) : (
        <div className="import-from-row">
          <span className="mono import-from-path" title={showHidden(fromPath)}>
            {showHidden(fromPath)}
          </span>
          <Button
            size="sm"
            inert={!support.chooseFolder}
            title={support.chooseFolder ? undefined : support.unavailable}
            ariaDescribedBy={support.chooseFolder ? undefined : `${reasonId}-why`}
            testId="import-choose-folder"
            onClick={() => void chooseFolder()}
          >
            Choose another
          </Button>
          {src.kind === 'path' && (
            <Button size="sm" variant="ghost" testId="import-from-here" onClick={() => setSrc({ kind: 'here' })}>
              Use this project&apos;s folder
            </Button>
          )}
        </div>
      )}
      {anyOff && (
        <p className="hint import-from-why" id={`${reasonId}-why`}>
          {offLine}
        </p>
      )}
      {scan && scan.sources.length > 0 && (
        <ul className="import-sources" aria-label="Sources">
          {scan.sources.map((s) => (
            <li key={s.source}>
              <strong>{showHidden(s.label)}</strong> <span className="muted">{s.agentCount} agent{s.agentCount === 1 ? '' : 's'}</span>
              {s.files.length > 0 && (
                <span className="mono muted import-files" title={showHidden(s.files.join('\n'))}>
                  {s.files.length > 1 ? `${s.files.length} files` : showHidden(s.files[0] ?? '')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {srcError && (
        <p className="field-error" role="alert" data-testid="import-src-error">
          {srcError}
        </p>
      )}
      {kitError && (
        <p className="field-error" role="alert" data-testid="import-kit-error">
          {kitError}
        </p>
      )}
      {kitDone && (
        <p className="import-kit-done" role="status" data-testid="import-kit-done">
          {kitDone}
        </p>
      )}
    </div>
  )
  return (
    <>
      <Dialog open onClose={onClose} title={`Import agents into ${projectName}`} description={`Nothing changes until you press ${mode === 'replace' ? 'Replace' : 'Add'}`} size="lg" footer={footer} testId="import-dialog">
        <div className="import-root" data-kind={kind}>
          {kind === 'engagement' && (
            <p className="import-kind">
              <span className="import-kind-badge">{projectKindLabel(kind)}</span>
            </p>
          )}
          {!scan ? (
            <p className="muted" role="status">
              Looking for agent files…
            </p>
          ) : !hasSources ? (
            <>
              {fromCard}
              <EmptyState
                compact
                icon={FileSearch}
                title={src.kind === 'project' ? 'That project has no roles' : 'No agent files found'}
                description={src.kind === 'project' ? 'Pick another project or folder.' : `Searched ${SEARCHED} in ${showHidden(fromPath)}.`}
                testId="import-empty"
              />
            </>
          ) : (
            <div className="import-body">
              <div className="import-main">
                {fromCard}
                <SegmentedControl label="Import mode" value={mode} options={MODES} onChange={setMode} />
                {preview && <p className="hint import-mode-line">{modeLine(mode, count, project.roles.length, preview.roles.length)}</p>}
                {error && (
                  <Banner tone="danger" title="Could not build the preview">
                    {error}
                  </Banner>
                )}
                {warnings.length > 0 && (
                  <Banner tone="warning" title={`${warnings.length} thing${warnings.length === 1 ? '' : 's'} to check`} testId="import-warnings">
                    <ul className="import-warn-list">
                      {warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </Banner>
                )}
                {preview && preview.instructionFiles.length > 0 && (
                  <Banner tone="info">
                    <span className="mono">{preview.instructionFiles.join(', ')}</span> holds project instructions. The Architect reads them; they do not become roles.
                  </Banner>
                )}
                {preview && (
                  <>
                    <div className="import-found">
                      <span className="import-found-line" role="status" data-testid="import-found">
                        {foundSelectedLine(found, count)}
                      </span>
                      <Button variant="ghost" size="sm" onClick={selectAll} disabled={count === found} testId="import-select-all">
                        Select all
                      </Button>
                    </div>
                    <p className="hint">
                      Each model becomes one of {mock ? "the connection's tiers (mock adapter)" : `${connectionLabel(preview.connection)}'s tiers`}
                      {flat ? '; roles without a hierarchy report to the orchestrator' : ''}. Change either below.
                    </p>
                    <ul className="import-roles" aria-busy={loading}>
                      {preview.items.map((item, i) => (
                        <ImportRow
                          key={item.key}
                          item={item}
                          index={i}
                          preview={preview}
                          project={project}
                          edit={edits[item.key]}
                          modelOptions={modelOptions}
                          onEdit={(patch) => edit(item.key, patch)}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {!preview && !error && (
                  <p className="muted" role="status">
                    Building the preview…
                  </p>
                )}
              </div>
              {preview && (
                <aside className="import-aside" aria-label="What will change" data-testid="import-aside">
                  <h3>What will change</h3>
                  {groups.length > 0 && (
                    <ul className="import-groups">
                      {groups.map((g) => (
                        <GroupCard key={g.id} group={g} />
                      ))}
                    </ul>
                  )}
                  <ul className="import-notes">
                    <li>{teamSizeLine(project.roles.length, preview.roles.length)}</li>
                    <li>Imported roles keep their own instructions, word for word.</li>
                    <li>Model names in the files become model tiers (Fast, Standard, Advanced, Most capable).</li>
                  </ul>
                </aside>
              )}
            </div>
          )}
        </div>
      </Dialog>
      {kitPreview && (
        <KitImportDialog
          preview={kitPreview}
          onClose={() => setKitPreview(null)}
          onApplied={(result) => {
            setKitPreview(null)
            setKitDone(importedLine(importedCount(result)))
            void useAppStore.getState().loadTemplates()
          }}
        />
      )}
      {dialog}
    </>
  )
}
