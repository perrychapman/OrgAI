/** Plain-language groups over TOOL_CATALOG for the role editor ("What it can use" > Tools). Pure. */

export type ToolGroupId = 'read' | 'change' | 'run' | 'web' | 'plan' | 'other'

export interface ToolGroupDef {
  id: ToolGroupId
  label: string
  description: string
  /** Fixed members. `other` has none: it takes what no group names. */
  tools: readonly string[]
  elevated: boolean
  /** Chip text for elevated groups. */
  chip?: string
  /** Phrase used in the collapsed sentence ("Can <phrase>"). */
  phrase: string
}

export const TOOL_GROUPS: readonly ToolGroupDef[] = [
  { id: 'read', label: 'Read files', description: 'Look at files and search the project.', tools: ['Read', 'Glob', 'Grep'], elevated: false, phrase: 'read files' },
  {
    id: 'change',
    label: 'Change files',
    description: 'Create, edit and overwrite files.',
    tools: ['Edit', 'Write', 'NotebookEdit'],
    elevated: true,
    chip: 'Can change files',
    phrase: 'change files'
  },
  {
    id: 'run',
    label: 'Run commands',
    description: 'Run commands in a shell on this computer.',
    tools: ['Bash'],
    elevated: true,
    chip: 'Can run commands',
    phrase: 'run commands'
  },
  { id: 'web', label: 'Browse the web', description: 'Search the web and fetch pages.', tools: ['WebSearch', 'WebFetch'], elevated: false, phrase: 'browse the web' },
  {
    id: 'plan',
    label: 'Plan and message',
    description: 'Keep a to-do list and message other running agents.',
    tools: ['TodoWrite', 'SendMessage', 'ListAgents'],
    elevated: false,
    phrase: 'plan and message'
  }
]

export interface ToolGroup extends ToolGroupDef {
  /** Members present in the catalog, in catalog order. */
  members: string[]
}

const OTHER: ToolGroupDef = {
  id: 'other',
  label: 'Other tools',
  description: 'Tools with no plain-language group. Check what each does before turning it on.',
  tools: [],
  elevated: true,
  chip: 'Can use other tools',
  phrase: 'use other tools'
}

/**
 * The groups with their members resolved against the catalog, plus `other`: catalog tools no group names and the
 * role's own tools outside the catalog, by raw name. `other` is elevated, so an unknown tool never reads as harmless.
 */
export function resolveGroups(catalog: readonly string[], roleTools: readonly string[] = []): ToolGroup[] {
  const named = new Set(TOOL_GROUPS.flatMap((g) => g.tools))
  const other = [...catalog.filter((t) => !named.has(t)), ...roleTools.filter((t) => !named.has(t) && !catalog.includes(t))]
  return [...TOOL_GROUPS.map((g) => ({ ...g, members: catalog.filter((t) => g.tools.includes(t)) })), { ...OTHER, members: [...new Set(other)] }]
}

export type GroupState = 'on' | 'off' | 'mixed'

export function groupState(group: Pick<ToolGroup, 'members'>, tools: readonly string[]): GroupState {
  if (group.members.length === 0) return 'off'
  const n = group.members.filter((t) => tools.includes(t)).length
  return n === 0 ? 'off' : n === group.members.length ? 'on' : 'mixed'
}

/** Ticking a group that is on turns all of it off; off or mixed turns all of it on. Tools outside the group are kept. */
export function toggleGroup(group: Pick<ToolGroup, 'members'>, tools: readonly string[]): string[] {
  if (groupState(group, tools) === 'on') return tools.filter((t) => !group.members.includes(t))
  return [...tools, ...group.members.filter((t) => !tools.includes(t))]
}

export interface SummaryPart {
  text: string
  elevated: boolean
}

/** The groups that are on or mixed, as phrases, in group order. */
export function summaryParts(groups: readonly ToolGroup[], tools: readonly string[]): SummaryPart[] {
  return groups.filter((g) => groupState(g, tools) !== 'off').map((g) => ({ text: g.phrase, elevated: g.elevated }))
}

/** "Can read files, change files and run commands." or the no-tools sentence. */
export function summarySentence(groups: readonly ToolGroup[], tools: readonly string[]): string {
  const parts = summaryParts(groups, tools).map((p) => p.text)
  if (parts.length === 0) return 'No tools. It can only answer from what it is told.'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Can ${list}.`
}
