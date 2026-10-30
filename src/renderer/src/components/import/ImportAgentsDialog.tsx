import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, FileSearch } from 'lucide-react'
import type { AgentImportAction, AgentImportItem, AgentImportMode, AgentImportPreview, AgentImportScan, Project } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { projectConnection } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import {
  buildChoices,
  elevatedLabels,
  importButtonLabel,
  importCount,
  importedSummary,
  managerSlug,
  modeLine,
  sourceLabel,
  writeBannerMemory,
  type ImportEdit
} from '../../lib/agentImport'
import { cleanIpcError } from '../../lib/ipcError'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import { useConfirm } from '../ui/ConfirmDialog'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Select } from '../ui/Select'

const MODES: { value: AgentImportMode; label: string; title: string }[] = [
  { value: 'merge', label: 'Add to the chart', title: 'Keep the current roles and add the imported ones' },
  { value: 'replace', label: 'Replace the chart', title: 'Swap the whole chart for the imported roles' }
]

const SEARCHED = '.claude/agents, .opencode/agents, opencode.json, .codex/agents, .github/agents, .gemini/agents, .kiro/agents, .roomodes and .orgai/org.json'

const CONN_NAME = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

function ImportRow({
  item,
  preview,
  edit,
  modelOptions,
  onEdit
}: {
  item: AgentImportItem
  preview: AgentImportPreview
  edit: ImportEdit | undefined
  modelOptions: { value: string; label: string }[]
  onEdit: (patch: ImportEdit) => void
}): ReactElement {
  const uid = useId()
  // A role with elevated grants opens its prompt: the user should read what gets commands or file access.
  const [open, setOpen] = useState(item.elevatedTools.length > 0)
  const included = item.action !== 'skip'
  const roles = preview.roles.filter((r) => r.id !== item.roleId)
  const manager = managerSlug(item, preview.roles)
  const full = item.prompt
  const hidden = Math.max(0, item.promptLength - full.length)
  const importedIds = new Set(preview.items.map((i) => i.roleId))
  const rootName = preview.roles.find((r) => r.reportsTo === null && r.id !== item.roleId)?.name
  const models = modelOptions.some((o) => o.value === item.model) ? modelOptions : [{ value: item.model, label: item.model }, ...modelOptions]
  const elevated = elevatedLabels(item.elevatedTools)
  return (
    <li className={`import-row${included ? '' : ' is-skipped'}`} data-testid="import-row" data-slug={item.slug}>
      <div className="import-row-head">
        <Checkbox checked={edit?.include ?? true} onChange={(include) => onEdit({ include })} label={<strong>{item.name}</strong>} testId="import-include" />
        <span className="chip">{sourceLabel(item.source)}</span>
        <span className="mono muted import-slug">{item.slug}</span>
        {item.slugConflict && <span className="chip warn">Name already used</span>}
        {elevated.map((label) => (
          <span key={label} className="chip warn">
            {label}
          </span>
        ))}
      </div>
      {item.description && <p className="import-desc muted">{item.description}</p>}
      <div className="import-fields">
        <div className="import-field">
          <label htmlFor={`${uid}-rt`}>Reports to</label>
          {item.reportsTo === null && !manager ? (
            <span className="muted import-static">Top of the chart</span>
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
          <div className="import-model">
            <span className="remap-from mono" title="Model in the source file">
              {item.originalModel ?? 'not set'}
            </span>
            <span className="remap-arrow">
              <Icon icon={ArrowRight} size="xs" />
            </span>
            <Select id={`${uid}-model`} value={item.model} options={models} onChange={(model) => onEdit({ model })} disabled={!included} />
          </div>
          {item.modelReason === 'default' && <span className="hint">Not recognised, so the Everyday tier was used.</span>}
          {item.modelReason === 'inherit' && <span className="hint">Inherit means it uses its parent's model.</span>}
          {item.tier && item.modelReason === 'tier' && <span className="hint">Mapped to your {item.tier} tier.</span>}
        </div>
        {item.slugConflict && (
          <div className="import-field">
            <label htmlFor={`${uid}-act`}>If the name exists</label>
            <Select
              id={`${uid}-act`}
              value={item.action === 'skip' ? 'skip' : (edit?.action ?? item.action)}
              options={[
                { value: 'add', label: 'Add (renamed)' },
                { value: 'replace', label: 'Replace the existing role' },
                { value: 'skip', label: 'Skip' }
              ]}
              onChange={(v) => onEdit({ action: v as AgentImportAction })}
            />
          </div>
        )}
      </div>
      <div className="import-tools">
        {item.tools.length > 0 ? (
          <span>
            <span className="muted">Granted: </span>
            {item.tools.map((t) => (
              <span key={t} className="chip mono">
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">No tools granted.</span>
        )}
        {item.tools.includes('Edit') && item.tools.includes('Write') && <span className="muted">Edit includes Write in OrgAI.</span>}
        {item.toolsDropped.length > 0 && (
          <span className="import-dropped" title="OrgAI has no equivalent for these tools, so the role will not have them.">
            Not available in OrgAI: {item.toolsDropped.join(', ')}
          </span>
        )}
      </div>
      {item.notes.length > 0 && <p className="hint">{item.notes.join(' ')}</p>}
      <div className="import-prompt-toggle">
        <Button variant="ghost" size="sm" icon={open ? ChevronDown : ChevronRight} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide prompt' : 'Read prompt'}
        </Button>
      </div>
      {open && (
        <div id={`${uid}-prompt`} className="import-prompt">
          <pre tabIndex={0} role="region" aria-label={`Prompt of ${item.name}`}>
            {full}
          </pre>
          <p className="hint">
            {hidden > 0 ? `${hidden} more characters. ` : ''}The full prompt is imported as-is. You can edit it afterwards in the role inspector.
          </p>
        </div>
      )}
      <span className="muted mono import-file">{item.file}</span>
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
  const [mode, setMode] = useState<AgentImportMode>(defaultMode)
  const [edits, setEdits] = useState<Record<string, ImportEdit>>({})
  const [preview, setPreview] = useState<AgentImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const applyErrorRef = useRef<HTMLSpanElement>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const { confirm, dialog } = useConfirm()
  const connection = projectConnection(project)
  const info = useAppStore((s) => s.connections?.find((c) => c.connection.id === connection))
  const catalog = useAppStore((s) => s.models[connection])
  const loadModels = useAppStore((s) => s.loadModels)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const connectionsLoaded = useAppStore((s) => s.connections !== null)

  useEffect(() => {
    if (!connectionsLoaded) void loadConnections()
    if (!catalog) void loadModels(connection)
  }, [connectionsLoaded, catalog, connection, loadConnections, loadModels])

  useEffect(() => {
    if (applyError) applyErrorRef.current?.focus()
  }, [applyError])

  useEffect(() => {
    let live = true
    window.orgai.projects
      .scanAgents(project.path)
      .then((s) => live && setScan(s))
      .catch(() => live && setScan({ sources: [], instructionFiles: [], warnings: [] }))
    return () => {
      live = false
    }
  }, [project.path])

  const hasSources = (scan?.sources.length ?? 0) > 0
  const choices = useMemo(() => buildChoices(edits), [edits])

  // Every choice change asks main again, so the chart shown is the chart main would save.
  useEffect(() => {
    if (!scan || !hasSources) return undefined
    let live = true
    setLoading(true)
    window.orgai.projects
      .previewImport({ projectId: project.id, mode, choices })
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
  }, [scan, hasSources, project.id, project.roles, mode, choices, refresh])

  const modelOptions = useMemo(() => {
    const tierModels = info?.connection.tierModels ?? {}
    const seen = new Set<string>(['inherit'])
    const out: { value: string; label: string }[] = [{ value: 'inherit', label: 'Inherit from parent' }]
    for (const o of MODEL_TIER_OPTIONS) {
      const id = tierModels[o.value] ?? o.value
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ value: id, label: `${id} · ${o.label}` })
    }
    for (const m of catalog ?? []) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push({ value: m.id, label: m.id })
    }
    return out
  }, [info, catalog])

  const edit = (key: string, patch: ImportEdit): void => setEdits((e) => ({ ...e, [key]: { ...e[key], ...patch } }))
  const count = importCount(preview)

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
      const result = await window.orgai.projects.applyImport({ projectId: project.id, mode, choices, digest: preview.digest })
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
        <span className="import-foot-note muted">Nothing is written until you import. Your files are not changed.</span>
      )}
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" onClick={() => void apply()} disabled={!preview || count === 0 || loading} loading={applying} testId="import-apply">
        {importButtonLabel(count, mode)}
      </Button>
    </>
  )

  return (
    <>
      <Dialog open onClose={onClose} title="Import agents" description="Review the roles found in this folder before they join the org chart." size="lg" footer={footer} testId="import-dialog">
        {!scan ? (
          <p className="muted" role="status">
            Looking for agent files…
          </p>
        ) : !hasSources ? (
          <EmptyState
            compact
            icon={FileSearch}
            title="No agent files found"
            description={`Searched ${SEARCHED} in ${project.path}.`}
            testId="import-empty"
          />
        ) : (
          <div className="import-body">
            <ul className="import-sources" aria-label="Sources">
              {scan.sources.map((s) => (
                <li key={s.source}>
                  <strong>{s.label}</strong> <span className="muted">{s.agentCount} agent{s.agentCount === 1 ? '' : 's'}</span>
                  <span className="mono muted import-files" title={s.files.join('\n')}>
                    {s.files.length > 1 ? `${s.files.length} files` : s.files[0]}
                  </span>
                </li>
              ))}
            </ul>
            <SegmentedControl label="Import mode" value={mode} options={MODES} onChange={setMode} />
            {preview && <p className="hint import-mode-line">{modeLine(mode, count, project.roles.length)}</p>}
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
                <p className="hint">
                  Models map to {mock ? "the connection's tiers (mock adapter)" : `${CONN_NAME[preview.connection]}'s tiers`}
                  {flat ? '; roles without a hierarchy report to the orchestrator' : ''}. Change either below.
                </p>
                <ul className="import-roles" aria-busy={loading}>
                  {preview.items.map((item) => (
                    <ImportRow
                      key={item.key}
                      item={item}
                      preview={preview}
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
        )}
      </Dialog>
      {dialog}
    </>
  )
}
