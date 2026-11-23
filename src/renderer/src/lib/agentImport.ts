import type { AgentImportAction, AgentImportChoice, AgentImportMode, AgentImportItem, AgentImportPreview, AgentImportSource, ModelTier, ProjectPathCheck, Role } from '@shared/types'
import { AGENT_IMPORT_SOURCE_LABELS } from '@shared/types'
import { PLAIN_TIER_ORDER, PLAIN_TIER_WORD } from './tierWords'

/** What a new project does with the agent files found in its folder. */
export type SetupChoice = 'import' | 'architect' | 'default' | 'template' | 'team'

/** The user's edits to one previewed role. Unset fields keep what the importer chose. */
export interface ImportEdit {
  include?: boolean
  reportsTo?: string
  model?: string
  action?: AgentImportAction
}

export function sourceLabel(source: AgentImportSource): string {
  return AGENT_IMPORT_SOURCE_LABELS[source]
}

/**
 * Agents other tools left in the folder. While a team is found (`teamFiles`) the folder's own `.orgai` source is never
 * counted (main leaves it out too) and the team path replaces the import path, so this is 0.
 */
export function totalAgents(check: Pick<ProjectPathCheck, 'agentSources' | 'teamFiles'> | null | undefined): number {
  if (check?.teamFiles) return 0
  return (check?.agentSources ?? []).reduce((n, s) => n + s.agentCount, 0)
}

/** Agents of other tools next to a found team: not imported, mentioned in one quiet line. */
export function otherToolAgents(check: Pick<ProjectPathCheck, 'agentSources'> | null | undefined): number {
  return (check?.agentSources ?? []).filter((s) => s.source !== 'orgai').reduce((n, s) => n + s.agentCount, 0)
}

function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "Found 2 Claude Code agents and AGENTS.md." or null when the folder has neither. */
export function foundLine(check: Pick<ProjectPathCheck, 'agentSources' | 'instructionFiles' | 'teamFiles'> | null | undefined): string | null {
  // A found team has its own panel; nothing here talks about importing agents next to it.
  if (!check || check.teamFiles) return null
  const parts = (check.agentSources ?? []).filter((s) => s.agentCount > 0).map((s) => `${s.agentCount} ${s.label} agent${s.agentCount === 1 ? '' : 's'}`)
  const docs = [...new Set((check.instructionFiles ?? []).map(baseName))]
  if (docs.length > 2) parts.push(`${docs.length} instruction files`)
  else parts.push(...docs)
  return parts.length ? `Found ${joinWords(parts)}.` : null
}

/**
 * The choice in force: the user's pick, else Import when agents exist, else the old Architect checkbox. With saved
 * templates the checkbox becomes the radio group, so a pick of Architect or the standard team counts without agents too.
 */
export function effectiveSetupChoice(hasAgents: boolean, picked: SetupChoice | null, architect: boolean, hasTemplates = false): SetupChoice {
  if (picked === 'template' && hasTemplates) return 'template'
  if (hasAgents) return picked && picked !== 'template' ? picked : 'import'
  if (hasTemplates && (picked === 'architect' || picked === 'default')) return picked
  return architect ? 'architect' : 'default'
}

export function setupSubmitLabel(choice: SetupChoice, busy: boolean, kind: 'code' | 'engagement' = 'code'): string {
  if (choice === 'team') return busy ? 'Creating…' : 'Create project'
  if (choice === 'template') return busy ? 'Creating…' : 'Create from template'
  if (choice === 'import') return busy ? 'Creating…' : 'Create project and review import'
  if (choice === 'architect' && kind === 'engagement') return busy ? 'Starting the interview…' : 'Create and start interview'
  if (choice === 'architect') return busy ? 'Scanning and starting the Architect…' : 'Create and start setup'
  return busy ? 'Creating…' : 'Create project'
}

export function importChoiceLabel(choice: SetupChoice, count: number): string {
  if (choice === 'import') return `Import the ${count} agent${count === 1 ? '' : 's'} (review first)`
  if (choice === 'architect') return 'Let the Architect set up (it sees the agents)'
  return 'Start with the default chart'
}

/** Radio labels of the "How should the team start?" group (the template option has its own row). */
export function setupChoiceLabel(choice: SetupChoice, count: number, kind: 'code' | 'engagement', hasAgents: boolean): string {
  if (choice === 'import') return importChoiceLabel('import', count)
  if (choice === 'template') return 'Start from a template'
  if (choice === 'team') return "Use the team in this folder"
  if (choice === 'architect') {
    if (hasAgents) return importChoiceLabel('architect', count)
    return kind === 'engagement' ? 'Start with the setup interview (recommended)' : 'Set up with the Architect (recommended)'
  }
  return kind === 'engagement' ? 'Start with the standard team' : 'Start with the default chart'
}

/** The hint under the checked template option. */
export function templateChoiceHint(kind: 'code' | 'engagement'): string {
  return kind === 'engagement'
    ? 'The setup interview is skipped. Run it later from the Live tab to write the engagement plan.'
    : 'The Architect is skipped. Run setup later from the Live tab.'
}

/** The choices sent to previewImport / applyImport: only keys the user edited. */
export function buildChoices(edits: Record<string, ImportEdit>): AgentImportChoice[] {
  return Object.entries(edits).map(([key, e]) => ({
    key,
    include: e.include ?? true,
    ...(e.reportsTo !== undefined ? { reportsTo: e.reportsTo } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.action !== undefined ? { action: e.action } : {})
  }))
}

/** Roles that would be imported: everything not skipped. */
export function importCount(preview: Pick<AgentImportPreview, 'items'> | null | undefined): number {
  return (preview?.items ?? []).filter((i) => i.action !== 'skip').length
}

export function importButtonLabel(count: number, mode: AgentImportMode = 'merge'): string {
  if (count <= 0) return 'Select at least one'
  const roles = `${count} role${count === 1 ? '' : 's'}`
  return mode === 'replace' ? `Replace team with ${roles}` : `Add ${roles} to the team`
}

/** "Found 6 agents. 4 selected." (the list header; every number comes from the preview). */
export function foundSelectedLine(found: number, selected: number): string {
  return `Found ${found} agent${found === 1 ? '' : 's'}. ${selected} selected.`
}

/** The quiet line under a role whose file asks for tools OrgAI has no equivalent for. */
export function toolsDroppedLine(names: string[]): string {
  return `Its file asks for a tool OrgAI does not have (${names.join(', ')}). It will work without it.`
}

/** "The team goes from 12 to 15 roles." */
export function teamSizeLine(before: number, after: number): string {
  return before === after ? `The team stays at ${after} role${after === 1 ? '' : 's'}.` : `The team goes from ${before} to ${after} roles.`
}

/**
 * The Level choices of an imported role: "inherit", one entry per tier named in plain words with the exact model id the
 * connection maps it to, then the connection's catalog. The value is always what AgentImportChoice.model accepts.
 */
export function levelOptions(
  tierModels: Partial<Record<ModelTier, string>>,
  catalog: { id: string }[] | undefined
): { value: string; label: string }[] {
  const seen = new Set<string>(['inherit'])
  const out: { value: string; label: string }[] = [{ value: 'inherit', label: 'Inherit from parent' }]
  for (const tier of PLAIN_TIER_ORDER) {
    const id = tierModels[tier] ?? tier
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ value: id, label: id === tier ? PLAIN_TIER_WORD[tier] : `${PLAIN_TIER_WORD[tier]} · ${id}` })
  }
  for (const m of catalog ?? []) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push({ value: m.id, label: m.id })
  }
  return out
}

/**
 * Where agents can come from. Today only the project's own folder is scanned and a kit goes through the kit dialog. The
 * other two need main (a folder picker and a read of another stored project); they stay off until `AgentImportInput`
 * carries them, and this is the one place to turn them on.
 */
export interface ImportSourceSupport {
  otherProject: boolean
  chooseFolder: boolean
  /** Shown as the title of a control that is off. */
  unavailable: string
}

export function importSourceSupport(): ImportSourceSupport {
  return { otherProject: false, chooseFolder: false, unavailable: 'Not available yet' }
}

export interface ImportGroupRole {
  id: string
  name: string
  /** 'new' is added by the import, 'replaces' takes the place of an existing role, 'existing' stays as it is. */
  state: 'existing' | 'new' | 'replaces'
}

export interface ImportGroup {
  id: string
  name: string
  color: string
  roles: ImportGroupRole[]
  /** Roles in the group that the import adds or replaces. */
  changed: number
}

/**
 * The "What will change" cards from the previewed chart: one card per lead role that has reports (its whole subtree), plus
 * one for the top role with the leads that have none. Everything is read from the preview, never invented.
 */
export function importGroups(preview: Pick<AgentImportPreview, 'roles' | 'items'>): ImportGroup[] {
  const roles = preview.roles
  const byAction = new Map<string, AgentImportAction>()
  for (const i of preview.items) if (i.roleId && i.action !== 'skip') byAction.set(i.roleId, i.action)
  const children = new Map<string, Role[]>()
  const roots: Role[] = []
  for (const r of roles) {
    if (r.reportsTo && roles.some((p) => p.id === r.reportsTo)) children.set(r.reportsTo, [...(children.get(r.reportsTo) ?? []), r])
    else roots.push(r)
  }
  const entry = (r: Role): ImportGroupRole => {
    const action = byAction.get(r.id)
    return { id: r.id, name: r.name, state: action === 'replace' ? 'replaces' : action ? 'new' : 'existing' }
  }
  const subtree = (r: Role, seen = new Set<string>()): Role[] => {
    if (seen.has(r.id)) return []
    seen.add(r.id)
    return [r, ...(children.get(r.id) ?? []).flatMap((c) => subtree(c, seen))]
  }
  const make = (id: string, name: string, color: string, members: Role[]): ImportGroup => {
    const list = members.map(entry)
    return { id, name, color, roles: list, changed: list.filter((e) => e.state !== 'existing').length }
  }
  const [top, ...otherRoots] = roots
  if (!top) return []
  const leads = [...(children.get(top.id) ?? []), ...otherRoots]
  const leaves = leads.filter((l) => subtree(l).length === 1)
  const trees = leads.filter((l) => subtree(l).length > 1)
  return [make(top.id, top.name, top.color, [top, ...leaves]), ...trees.map((l) => make(l.id, l.name, l.color, subtree(l)))]
}

/** One line on what the chosen mode does to the chart, with counts. */
export function modeLine(mode: AgentImportMode, imported: number, existing: number): string {
  const n = (c: number): string => `${c} role${c === 1 ? '' : 's'}`
  return mode === 'replace' ? `Replaces your ${n(existing)} with these ${imported}.` : `Adds ${n(imported)} next to the ${existing} you have.`
}

const ELEVATED_TEXT: Record<string, string> = {
  Bash: 'Runs commands',
  Edit: 'Edits files',
  Write: 'Edits files',
  NotebookEdit: 'Edits files',
  canSpawn: 'Can start other agents',
  mcp: "Keeps the replaced role's MCP access"
}

/** Visible wording for a role's elevated grants: deduplicated, only what is present, unknown values shown as-is. */
export function elevatedLabels(elevated: string[]): string[] {
  return [...new Set(elevated.map((e) => ELEVATED_TEXT[e] ?? e))]
}

/** The slug of the role an item reports to in the result, matched by slug, id or name; '' for the root. */
export function managerSlug(item: Pick<AgentImportItem, 'reportsTo'>, roles: Pick<Role, 'id' | 'slug' | 'name'>[]): string {
  if (!item.reportsTo) return ''
  const want = item.reportsTo.toLowerCase()
  const hit = roles.find((r) => r.slug.toLowerCase() === want || r.id === item.reportsTo || r.name.toLowerCase() === want)
  return hit?.slug ?? ''
}

/** "Imported 2 roles from Claude Code" / "from Claude Code and opencode". */
export function importedSummary(count: number, sources: AgentImportSource[]): string {
  const labels = [...new Set(sources.map(sourceLabel))]
  return `Imported ${count} role${count === 1 ? '' : 's'}${labels.length ? ` from ${joinWords(labels)}` : ''}.`
}

/** The banner that a folder holds agents the chart has not imported. */
export function notImportedLine(count: number, sources: { label: string }[]): string {
  const labels = [...new Set(sources.map((s) => s.label))]
  return `Found ${count} ${labels.length === 1 ? `${labels[0]} ` : ''}agent${count === 1 ? '' : 's'} not in this chart.`
}

export type BannerMemory = 'dismissed' | 'imported'

export const bannerKey = (projectId: string): string => `orgai.import-banner.${projectId}`

export function readBannerMemory(storage: Pick<Storage, 'getItem'> | undefined, projectId: string): BannerMemory | null {
  try {
    const v = storage?.getItem(bannerKey(projectId))
    return v === 'dismissed' || v === 'imported' ? v : null
  } catch {
    return null
  }
}

export function writeBannerMemory(storage: Pick<Storage, 'setItem'> | undefined, projectId: string, value: BannerMemory): void {
  try {
    storage?.setItem(bannerKey(projectId), value)
  } catch {
    /* storage unavailable: the banner just comes back next time */
  }
}

export function importBannerVisible(agentCount: number, memory: BannerMemory | null): boolean {
  return agentCount > 0 && memory === null
}

/**
 * Projects whose agent files were imported in this session. The scan (`scanAgents`) counts files and agents per source
 * but not which of them the team already holds, so "N found" cannot be recomputed after an import: the Start from menu
 * says "Imported" instead until the app restarts or the import is undone.
 */
const importedThisSession = new Set<string>()
export const markImported = (projectId: string): void => void importedThisSession.add(projectId)
export const unmarkImported = (projectId: string): void => void importedThisSession.delete(projectId)
export const wasImported = (projectId: string): boolean => importedThisSession.has(projectId)
