import type { SkillDraft, SkillProposalItem } from '@shared/types'
import { clampLabel } from './clampLabel'
import type { BadgeTone } from '../components/ui/Badge'


/** What the view reads from an item (a SkillProposalItem satisfies it). */
export interface SkillRowItem {
  action: SkillProposalItem['action']
  scope: 'library' | 'project'
  draft: Pick<SkillDraft, 'name'> & Partial<SkillDraft>
  /** Role slugs that load it after approval (project scope). */
  roles?: string[]
  /** 'grant': turn the project skill on or off; unset keeps it. */
  enabled?: boolean
}

/** The project as it is now: who loads which skill. */
export interface SkillCurrent {
  roles: readonly { id: string; slug: string; name: string; skills?: readonly string[] }[]
  skills: readonly { id: string; name: string; libraryId?: string }[]
}

export type SkillGroup = 'create' | 'link' | 'grant' | 'update' | 'remove'

export interface SkillRowView {
  group: SkillGroup
  badge: { text: string; tone: BadgeTone }
  /** Main line under the head; null when the head already says it. */
  line1: string | null
  /** The "Who loads it" / grant / removal line; null when there is nothing to say. */
  line2: string | null
  note: string | null
  /** "Turned off for now" / "On" when the item sets enabled; null otherwise. */
  stateLine: string | null
  /** Show the instructions disclosure (hidden for grant and remove). */
  showBody: boolean
  /** Offer a before / after view of the instructions. */
  showChanges: boolean
}

export const SKILL_GROUP_ORDER: readonly SkillGroup[] = ['create', 'link', 'grant', 'update', 'remove']


const NO_ROLE = 'no role yet'

function names(slugs: readonly string[], roles: SkillCurrent['roles']): string[] {
  const out: string[] = []
  for (const slug of slugs) {
    const r = roles.find((x) => x.slug === slug)
    if (r) {
      const n = clampLabel(r.name, 40)
      if (!out.includes(n)) out.push(n)
    }
  }
  return out
}

/** Slugs of the roles that load the project skill called `name` now; null when the project has no such skill. */
export function currentLoaderSlugs(name: string, current: SkillCurrent): string[] | null {
  const skill = current.skills.find((s) => s.name === name)
  if (!skill) return null
  return current.roles.filter((r) => r.skills?.includes(skill.id)).map((r) => r.slug)
}

function list(slugs: readonly string[], roles: SkillCurrent['roles'], empty: string): string {
  const n = names(slugs, roles)
  return n.length > 0 ? n.join(', ') : empty
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

/** Join "A, B and C" for a removal sentence. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** How one skills item reads on the card (docs/design/ux-review-proposals-in-runs.md, "How link / grant / remove skill items should read"). */
export function skillRowView(item: SkillRowItem, current: SkillCurrent): SkillRowView {
  const name = clampLabel(item.draft.name, 64)
  const project = item.scope === 'project'
  const now = project ? currentLoaderSlugs(item.draft.name, current) : null
  const proposed = item.roles ?? now ?? []
  const whoLoads = project ? `Who loads it: ${list(proposed, current.roles, NO_ROLE)}` : null
  const stateLine = item.enabled === undefined ? null : item.enabled ? 'On' : 'Turned off for now'
  switch (item.action) {
    case 'link':
      return {
        group: 'link',
        badge: { text: 'From library', tone: 'info' },
        line1: `Use ${name} from your library in this project`,
        line2: whoLoads,
        note: 'Kept in sync with the library; edit it there.',
        stateLine,
        showBody: false,
        showChanges: false
      }
    case 'grant': {
      const before = now ?? []
      const after = item.roles ?? before
      const adds = after.filter((s) => !before.includes(s))
      const drops = before.filter((s) => !after.includes(s))
      const keeps = after.filter((s) => before.includes(s))
      const parts: string[] = []
      const add = names(adds, current.roles)
      const drop = names(drops, current.roles)
      const keep = names(keeps, current.roles)
      if (add.length) parts.push(`Adds: ${add.join(', ')}.`)
      if (drop.length) parts.push(`Removes: ${drop.join(', ')}.`)
      if (keep.length) parts.push(`Keeps: ${keep.join(', ')}.`)
      return {
        group: 'grant',
        badge: { text: 'Access', tone: 'warning' },
        line1: `Change who loads ${name}`,
        line2: item.roles === undefined ? 'Role access unchanged.' : parts.length > 0 ? parts.join(' ') : 'No role loads it before or after.',
        note: 'Instructions unchanged.',
        stateLine,
        showBody: false,
        showChanges: false
      }
    }
    case 'remove': {
      const holders = names(now ?? [], current.roles)
      const linked = current.skills.find((s) => s.name === item.draft.name)?.libraryId
      return {
        group: 'remove',
        badge: { text: 'Remove', tone: 'danger' },
        line1: `Remove ${name} from ${project ? 'this project' : 'your library'}`,
        line2: project ? (holders.length > 0 ? `${andList(holders)} will no longer load it.` : 'No role loads it now.') : 'Projects that link it lose it.',
        note: linked ? 'Unlinks it; the library entry stays.' : null,
        stateLine,
        showBody: false,
        showChanges: false
      }
    }
    case 'update': {
      let line2 = whoLoads
      if (project && now && item.roles && !sameSet(item.roles, now)) line2 = `${whoLoads} (was ${list(now, current.roles, 'no role')})`
      // No new body means the instructions stay as they are: nothing to diff or show.
      const hasBody = !!item.draft.body
      return {
        group: 'update',
        badge: { text: 'Changed', tone: 'warning' },
        line1: hasBody ? 'Instructions changed' : 'Instructions unchanged',
        line2,
        note: !project ? 'Compare it in the Skill library.' : null,
        stateLine,
        showBody: hasBody,
        showChanges: hasBody && project
      }
    }
    default:
      return {
        group: 'create',
        badge: { text: 'New', tone: 'success' },
        line1: null,
        line2: whoLoads,
        note: null,
        stateLine,
        showBody: true,
        showChanges: false
      }
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export interface SkillsDiff<T extends SkillRowItem> {
  /** Items in group order (New, Link, Access, Update, Remove), each with its view. */
  rows: { item: T; view: SkillRowView }[]
  /** Project skills the proposal does not touch (null when it also targets the library, where the list is unknown). */
  untouched: string[] | null
  summary: string
}

/** "1 new, 1 linked, 1 access change, 1 changed, 1 removed; 3 skills unchanged" (zero parts left out). */
export function diffSkillsProposal<T extends SkillRowItem>(items: readonly T[], current: SkillCurrent): SkillsDiff<T> {
  const all = items.map((item) => ({ item, view: skillRowView(item, current) }))
  const rows = SKILL_GROUP_ORDER.flatMap((g) => all.filter((r) => r.view.group === g))
  const count = (g: SkillGroup): number => rows.filter((r) => r.view.group === g).length
  const parts: string[] = []
  if (count('create')) parts.push(`${count('create')} new`)
  if (count('link')) parts.push(`${count('link')} linked`)
  if (count('grant')) parts.push(plural(count('grant'), 'access change', 'access changes'))
  if (count('update')) parts.push(`${count('update')} changed`)
  if (count('remove')) parts.push(`${count('remove')} removed`)
  const projectOnly = items.every((i) => i.scope === 'project')
  const touched = new Set(items.map((i) => i.draft.name))
  const untouched = projectOnly ? current.skills.filter((s) => !touched.has(s.name)).map((s) => clampLabel(s.name)) : null
  let summary = parts.join(', ')
  if (untouched && untouched.length > 0) summary += `${summary ? '; ' : ''}${plural(untouched.length, 'skill', 'skills')} unchanged`
  return { rows, untouched, summary: summary || 'No changes' }
}

/** Fold-summary verb: "new release-notes", "update mock-skill", "link x", "access to x", "remove x". */
export function skillRowVerb(item: SkillRowItem, view: SkillRowView): string {
  const name = clampLabel(item.draft.name, 40)
  switch (view.group) {
    case 'create':
      return `new ${name}`
    case 'link':
      return `link ${name}`
    case 'grant':
      return `access to ${name}`
    case 'update':
      return `update ${name}`
    default:
      return `remove ${name}`
  }
}
