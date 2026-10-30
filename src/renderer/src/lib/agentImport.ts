import type { AgentImportAction, AgentImportChoice, AgentImportMode, AgentImportItem, AgentImportPreview, AgentImportSource, ProjectPathCheck, Role } from '@shared/types'
import { AGENT_IMPORT_SOURCE_LABELS } from '@shared/types'

/** What a new project does with the agent files found in its folder. */
export type SetupChoice = 'import' | 'architect' | 'default'

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

export function totalAgents(check: Pick<ProjectPathCheck, 'agentSources'> | null | undefined): number {
  return (check?.agentSources ?? []).reduce((n, s) => n + s.agentCount, 0)
}

function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "Found 2 Claude Code agents and AGENTS.md." or null when the folder has neither. */
export function foundLine(check: Pick<ProjectPathCheck, 'agentSources' | 'instructionFiles'> | null | undefined): string | null {
  if (!check) return null
  const parts = (check.agentSources ?? []).filter((s) => s.agentCount > 0).map((s) => `${s.agentCount} ${s.label} agent${s.agentCount === 1 ? '' : 's'}`)
  const docs = [...new Set((check.instructionFiles ?? []).map(baseName))]
  if (docs.length > 2) parts.push(`${docs.length} instruction files`)
  else parts.push(...docs)
  return parts.length ? `Found ${joinWords(parts)}.` : null
}

/** The choice in force: the user's pick, else Import when agents exist, else the old Architect checkbox. */
export function effectiveSetupChoice(hasAgents: boolean, picked: SetupChoice | null, architect: boolean): SetupChoice {
  if (hasAgents) return picked ?? 'import'
  return architect ? 'architect' : 'default'
}

export function setupSubmitLabel(choice: SetupChoice, busy: boolean): string {
  if (choice === 'import') return busy ? 'Creating…' : 'Create project and review import'
  if (choice === 'architect') return busy ? 'Scanning and starting the Architect…' : 'Create and start setup'
  return busy ? 'Creating…' : 'Create project'
}

export function importChoiceLabel(choice: SetupChoice, count: number): string {
  if (choice === 'import') return `Import the ${count} agent${count === 1 ? '' : 's'} (review first)`
  if (choice === 'architect') return 'Let the Architect set up (it sees the agents)'
  return 'Start with the default chart'
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
  const roles = `${count} role${count === 1 ? '' : 's'}`
  return mode === 'replace' ? `Replace chart with ${roles}` : `Import ${roles}`
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
