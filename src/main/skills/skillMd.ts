import { SKILL_BODY_MAX_CHARS, type SkillDraft } from '@shared/types'
import { skillDescriptionProblem, skillNameProblem } from '@shared/defaults'
import { parseFrontmatter } from '../setup/import/frontmatter'

/** SKILL.md: YAML frontmatter (name, description) + blank line + markdown body. Pure; nothing here throws on input text. */

/** A description as one line: control characters and whitespace runs become single spaces. */
export function normalizeDescription(description: string): string {
  // eslint-disable-next-line no-control-regex
  return description.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim()
}

/** Why a body is refused when it uses Claude Code's dynamic shell injection, or null. */
export const SHELL_INJECTION_REASON = 'Runs shell commands when loaded (!`...`), which OrgAI does not allow.'

/** Claude Code runs !`command` inline and ```! fenced blocks when a skill loads. Linear: no nested quantifiers. */
export function shellInjectionProblem(body: string): string | null {
  if (/!`[^`\n]*`/.test(body) || /^[ \t]*(?:`{3,}|~{3,})!/m.test(body)) return SHELL_INJECTION_REASON
  return null
}

/**
 * The first problem with a draft (name, description, body), or null. Non-string fields are a problem too; the
 * description is checked after normalizeDescription so the stored text is what was validated.
 */
export function draftProblem(draft: unknown): string | null {
  if (!draft || typeof draft !== 'object') return 'A skill needs a name, a description and instructions.'
  const d = draft as Partial<SkillDraft>
  if (typeof d.name !== 'string') return skillNameProblem(undefined)
  const name = skillNameProblem(d.name.trim())
  if (name) return name
  if (typeof d.description !== 'string') return skillDescriptionProblem(undefined)
  const desc = skillDescriptionProblem(normalizeDescription(d.description))
  if (desc) return desc
  if (typeof d.body !== 'string') return 'A skill needs instructions.'
  if (d.body.length > SKILL_BODY_MAX_CHARS) return `The instructions have at most ${SKILL_BODY_MAX_CHARS.toLocaleString('en-US')} characters.`
  return shellInjectionProblem(d.body)
}

/** The draft as it will be stored (trimmed name, one-line description). Throws the readable problem. */
export function validDraft(draft: unknown): SkillDraft {
  const problem = draftProblem(draft)
  if (problem) throw new Error(problem)
  const d = draft as SkillDraft
  return { name: d.name.trim(), description: normalizeDescription(d.description), body: d.body }
}

/** SKILL.md text for a valid draft. Only name and description are written: any other frontmatter key is dropped. The description is JSON-quoted, which is valid YAML for any one-line string. */
export function composeSkillMd(draft: SkillDraft): string {
  const body = draft.body.replace(/\r\n?/g, '\n')
  return `---\nname: ${draft.name}\ndescription: ${JSON.stringify(draft.description)}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

export interface ParsedSkillMd {
  name: unknown
  description: unknown
  body: string
  /** The frontmatter parser's complaint, if any (the fields it did read are still given). */
  error?: string
  /** Frontmatter keys other than name and description (OrgAI never stores them). */
  dropped: string[]
}

/** Reads the frontmatter name and description and the body. Never throws; linear in the text (line length capped). */
export function parseSkillMd(text: string): ParsedSkillMd {
  const fm = parseFrontmatter(text)
  const out: ParsedSkillMd = { name: fm.data.name ?? undefined, description: fm.data.description ?? undefined, body: fm.body, dropped: Object.keys(fm.data).filter((k) => k !== 'name' && k !== 'description').slice(0, 20).map((k) => k.replace(/[^\w.-]/g, '?').slice(0, 40)) }
  if (fm.error) out.error = fm.error
  return out
}

export type SkillMdResult = { ok: true; name: string; description: string; body: string; notes: string[] } | { ok: false; reason: string }

/**
 * Validates the SKILL.md of a folder named `folderName`. The name defaults to the folder name; a different present
 * name is fine (noted). Descriptions in YAML block style are folded to one line.
 */
export function skillFromMd(text: string, folderName: string): SkillMdResult {
  const p = parseSkillMd(text)
  const notes: string[] = []
  let name: unknown = p.name
  if (name === undefined) name = folderName
  else if (typeof name === 'string') name = name.trim()
  const nameProblem = skillNameProblem(name)
  if (nameProblem) return { ok: false, reason: `${nameProblem}${p.name === undefined ? ` (from the folder name "${folderName}")` : ''}` }
  const rawDesc = p.description
  if (typeof rawDesc !== 'string') {
    return { ok: false, reason: `${skillDescriptionProblem(undefined)}${p.error ? ` (frontmatter: ${p.error})` : ''}` }
  }
  const description = normalizeDescription(rawDesc)
  const descProblem = skillDescriptionProblem(description)
  if (descProblem) return { ok: false, reason: descProblem }
  if (p.body.length > SKILL_BODY_MAX_CHARS) return { ok: false, reason: `The instructions have more than ${SKILL_BODY_MAX_CHARS.toLocaleString('en-US')} characters.` }
  const injection = shellInjectionProblem(p.body)
  if (injection) return { ok: false, reason: injection }
  if (p.name !== undefined && name !== folderName) notes.push(`The folder is "${folderName}" but the skill is named "${String(name)}".`)
  if (p.dropped.length) notes.push(`Dropped frontmatter keys: ${p.dropped.join(', ')}.`)
  return { ok: true, name: name as string, description, body: p.body, notes }
}
