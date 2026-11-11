/**
 * The Team view's words (cli-parity 3.7): the project's SAVED roles as a reporting tree, one line per role, the role's
 * details, and the choices an edit offers. Pure: everything comes from the project, connections:list and models:list.
 * The words are the commands' own (roleSummaryLines, roleTree, resolveRole, labelFrom); edits go through the
 * commands' planners in teamRoleEdit.ts (see TeamView.tsx).
 */
import { effectiveRoleStaffing, projectConnection, roleConnection } from '../../shared/defaults'
import { EFFORTS, MODEL_TIERS, type ConnectionId, type ConnectionInfo, type ModelTier, type Project, type ProviderModel, type Role } from '../../shared/types'
import { contextText, resolveRole } from '../commands/models'
import { roleTree } from '../commands/org'
import { labelFrom, roleSummaryLines, type ModelEnv } from '../commands/teamRoleEdit'
import { clean, type PickOption } from './configUi'
import type { Seg } from './panes/lines'
import { textWidth, truncateEnd, wrapText } from './panes/text'

export interface TeamData {
  project: Project
  connections: ConnectionInfo[]
  /** models:list (every connected connection). */
  catalog: ProviderModel[]
}

export const modelEnvOf = (d: Pick<TeamData, 'connections' | 'catalog'>): ModelEnv => ({ connections: d.connections, catalog: d.catalog })

const tierMapOf = (d: Pick<TeamData, 'connections'>, c: ConnectionId): Partial<Record<ModelTier, string>> =>
  ({ ...(d.connections.find((i) => i.connection.id === c)?.connection.tierModels ?? {}) }) as Partial<Record<ModelTier, string>>

export interface TeamRow {
  id: string
  depth: number
  /** Tree prefix ("├─ ", "  └─ "). */
  prefix: string
  name: string
  /** "everyday" / "inherit" / an exact id. */
  tier: string
  /** The concrete model id the tier resolves to on the role's connection (undefined for inherit or an exact id). */
  modelId?: string
  effort: string
  /** Long and short staffing words ("auto, from fast up to deep" / "auto"). */
  staffing: string
  staffingShort: string
  /** "on LiteLLM" when the role runs on another connection than the project. */
  runsOn?: string
}

/** Staffing in words for a row: "as configured" or "auto, from fast up to deep, at most high". */
export function staffingRowWords(role: Role, project: Project): { long: string; short: string } {
  if (role.reportsTo === null) return { long: 'as configured (top)', short: 'fixed' }
  const eff = effectiveRoleStaffing(role, project)
  if (eff.mode === 'fixed') return { long: 'as configured', short: 'fixed' }
  const from = eff.minTier ? `from ${eff.minTier} ` : ''
  const top = eff.maxTier ? `up to ${eff.maxTier}` : 'up to its starter'
  return { long: `auto, ${from}${top}${eff.maxEffort ? `, at most ${eff.maxEffort}` : ''}`, short: 'auto' }
}

/** The roles in reporting order with what each row shows. */
export function teamRows(d: TeamData, branch = '├─ ', last = '└─ ', vert = '│  '): TeamRow[] {
  const { project } = d
  const tree = roleTree(project.roles)
  const label = labelFrom(modelEnvOf(d))
  const base = projectConnection(project)
  // lastAt[k]: whether the newest row at depth k is its parent's last report (no guide line below it).
  const lastAt: boolean[] = []
  return tree.map(({ role, depth }, i) => {
    const next = tree.slice(i + 1).find((t) => t.depth <= depth)
    const isLast = !next || next.depth < depth
    lastAt[depth] = isLast
    const guides = Array.from({ length: Math.max(0, depth - 1) }, (_, k) => (lastAt[k + 1] ? ' '.repeat(vert.length) : vert)).join('')
    const prefix = depth === 0 ? '' : `${guides}${isLast ? last : branch}`
    const r = resolveRole(role, project, (c) => tierMapOf(d, c), d.catalog)
    const on = roleConnection(role, project)
    const staffing = staffingRowWords(role, project)
    const tier = role.model === 'inherit' ? 'inherit' : (r.tier ?? clean(role.model, 120))
    return {
      id: role.id,
      depth,
      prefix,
      name: clean(role.name, 120),
      tier: clean(tier, 120),
      ...(role.model !== 'inherit' && r.tier ? { modelId: r.model === null ? 'unmapped' : clean(r.model, 120) } : {}),
      effort: role.effort ?? 'default',
      staffing: staffing.long,
      staffingShort: staffing.short,
      ...(on !== base ? { runsOn: `on ${label(on)}` } : {})
    }
  })
}

/**
 * One row cut to `width`, the least important part first: "runs on", then the staffing words shorten, the model id
 * goes, the effort goes, and only then is the name cut. The name column is `nameWidth` wide when it fits.
 */
export function teamRowSegs(row: TeamRow, width: number, nameWidth: number, sep: string, ellipsis: string, selected: boolean): Seg[] {
  const head = `${selected ? '> ' : '  '}${row.prefix}`
  const name = row.name
  // `nameWidth` is the column of tree guides plus name, so every row's details start in one column.
  nameWidth = Math.max(0, nameWidth - textWidth(row.prefix))
  const tierText = (withId: boolean): string => (withId && row.modelId ? `${row.tier} (${row.modelId})` : row.tier)
  const variants: string[][] = [
    [tierText(true), row.effort, row.staffing, ...(row.runsOn ? [row.runsOn] : [])],
    [tierText(true), row.effort, row.staffing],
    [tierText(true), row.effort, row.staffingShort],
    [tierText(false), row.effort, row.staffingShort],
    [tierText(false), row.effort],
    [tierText(false)]
  ]
  const pad = (n: string, w: number): string => (textWidth(n) >= w ? n : n + ' '.repeat(w - textWidth(n)))
  // Aligned columns first (any variant), then unaligned: a ragged column reads worse than shorter words.
  for (const nw of [Math.max(nameWidth, textWidth(name)), textWidth(name)]) {
    for (const v of variants) {
      const rest = v.join(sep)
      const total = textWidth(head) + nw + 2 + textWidth(rest)
      if (total <= width) {
        return [
          { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
          { text: pad(name, nw), bold: true },
          { text: `  ${rest}`, dim: !selected }
        ]
      }
    }
  }
  return [
    { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
    { text: truncateEnd(name, Math.max(1, width - textWidth(head)), ellipsis), bold: true }
  ]
}

const PROMPT_PREVIEW_LINES = 8

/** The details of one role: its description, the facts `orgai team role` prints, and the start of its prompt. */
export function roleDetailLines(d: TeamData, roleId: string, width: number): string[] {
  const role = d.project.roles.find((r) => r.id === roleId)
  if (!role) return ['This role is gone.']
  const label = labelFrom(modelEnvOf(d))
  const r = resolveRole(role, d.project, (c) => tierMapOf(d, c), d.catalog)
  const resolved = role.model === 'inherit' ? 'inherits the model of the agent that starts it' : r.model === null ? 'no model is mapped to this tier on its connection' : `${clean(r.model, 120)}${r.fallbackTier ? ` (the ${r.fallbackTier} tier's model: ${r.tier} is unmapped)` : ''}${r.contextWindow ? `, ${contextText(r.contextWindow)} context` : ''}`
  const w = Math.max(10, width)
  const wrap = (s: string, indent = ''): string[] => wrapText(s, w - indent.length).map((l) => indent + l)
  const desc = clean(role.description, 2000)
  const prompt = (role.prompt ?? '').split('\n')
  const preview = prompt.slice(0, PROMPT_PREVIEW_LINES).flatMap((l) => (l.trim() === '' ? [''] : wrap(clean(l, 1000), '    ')))
  return [
    ...(desc ? wrap(desc) : []),
    '',
    ...roleSummaryLines(role, d.project, label).flatMap((l) => wrap(l.trimStart(), '  ')),
    ...wrap(`resolves to: ${resolved}`, '  '),
    '',
    `  Prompt (${role.prompt.length} characters${prompt.length > PROMPT_PREVIEW_LINES ? `, first ${PROMPT_PREVIEW_LINES} lines` : ''}):`,
    ...preview
  ]
}

/** The model choices for a role: the tiers of its connection (with the id each maps to), inherit, then the catalog. */
export function modelOptions(d: TeamData, roleId: string): PickOption[] {
  const role = d.project.roles.find((r) => r.id === roleId)
  if (!role) return []
  const c = roleConnection(role, d.project)
  const tiers = tierMapOf(d, c)
  const catalog = d.catalog.filter((m) => m.connection === c)
  return [
    ...MODEL_TIERS.map((t) => ({ value: t, label: `${t}${role.tier === t && role.model !== 'inherit' ? ' (current)' : ''}`, detail: tiers[t] ? clean(tiers[t], 120) : 'unmapped on this connection' })),
    { value: 'inherit', label: `inherit${role.model === 'inherit' ? ' (current)' : ''}`, detail: 'the model of the agent that starts it' },
    ...catalog.map((m) => ({
      value: m.id,
      label: `${clean(m.id, 120)}${role.model === m.id && !role.tier ? ' (current)' : ''}`,
      detail: [m.label && m.label !== m.id ? clean(m.label, 60) : '', m.contextWindow ? `${contextText(m.contextWindow)} context` : '', m.source ?? ''].filter(Boolean).join(', ')
    }))
  ]
}

export const effortOptions = (role: Role | undefined): PickOption[] => [
  { value: 'none', label: `default${role && !role.effort ? ' (current)' : ''}`, detail: "the model's own default" },
  ...EFFORTS.map((e) => ({ value: e, label: `${e}${role?.effort === e ? ' (current)' : ''}` }))
]

export const staffingModeOptions = (role: Role | undefined): PickOption[] => {
  const own = role?.staffing?.mode
  return [
    { value: 'inherit', label: `follow the project${role && !own ? ' (current)' : ''}`, detail: 'automatic unless the project is set to fixed' },
    { value: 'auto', label: `automatic${own === 'auto' ? ' (current)' : ''}`, detail: 'the starter picks a tier and effort within bounds' },
    { value: 'fixed', label: `always as configured${own === 'fixed' ? ' (current)' : ''}`, detail: 'its own tier and effort every time' }
  ]
}

export const minTierOptions = (role: Role | undefined): PickOption[] => [
  { value: 'none', label: 'no lower bound', detail: role?.staffing?.minTier ? '' : '(current)' },
  ...[...MODEL_TIERS].reverse().map((t) => ({ value: t, label: `at least ${t}${role?.staffing?.minTier === t ? ' (current)' : ''}` }))
]

export const maxEffortOptions = (role: Role | undefined): PickOption[] => [
  { value: 'none', label: 'the role effort (or high)', detail: role?.staffing?.maxEffort ? '' : '(current)' },
  ...EFFORTS.map((e) => ({ value: e, label: `at most ${e}${role?.staffing?.maxEffort === e ? ' (current)' : ''}` }))
]

/** Roles that may become `roleId`'s manager: not itself and not one of its reports (planRoleMove re-checks). */
export function managerOptions(project: Project, roleId: string): PickOption[] {
  const under = (id: string): boolean => {
    const seen = new Set<string>()
    let cur: string | null = id
    while (cur && !seen.has(cur)) {
      if (cur === roleId) return true
      seen.add(cur)
      cur = project.roles.find((r) => r.id === cur)?.reportsTo ?? null
    }
    return false
  }
  const me = project.roles.find((r) => r.id === roleId)
  return roleTree(project.roles)
    .filter(({ role }) => !under(role.id))
    .map(({ role, depth }) => ({ value: role.id, label: `${'  '.repeat(depth)}${clean(role.name, 120)}${me?.reportsTo === role.id ? ' (current)' : ''}` }))
}
