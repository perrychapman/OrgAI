import { BRANCH_NAME_PATTERN_MAX_CHARS, BRANCH_NAME_PATTERN_RE } from '@shared/types'

/**
 * Names of the report branches OrgAI creates (Project.branchNamePattern). Pure: no git, no file system.
 *
 * Today's name is `worktree-agent-<id>` (BRANCH_PREFIX in worktrees.ts). The branches OrgAI and the SDKs create
 * for reports all carry it, and worktrees.ts recognises a leftover copy by it, so a patterned name is only safe to
 * use where the worktree machinery also learns to find it (see the report of the change that added this file).
 */

/** Prefix of every report branch OrgAI and the SDKs create today. */
export const REPORT_BRANCH_PREFIX = 'worktree-agent-'

/** Longest slug a placeholder expands to. */
export const BRANCH_SLUG_MAX = 40
/** A branch name longer than this is not produced or deleted by OrgAI. */
export const BRANCH_NAME_MAX = 200

const PLACEHOLDERS = ['task', 'role', 'id'] as const
type Placeholder = (typeof PLACEHOLDERS)[number]

export interface BranchNameParts {
  /** The brief or task text; any string. */
  task?: string
  /** The role's slug or name. */
  role?: string
  /** The agent's short unique id (always part of the result). */
  id: string
}

/** Lower-case [a-z0-9-] only, runs of anything else become one '-', no leading or trailing '-', at most `max` characters. */
export function slugPart(raw: unknown, max: number = BRANCH_SLUG_MAX): string {
  if (typeof raw !== 'string') return ''
  const slug = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '')
  return slug
}

/**
 * The rules `git check-ref-format --branch` applies, plus the ones OrgAI adds (printable ASCII only, no leading '-').
 * True when `name` can be created as a local branch and cannot read as a git option or path trick.
 */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > BRANCH_NAME_MAX) return false
  if (!/^[\x21-\x7e]+$/.test(name)) return false // printable ASCII, no space, no control character, no DEL
  if (/[~^:?*[\\]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//') || name === '@') return false
  if (name.startsWith('/') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * Project.branchNamePattern, cleaned: the pattern (trimmed) when it is safe, else undefined (a pattern is dropped, never
 * repaired). Safe means: only BRANCH_NAME_PATTERN_RE characters, at most BRANCH_NAME_PATTERN_MAX_CHARS, no '..' or
 * '//', not starting with '/', '-' or '.', not ending with '/', '.' or '.lock', no path component that starts with '.'
 * or ends with '.lock', and no brace except as one of the placeholders {task}, {role}, {id}.
 */
export function cleanBranchNamePattern(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  if (!t || t.length > BRANCH_NAME_PATTERN_MAX_CHARS || !BRANCH_NAME_PATTERN_RE.test(t)) return undefined
  if (t.includes('..') || t.includes('//')) return undefined
  if (/^[/\-.]/.test(t) || /(?:\/|\.|\.lock)$/.test(t)) return undefined
  const stripped = t.replace(/\{(?:task|role|id)\}/g, '')
  if (/[{}]/.test(stripped)) return undefined
  if (t.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return undefined
  return t
}

function idSlug(id: unknown): string {
  return slugPart(id) || 'agent'
}

/** Today's name for a report branch. */
export function defaultBranchName(id: string): string {
  return `${REPORT_BRANCH_PREFIX}${idSlug(id)}`
}

/**
 * The name for a report branch. `pattern` is Project.branchNamePattern (untrusted: cleaned again here). {task}, {role}
 * and {id} become slugs of at most BRANCH_SLUG_MAX characters of [a-z0-9-] (a placeholder with nothing to show reads
 * "task" / "role"); `-<id>` is appended when the pattern has no {id}, so two reports never share a name. When there
 * is no usable pattern, or the result is not a valid branch name, the result is today's `worktree-agent-<id>`.
 */
export function branchNameFor(pattern: string | undefined, parts: BranchNameParts): string {
  const fallback = defaultBranchName(parts.id)
  const clean = cleanBranchNamePattern(pattern)
  if (!clean) return fallback
  const slugs: Record<Placeholder, string> = { task: slugPart(parts.task) || 'task', role: slugPart(parts.role) || 'role', id: idSlug(parts.id) }
  let name = clean.replace(/\{(task|role|id)\}/g, (_m, key: Placeholder) => slugs[key])
  if (!/\{id\}/.test(clean)) name = `${name}-${slugs.id}`
  return isValidBranchName(name) ? name : fallback
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
const MIN_LITERAL_HEAD = 3

/**
 * A matcher for the names branchNameFor makes from `pattern`, or null. Used to decide whether an existing branch is
 * an OrgAI report branch. Null when the pattern is unusable or when it starts with a placeholder or fewer than
 * MIN_LITERAL_HEAD literal characters: such a pattern would match the user's own branches (`{task}` matches almost any
 * lower-case name), and a destructive action must not rest on it.
 */
export function branchNameMatcher(pattern: string | undefined): RegExp | null {
  const clean = cleanBranchNamePattern(pattern)
  if (!clean) return null
  const head = clean.split('{')[0] ?? ''
  if (head.length < MIN_LITERAL_HEAD) return null
  const slug = `[a-z0-9-]{1,${BRANCH_SLUG_MAX}}`
  let source = ''
  let rest = clean
  for (;;) {
    const m = /\{(task|role|id)\}/.exec(rest)
    if (!m) break
    source += escapeRe(rest.slice(0, m.index)) + slug
    rest = rest.slice(m.index + m[0].length)
  }
  source += escapeRe(rest)
  if (!/\{id\}/.test(clean)) source += `-${slug}`
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return null
  }
}
