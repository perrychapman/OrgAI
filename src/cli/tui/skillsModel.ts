/**
 * The /skills view's words: the project's skills, one line per skill, one skill's details and its text, and the role
 * ticks an edit offers. Pure: everything comes from projects:get (its roles) and skills:list, plus skillLibrary:list for
 * "add one from your library" and skills:read for the text. A skill's grants are role IDS, and the set is complete: an
 * update replaces it, so a skill no role holds (or that is off) reaches no agent.
 */
import type { Project, Role, SkillContent, SkillInfo, SkillLibraryInfo } from '../../shared/types'
import { clean, type PickOption } from './configUi'
import { sanitizeTty } from './sanitizeTty'
import type { Seg } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'

export interface SkillsData {
  project: Project
  /** skills:list. */
  skills: SkillInfo[]
}

export interface SkillRow {
  id: string
  name: string
  /** on = passed to runs; off = kept in the list only. */
  state: 'on' | 'off'
  /** "no role" / "Lead, Dev" / "3 roles" (only this project's roles are counted). */
  roles: string
  /** What to watch out for, in this order: the library entry is gone, no role of this project holds it. */
  flags: string[]
}

const byName = (a: string, b: string): number => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** The roles of this project that hold the skill, in the project's role order (a granted id of a role this project no longer has is ignored). */
const heldRoles = (project: Project, grantedTo: readonly string[]): Role[] => {
  const ids = Array.isArray(grantedTo) ? grantedTo : []
  return project.roles.filter((r) => ids.includes(r.id))
}

/** The granted ids that are roles of this project, in the project's role order. */
export function grantedInProject(project: Project, grantedTo: string[]): string[] {
  return heldRoles(project, grantedTo).map((r) => r.id)
}

/** One row per skill, by name: its state, which roles hold it and what to watch out for. */
export function skillRows(data: SkillsData): SkillRow[] {
  return data.skills
    .map((info): SkillRow => {
      const spec = info.spec
      const held = heldRoles(data.project, info.grantedTo)
      return {
        id: spec.id,
        name: clean(spec.name, 120),
        state: spec.enabled ? 'on' : 'off',
        // Two roles or fewer are named; more are counted. A grant list of roles this project no longer has holds nothing.
        roles: held.length === 0 ? 'no role' : held.length <= 2 ? held.map((r) => clean(r.name, 80)).join(', ') : `${held.length} roles`,
        flags: [...(info.libraryMissing ? ['library entry gone'] : []), ...(held.length === 0 ? ['no agent can load it'] : [])]
      }
    })
    .sort((a, b) => byName(a.name, b.name))
}

/**
 * One row cut to `width`, the least important part first: the flags go, then who holds it, and only then is the name
 * cut. The name column is `nameWidth` wide when it fits. The selected row stands out (accent, bold); a skill that is off
 * reads dim, and its flags read as a warning.
 */
export function skillRowSegs(row: SkillRow, width: number, nameWidth: number, sep: string, ellipsis: string, selected: boolean): Seg[] {
  const head = selected ? '> ' : '  '
  const name = row.name
  const variants: { parts: string[]; flags: string[] }[] = [
    { parts: [row.state, row.roles], flags: row.flags },
    { parts: [row.state, row.roles], flags: [] },
    { parts: [row.state], flags: [] }
  ]
  const pad = (s: string, w: number): string => (textWidth(s) >= w ? s : s + ' '.repeat(w - textWidth(s)))
  // Aligned columns first (any variant), then unaligned: a ragged column reads worse than shorter words.
  for (const nw of [Math.max(nameWidth, textWidth(name)), textWidth(name)]) {
    for (const v of variants) {
      const rest = v.parts.join(sep)
      const tail = v.flags.length ? `${sep}${v.flags.join(sep)}` : ''
      const total = textWidth(head) + nw + 2 + textWidth(rest) + textWidth(tail)
      if (total <= width) {
        return [
          { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
          { text: pad(name, nw), bold: true, ...(row.state === 'off' && !selected ? { dim: true } : {}) },
          { text: `  ${rest}`, dim: !selected },
          ...(tail ? [{ text: tail, tone: 'warn' as const }] : [])
        ]
      }
    }
  }
  return [
    { text: head, ...(selected ? { tone: 'accent' as const, bold: true } : {}) },
    { text: truncateEnd(name, Math.max(1, width - textWidth(head)), ellipsis), bold: true, ...(row.state === 'off' ? { dim: true } : {}) }
  ]
}

/** The body of a SKILL.md: at most 40 lines, each cut to 300 characters, with the rest counted. */
const bodyLines = (content: SkillContent): string[] => {
  const body = typeof content.body === 'string' ? content.body : ''
  const lines = body.split(/\r?\n/)
  const shown = lines.slice(0, 40)
  return [...shown.map((l) => clean(l, 300)), ...(lines.length > shown.length ? [`... (${lines.length - shown.length} more lines)`] : [])]
}

/**
 * What one skill is: its facts, its files, its description, then its text (at most 40 lines of the body). Plain lines;
 * the view cuts them to the width. Without the text yet it ends with `Loading the text...`; when the read failed,
 * with `The text could not be read.`
 */
export function skillDetailLines(data: SkillsData, skillId: string, content: SkillContent | 'failed' | undefined): string[] {
  const info = data.skills.find((s) => s.spec.id === skillId)
  if (!info) return ['This skill is gone.']
  const spec = info.spec
  const held = heldRoles(data.project, info.grantedTo)
  const files = Array.isArray(spec.files) ? spec.files : []
  const shown = files.slice(0, 20)
  return [
    clean(spec.name, 120),
    `state: ${spec.enabled ? 'on' : 'off'}`,
    `granted to: ${held.length ? held.map((r) => clean(r.name, 80)).join(', ') : 'no role'}`,
    `source: ${spec.libraryId ? `library entry ${clean(spec.libraryId, 120)}` : 'this project'}`,
    `files: ${files.length}`,
    ...shown.map((f) => `  ${clean(f.path, 200)}`),
    ...(files.length > shown.length ? [`  ... and ${files.length - shown.length} more`] : []),
    '',
    clean(spec.description, 1000),
    ...(content === undefined ? ['Loading the text...'] : content === 'failed' ? ['The text could not be read.'] : ['', 'SKILL.md', ...bodyLines(content)])
  ]
}

/** The roles to tick for `r`: one per role of the project (by id). */
export function skillRoleOptions(project: Project): PickOption[] {
  return project.roles.map((r) => ({ value: r.id, label: clean(r.name, 120) }))
}

/** What a skill's state lets runs reach: on or off, and the ids of the roles that hold it. */
export interface SkillReach {
  enabled: boolean
  roleIds: readonly string[]
}

/**
 * Whether going from `before` to `after` gives MORE agents the skill: it is turned on, or at least one role of this
 * project gains it. Removing a grant or turning it off never widens. Pure.
 */
export function skillWidens(project: Project, before: SkillReach, after: SkillReach): boolean {
  if (!before.enabled && after.enabled) return true
  const had = new Set(grantedInProject(project, [...before.roleIds]))
  return grantedInProject(project, [...after.roleIds]).some((id) => !had.has(id))
}

/** One untrusted value for the terminal, sanitized and whitespace-folded but never cut. */
const whole = (s: unknown): string => sanitizeTty(typeof s === 'string' ? s : String(s ?? '')).replace(/\s+/g, ' ').trim()

/** How many lines of SKILL.md the confirmation shows. */
export const SKILL_CONFIRM_BODY_LINES = 12

/**
 * The lines of the confirmation before a widening save: name, source, the files, who gets it and the first lines of
 * SKILL.md. `content` is the text as read (skills:read, or skillLibrary:read for a library entry); a caller whose read
 * failed opens no confirmation at all (fail closed). Sanitized; the file list is the skill's own, counted.
 */
export function skillConfirmLines(
  spec: { name: string; description?: string; files?: readonly { path: string }[]; libraryId?: string },
  headline: string,
  grantedTo: string,
  content: SkillContent,
  source?: string
): string[] {
  const files = Array.isArray(spec.files) ? spec.files : []
  const lib = source ?? spec.libraryId
  const out: string[] = [whole(headline), '', `name: ${whole(spec.name)}`, `source: ${lib ? `library entry ${whole(lib)}` : 'this project'}`, `granted to: ${whole(grantedTo)}`]
  out.push(files.length ? `files (${files.length}):` : 'files: none listed')
  for (const f of files.slice(0, 20)) out.push(`  ${whole(f.path)}`)
  if (files.length > 20) out.push(`  and ${files.length - 20} more`)
  if (spec.description) out.push(`description: ${whole(spec.description)}`)
  const body = typeof content.body === 'string' ? content.body : ''
  const lines = body.split(/\r?\n/)
  out.push('', 'SKILL.md (first lines):')
  for (const l of lines.slice(0, SKILL_CONFIRM_BODY_LINES)) out.push(`  ${whole(l)}`)
  if (lines.length > SKILL_CONFIRM_BODY_LINES) out.push(`  and ${lines.length - SKILL_CONFIRM_BODY_LINES} more lines`)
  out.push('', 'Press y to save. Any other key cancels and saves nothing.')
  return out
}

/** The library entries this project does not link yet, by name. */
export function skillLibraryOptions(library: SkillLibraryInfo[], skills: SkillInfo[]): PickOption[] {
  const linked = new Set(skills.map((s) => s.spec.libraryId).filter((id): id is string => typeof id === 'string' && id !== ''))
  return library
    .filter((info) => !linked.has(info.entry.id))
    .sort((a, b) => byName(clean(a.entry.name, 120), clean(b.entry.name, 120)))
    .map((info) => ({ value: info.entry.id, label: clean(info.entry.name, 120), detail: clean(info.entry.description ?? '', 300) }))
}
