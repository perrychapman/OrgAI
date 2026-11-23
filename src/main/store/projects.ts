import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, win32, type PlatformPath } from 'node:path'
import type { AppSettings, ConnectionId, Project, ProjectCreateInput, ProjectPathCheck, Role } from '@shared/types'
import { hiddenCharIn } from '../capabilities/sanitize'
import { HARNESS_PROJECT_ID, PROJECT_CLIENT_MAX_CHARS, PROJECT_MAX_AGENTS_PER_RUN_LIMIT, PROJECT_TEST_COMMAND_MAX_CHARS, ROLE_MAX_CONCURRENT_LIMIT, PROJECT_ALLOWED_DIRECTORIES_MAX, PROJECT_ALLOWED_DIRECTORY_MAX_CHARS, isModelTier, isProjectKind, isReviewPolicy, isStaffingGoal, isStaffingMode, isVirtualProjectId } from '@shared/types'
import { cleanRequiredReports, cleanRoleStaffing, isConnectionId, isSafeId, modelForTier, newProject, preferEverydayNearLimit, projectConnection, storedSkillEvaluation, teamReviewOf, type TierContext } from '@shared/defaults'
import { migrateProject } from '../connections/remap'
import { validModelId } from '../connections/codexAccount'
import { isInsideEither, pathKey, samePath } from '../quick/scratch'
import { allowedDirectoryRisk } from '../runtime/allowedDirectories'
import { cleanBranchNamePattern } from '../runtime/branchNames'
import { cleanFolderConfigTrust, initialFolderConfigTrust } from '../runtime/folderConfigTrust'
import { homedir } from 'node:os'

/** The tier mapping of a connection, for the invalid-model fallback. Default: the connection's builtin catalog only. */
export type TierContextFor = (connection: ConnectionId) => TierContext | undefined

/** Invalid model values already logged (at most INVALID_MODEL_LOG_MAX), so a value is logged once per process. */
const loggedInvalidModels = new Set<string>()
const INVALID_MODEL_LOG_MAX = 200

/** Whether a stored Role.model is acceptable: missing or empty, 'inherit', a tier name, or a valid model id. */
export function acceptableRoleModel(model: unknown): boolean {
  if (model === undefined || model === null || model === '') return true
  if (typeof model !== 'string') return false
  return model === 'inherit' || isModelTier(model) || validModelId(model)
}

/**
 * Replace every Role.model that fails acceptableRoleModel (a hand-edited projects.json or a compromised renderer could
 * store '--some-cli-flag', which would become the CLI's --model argument): the role's tier through the project's
 * connection (modelForTier), else 'inherit'. Logs once per invalid value, never echoing it. Pure apart from the log.
 */
export function sanitizeRoleModels(
  project: Project,
  tierContext?: TierContextFor,
  log: (message: string) => void = (m) => console.warn(m)
): { project: Project; changed: boolean } {
  if (!project || !Array.isArray(project.roles)) return { project, changed: false }
  let changed = false
  const roles = project.roles.map((role): Role => {
    // Role.connection stays as saved when it names a connection id; anything else is dropped (never resolved or filled).
    if (role && typeof role === 'object' && Object.hasOwn(role, 'connection') && !(typeof role.connection === 'string' && isConnectionId(role.connection))) {
      const { connection: _drop, ...rest } = role
      role = rest as Role
      changed = true
    }
    // Role.requiredReports stays within the role's spawnable list (a hand-edited file or an older save may not).
    if (role && typeof role === 'object' && Object.hasOwn(role, 'requiredReports')) {
      const required = cleanRequiredReports({ ...role, spawnable: Array.isArray(role.spawnable) ? role.spawnable : [] })
      if (JSON.stringify(required) !== JSON.stringify(role.requiredReports)) {
        const { requiredReports: _drop, ...rest } = role
        role = (required ? { ...rest, requiredReports: required } : rest) as Role
        changed = true
      }
    }
    // Role.staffing (run staffing) is rebuilt from its known members; a malformed value is dropped, nothing else changes.
    if (role && typeof role === 'object' && Object.hasOwn(role, 'staffing')) {
      const staffing = cleanRoleStaffing(role.staffing)
      if (JSON.stringify(staffing) !== JSON.stringify(role.staffing)) {
        const { staffing: _drop, ...rest } = role
        role = (staffing ? { ...rest, staffing } : rest) as Role
        changed = true
      }
    }
    // Role.maxConcurrent / knowledgeWrite (UI overhaul) are dropped when invalid.
    if (role && typeof role === 'object') {
      const limited = cleanRoleLimits(role)
      if (limited !== role) {
        role = limited
        changed = true
      }
    }
    if (!role || typeof role !== 'object' || acceptableRoleModel(role.model)) return role
    changed = true
    let connection: ConnectionId = 'anthropic'
    try {
      connection = projectConnection(project)
    } catch {
      // A malformed provider: keep the anthropic default.
    }
    const ctx = tierContext?.(connection) ?? { connection, tierModels: {} }
    const hit = isModelTier(role.tier) ? modelForTier(role.tier, ctx) : undefined
    const next: Role = { ...role }
    if (hit && validModelId(hit.model)) {
      next.model = hit.model
      next.tier = hit.tier
    } else {
      next.model = 'inherit'
      delete next.tier
    }
    const key = typeof role.model === 'string' ? role.model.slice(0, 256) : `<${typeof role.model}>`
    if (!loggedInvalidModels.has(key)) {
      if (loggedInvalidModels.size < INVALID_MODEL_LOG_MAX) loggedInvalidModels.add(key)
      const name = typeof role.name === 'string' ? role.name.replace(/[^ -~]/g, '?').slice(0, 80) : '(unnamed)'
      log(`Role "${name}" had an invalid model (not a model id); it now uses ${next.model === 'inherit' ? 'inherit' : `the ${next.tier} tier (${next.model})`}.`)
    }
    return next
  })
  return changed ? { project: { ...project, roles }, changed } : { project, changed }
}

/** A finite number above zero, else undefined (a spend cap). */
function positiveCap(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** An integer in lo..hi, else undefined (never rounded: a fractional count is a bad value, not a near miss). */
function intInRange(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined
}

/**
 * A plausible git branch name or undefined: trimmed, at most 200 characters, no hidden or control character, no leading
 * '-' (it would read as a git option), none of git's refname bans (space, ~ ^ : ? * [ \, '..', '@{', '//', a leading or
 * trailing '/' or '.', a component starting with '.', an '.lock' ending, the bare '@'). Whether the branch exists is
 * checked where it is used (gitInfo.branches), not here.
 */
export function cleanMainBranch(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  if (!t || t.length > 200 || t.startsWith('-') || hiddenCharIn(t)) return undefined
  if (/[\s~^:?*[\\]/.test(t) || t.includes('..') || t.includes('@{') || t.includes('//') || t === '@') return undefined
  if (t.startsWith('/') || t.endsWith('/') || t.endsWith('.') || t.endsWith('.lock')) return undefined
  if (t.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return undefined
  return t
}

/** A one-line, non-empty, trimmed test command of at most PROJECT_TEST_COMMAND_MAX_CHARS characters, else undefined. */
export function cleanTestCommand(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  if (!t || t.length > PROJECT_TEST_COMMAND_MAX_CHARS || hiddenCharIn(t)) return undefined
  return t
}

/**
 * UI overhaul project fields (Limits, Merging, Branches): each kept only when valid, else dropped (never defaulted).
 * Pure: returns `project` itself when nothing changes, a copy otherwise. See the field docs in shared/types.ts.
 */
export function cleanProjectLimits(project: Project): Project {
  if (!project || typeof project !== 'object') return project
  const rec = project as unknown as Record<string, unknown>
  const rules: [key: string, clean: (v: unknown) => unknown][] = [
    ['maxDailyUsd', positiveCap],
    ['maxMonthlyUsd', positiveCap],
    ['onSpendLimit', (v) => (v === 'pause' || v === 'stop' ? v : undefined)],
    ['maxAgentsPerRun', (v) => intInRange(v, 1, PROJECT_MAX_AGENTS_PER_RUN_LIMIT)],
    ['schedulesNearPlanLimit', (v) => (typeof v === 'boolean' ? v : undefined)],
    ['mainBranch', cleanMainBranch],
    ['requireTestsPass', (v) => (typeof v === 'boolean' ? v : undefined)],
    ['testCommand', cleanTestCommand],
    ['keepFailedBranchesDays', (v) => intInRange(v, 1, 365)],
    ['askBeforeStrongerModel', (v) => (typeof v === 'boolean' ? v : undefined)],
    ['branchNamePattern', cleanBranchNamePattern]
  ]
  let next: Record<string, unknown> | null = null
  for (const [key, clean] of rules) {
    if (!Object.hasOwn(rec, key)) continue
    const value = clean(rec[key])
    if (value === rec[key]) continue
    next ??= { ...rec }
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next ? (next as unknown as Project) : project
}

/** Role.maxConcurrent (1..ROLE_MAX_CONCURRENT_LIMIT) and Role.knowledgeWrite (boolean), dropped when invalid. Pure. */
export function cleanRoleLimits(role: Role): Role {
  if (!role || typeof role !== 'object') return role
  let next: Role = role
  if (Object.hasOwn(role, 'maxConcurrent') && intInRange(role.maxConcurrent, 1, ROLE_MAX_CONCURRENT_LIMIT) !== role.maxConcurrent) {
    const { maxConcurrent: _drop, ...rest } = next
    next = rest as Role
  }
  if (Object.hasOwn(role, 'knowledgeWrite') && typeof role.knowledgeWrite !== 'boolean') {
    const { knowledgeWrite: _drop, ...rest } = next
    next = rest as Role
  }
  return next
}

/** projects.json format version. 2: subagent limits are optional (automatic when unset). */
export const PROJECTS_FILE_VERSION = 2

/**
 * One-time migration of a projects.json older than PROJECTS_FILE_VERSION 2: the old code always filled
 * maxSubagentDepth 3 and maxConcurrentSubagents 8, so exactly those values are dropped (the project becomes
 * automatic); any other value was the user's and stays explicit. Pure.
 */
export function dropLegacyLimitDefaults(p: Project): { project: Project; changed: boolean } {
  // The values the pre-2026-11-03 code always filled (fixed here: they must not follow later default changes).
  const legacyDepth = p.maxSubagentDepth === 3
  const legacyConcurrency = p.maxConcurrentSubagents === 8
  if (!legacyDepth && !legacyConcurrency) return { project: p, changed: false }
  const project = { ...p }
  if (legacyDepth) delete project.maxSubagentDepth
  if (legacyConcurrency) delete project.maxConcurrentSubagents
  return { project, changed: true }
}

/**
 * Keep Project.preferEverydayNearLimit and its deprecated mirror preferSonnetNearLimit in step on a renderer save: an
 * older renderer that changes only the legacy field wins; otherwise the new field (or, when neither is set, the legacy
 * one) decides. Both fields come back set to the effective value, or both unset when neither was set. Pure.
 */
export function reconcileNearLimitProject(stored: Project, incoming: Project): Project {
  const legacy = incoming.preferSonnetNearLimit
  const legacyChanged = typeof legacy === 'boolean' && legacy !== stored.preferSonnetNearLimit
  const freshChanged = incoming.preferEverydayNearLimit !== stored.preferEverydayNearLimit
  const value = legacyChanged && !freshChanged ? legacy : incoming.preferEverydayNearLimit === undefined && legacy === undefined ? undefined : preferEverydayNearLimit(incoming)
  const next = { ...incoming }
  if (value === undefined) {
    delete next.preferEverydayNearLimit
    delete next.preferSonnetNearLimit
  } else {
    next.preferEverydayNearLimit = value
    next.preferSonnetNearLimit = value
  }
  return next
}

/**
 * A renderer save that renames roles (third review of the rename work; changes a saved shape): for each stored role whose
 * slug the save changes (matched by id), when no OTHER stored role held that old slug, every stored server whose `roles`
 * lists the old slug drops it and the renamed role gets the server by id (Role.mcpServers), so its access is kept and no
 * stale slug is left for another role to inherit. That holds even when another incoming role takes the old slug in the same
 * save (a swap, a new role): nobody gains a grant by picking up another role's old slug. When another stored role already
 * held the old slug (a duplicate, e.g. a slug typed through another role's slug key by key), nothing changes, so the
 * renamed role never gains that other role's servers. `roles` undefined (every role) is untouched. Only the renamed role's
 * own old slug is ever removed; any other slug no role holds (a role removed with Undo still available, team files
 * awaiting approval) stays. Only saveFromRenderer calls this; save() (team-file ingest, the service's own saves) never
 * does.
 *
 * `carried` (per role id, server ids main moved to an id grant on an earlier save, kept by ProjectStore until the user acts
 * on that server through mcp:upsert / remove, or a short time passes): a renderer save that omits such an id the stored
 * role still holds gets it back, so a renderer copy that does not know main added it (typed key by key and debounced,
 * possibly back to the starting slug, whose patch carries the starting grants) cannot drop the role's access mid-edit. A
 * real revoke is not affected: the role inspector's revokePlan always sends mcp:upsert of that server first, which ends
 * the carry. Returns the ids added per role (`added`), the ids to keep carrying per role (`carry`) and the old slugs moved
 * (`moved`). Pure: returns `roles` itself when no role changes and no `mcpServers` when the servers do not change.
 */
export function renamedSlugGrants(
  stored: Pick<Project, 'roles' | 'mcpServers'>,
  roles: Role[],
  carried?: ReadonlyMap<string, ReadonlySet<string>>
): { roles: Role[]; mcpServers?: Project['mcpServers']; added: Map<string, string[]>; carry: Map<string, string[]>; moved: string[] } {
  const added = new Map<string, string[]>()
  const carry = new Map<string, string[]>()
  const servers = stored.mcpServers
  if (!servers?.length || !Array.isArray(stored.roles) || !Array.isArray(roles)) return { roles, added, carry, moved: [] }
  const was = new Map(stored.roles.filter(Boolean).map((r) => [r.id, r]))
  const serverIds = new Set(servers.map((s) => s.id))
  const moves = new Map<string, string>()
  const renamed = new Set<string>()
  for (const r of roles) {
    const before = r && was.get(r.id)
    if (!before || typeof r.slug !== 'string' || r.slug === before.slug) continue
    renamed.add(r.id)
    if (stored.roles.some((o) => o !== before && o?.slug === before.slug)) continue
    moves.set(r.id, before.slug)
  }
  if (!renamed.size && !carried?.size) return { roles, added, carry, moved: [] }
  const oldSlugs = new Set(moves.values())
  const nextRoles = roles.map((r) => {
    if (!r || (!renamed.has(r.id) && !carried?.has(r.id))) return r
    const before = was.get(r.id)
    if (!before) return r
    const old = moves.get(r.id)
    const have = Array.isArray(r.mcpServers) ? r.mcpServers : []
    const keep = [...(carried?.get(r.id) ?? [])].filter((id) => serverIds.has(id) && (before.mcpServers ?? []).includes(id))
    const moved = old === undefined ? [] : servers.filter((s) => Array.isArray(s.roles) && s.roles.includes(old)).map((s) => s.id)
    const all = [...new Set([...keep, ...moved])]
    if (all.length) carry.set(r.id, all)
    const add = all.filter((id) => !have.includes(id))
    if (!add.length) return r
    added.set(r.id, add)
    return { ...r, mcpServers: [...have, ...add] }
  })
  const touched = servers.some((s) => Array.isArray(s.roles) && s.roles.some((x) => oldSlugs.has(x)))
  const mcpServers = touched ? servers.map((s) => (Array.isArray(s.roles) && s.roles.some((x) => oldSlugs.has(x)) ? { ...s, roles: s.roles.filter((x) => !oldSlugs.has(x)) } : s)) : undefined
  return { roles: added.size ? nextRoles : roles, ...(mcpServers ? { mcpServers } : {}), added, carry, moved: touched ? [...oldSlugs] : [] }
}

/** The file-system calls checkProjectPath makes; node:fs by default, a fake in tests. */
export interface PathFs {
  statSync(path: string): { isDirectory(): boolean }
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
}

const nodeFs: PathFs = { statSync, existsSync, readdirSync: (path) => readdirSync(path) }

/** Trim and drop one pair of surrounding quotes (a path pasted from Explorer's "Copy as path"). */
export function cleanProjectPath(path: unknown): string {
  const t = typeof path === 'string' ? path.trim() : ''
  const m = /^"(.*)"$/.exec(t) ?? /^'(.*)'$/.exec(t)
  return (m ? m[1] : t).trim()
}

/** Last path segment, either separator, '' for a drive or file-system root. */
export function suggestedProjectName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  if (!trimmed || /^[a-zA-Z]:$/.test(trimmed)) return ''
  return basename(trimmed.replace(/\\/g, '/'))
}

/** What is at `path` (projects:checkPath). Never throws: anything unreadable reports exists false. */
export function checkProjectPath(path: unknown, fs: PathFs = nodeFs): ProjectPathCheck {
  const raw = cleanProjectPath(path)
  const none: ProjectPathCheck = { exists: false, isDirectory: false, isGitRepo: false, suggestedName: suggestedProjectName(raw), empty: false }
  if (!raw) return none
  try {
    const isDirectory = fs.statSync(raw).isDirectory()
    if (!isDirectory) return { ...none, exists: true }
    let entries: string[] = []
    try {
      entries = fs.readdirSync(raw)
    } catch {
      // Unlistable (permissions): it exists, but say nothing about its contents.
      return { ...none, exists: true, isDirectory: true }
    }
    const isGitRepo = entries.includes('.git') || fs.existsSync(join(raw, '.git'))
    return { ...none, exists: true, isDirectory: true, isGitRepo, empty: entries.length === 0 }
  } catch {
    return none
  }
}

/**
 * Why projects:create must refuse this input, or null. A path must be given and must not be a file; an
 * existing-repository project needs a folder that exists. A new idea may name a folder that does not exist yet.
 */
export function createPathError(input: Pick<ProjectCreateInput, 'path' | 'setupKind'> & { kind?: unknown }, check: ProjectPathCheck): string | null {
  const path = cleanProjectPath(input.path)
  if (!path) return 'Choose a folder for the project.'
  if (!isAbsolute(path) && !/^[a-zA-Z]:[\\/]/.test(path)) return `Use a full path, for example ${process.platform === 'win32' ? 'C:\\Projects\\shop' : '/Users/you/projects/shop'}.`
  if (check.exists && !check.isDirectory) return `${path} is a file, not a folder. Choose the project's folder.`
  if (input.setupKind === 'existing' && !check.exists) return `There is no folder at ${path}. Check the path, or choose "New idea" to start in a new folder.`
  if (input.kind === 'engagement' && !check.exists) return "Choose an existing folder for the engagement's working files."
  return null
}

/** Raw entries looked at by cleanAllowedDirectories before it stops (a hostile list cannot cost unbounded fs work). */
const ALLOWED_DIRECTORIES_SCAN_MAX = 200

export interface AllowedDirectoryOpts {
  /** Path flavour for the syntax checks (tests pass `path.win32` / `path.posix`). Default: the native one. */
  path?: PlatformPath
  /** True when `dir` is the data dir, inside it or contains it. Default: isInsideEither both ways (fails closed). */
  touchesData?: (dir: string) => boolean
  /** True when two accepted folders name the same place. Default: scratch.ts pathKey / samePath. */
  same?: (a: string, b: string) => boolean
  /** The project's folder: it, anything inside it and any folder containing it are dropped (allowedDirectoryRisk). */
  projectPath?: string
  /**
   * The user's home folder: home, its ancestors and the config folders under it are dropped (allowedDirectoryRisk).
   * Omitted = no home rules (pure tests); ProjectStore always passes one (os.homedir() unless overridden).
   */
  home?: string
}

/** Why an allowed-directory entry is refused on syntax alone, or null. */
function allowedDirectoryProblem(text: string, p: PlatformPath): string | null {
  if (!text) return 'empty'
  if (text.length > PROJECT_ALLOWED_DIRECTORY_MAX_CHARS) return 'too long'
  if (text.includes('\0')) return 'NUL character'
  // UNC and device paths (\\server\share, \\?\, \\.\, //host), on every platform.
  if (/^[\\/]{2}/.test(text)) return 'network share or device path'
  if (p === win32 ?!/^[a-zA-Z]:[\\/]/.test(text) : !p.isAbsolute(text)) return 'not an absolute path'
  const resolved = p.resolve(text)
  // A bare root (C:\, /, or C:\a\.. which resolves to one) would mean "everything".
  if (p.parse(resolved).root === resolved) return 'a drive or file-system root'
  return null
}

/**
 * Normalize `Project.allowedDirectories` (see its doc in shared/types.ts): strings only, trimmed, at most
 * PROJECT_ALLOWED_DIRECTORY_MAX_CHARS, absolute (win32: a drive-letter path), never a root, never UNC or device,
 * never OrgAI's data folder, a folder inside it or a folder that contains it, no duplicates (first spelling kept), at
 * most PROJECT_ALLOWED_DIRECTORIES_MAX. Each kept entry is `path.normalize`d with its trailing separator dropped.
 * Rejected entries are dropped silently (logged at debug). A non-array gives undefined. Existence is not required.
 */
export function cleanAllowedDirectories(raw: unknown, dataDir: string, opts: AllowedDirectoryOpts = {}): string[] | undefined {
  return cleanDirectoryList(raw, dataDir, opts, 'allowedDirectories')
}

/** Normalize `Project.referenceDirectories`: the same rules as cleanAllowedDirectories (cap, length, risk), own log prefix. */
export function cleanReferenceDirectories(raw: unknown, dataDir: string, opts: AllowedDirectoryOpts = {}): string[] | undefined {
  return cleanDirectoryList(raw, dataDir, opts, 'referenceDirectories')
}

/** The shared cleaner behind cleanAllowedDirectories and cleanReferenceDirectories; `label` prefixes the debug logs. */
function cleanDirectoryList(raw: unknown, dataDir: string, opts: AllowedDirectoryOpts, label: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const p = opts.path ?? (process.platform === 'win32' ? win32 : posix)
  const platform: NodeJS.Platform = p === win32 ? 'win32' : process.platform === 'win32' ? 'linux' : process.platform
  const touchesData =
    opts.touchesData ??
    ((dir: string): boolean => {
      try {
        return isInsideEither(dataDir, dir) || isInsideEither(dir, dataDir)
      } catch {
        return true
      }
    })
  const same =
    opts.same ??
    ((a: string, b: string): boolean => {
      if (pathKey(a) === pathKey(b)) return true
      try {
        return samePath(a, b)
      } catch {
        return false
      }
    })
  const out: string[] = []
  for (const entry of raw.slice(0, ALLOWED_DIRECTORIES_SCAN_MAX)) {
    if (out.length >= PROJECT_ALLOWED_DIRECTORIES_MAX) {
      console.debug(`${label}: over the limit, dropping the rest`)
      break
    }
    if (typeof entry !== 'string') {
      console.debug(`${label}: dropped a non-string entry`)
      continue
    }
    const text = entry.trim()
    const problem = allowedDirectoryProblem(text, p)
    if (problem) {
      console.debug(`${label}: dropped an entry (${problem})`)
      continue
    }
    let dir = p.normalize(text)
    if (dir.length > p.parse(dir).root.length) dir = dir.replace(/[\\/]+$/, '')
    if (touchesData(dir)) {
      console.debug(`${label}: dropped an entry (OrgAI's data folder)`)
      continue
    }
    const risk = allowedDirectoryRisk(dir, { platform, home: opts.home ?? '', ...(opts.projectPath ? { projectPath: opts.projectPath } : {}) })
    if (risk) {
      console.debug(`${label}: dropped an entry (${risk === 'project' ? 'the project folder or inside it' : 'too broad or sensitive'})`)
      continue
    }
    if (out.some((d) => same(d, dir))) continue
    out.push(dir)
  }
  return out
}

/**
 * Normalize `Project.client`: a string, trimmed, cut to PROJECT_CLIENT_MAX_CHARS at a character boundary; dropped
 * (undefined) when it is not a string, empty or holds a hidden character.
 */
export function cleanClient(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    console.debug('client: dropped a value that is not a string')
    return undefined
  }
  let text = raw.trim()
  if (!text) return undefined
  if (hiddenCharIn(text) || /[\r\n\t\u2028\u2029]/.test(text)) {
    console.debug('client: dropped a value with a hidden character')
    return undefined
  }
  if (text.length > PROJECT_CLIENT_MAX_CHARS) {
    text = text.slice(0, PROJECT_CLIENT_MAX_CHARS)
    const last = text.charCodeAt(text.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
    text = text.trim()
    console.debug('client: cut to the length limit')
  }
  return text || undefined
}

/**
 * The project with allowedDirectories and referenceDirectories normalized (each removed when it is not an array), a
 * reference entry that names the same place as an allowed one dropped (the folder stays writable), a non-ProjectKind
 * `kind` removed (missing = 'code') and an unknown staffing / staffingGoal / reviewPolicy removed; `changed` when
 * anything differs.
 */
function withCleanAllowedDirectories(project: Project, dataDir: string, home: string): { project: Project; changed: boolean } {
  if (!project || typeof project !== 'object') return { project, changed: false }
  let next = project
  let changed = false
  if ('kind' in project && !isProjectKind(project.kind)) {
    console.debug('project kind: dropped a value that is not a project kind')
    next = { ...next }
    delete next.kind
    changed = true
  }
  // Project.knowledgeAutoContext is a boolean or unset; anything else is dropped (unset = on). Never filled in here.
  if ('knowledgeAutoContext' in project && typeof project.knowledgeAutoContext !== 'boolean') {
    console.debug('knowledgeAutoContext: dropped a value that is not true or false')
    next = { ...next }
    delete next.knowledgeAutoContext
    changed = true
  }
  // Project.folderConfigTrust (folder config gate): rebuilt when present, junk fails closed to 'untrusted'. Never
  // added to a project without it: projects stored before the gate stay 'none' (no gate) on purpose.
  if ('folderConfigTrust' in project) {
    const trust = cleanFolderConfigTrust(project.folderConfigTrust)
    if (JSON.stringify(trust) !== JSON.stringify(project.folderConfigTrust)) {
      next = { ...next }
      if (trust === undefined) delete next.folderConfigTrust
      else next.folderConfigTrust = trust
      changed = true
    }
  }
  // Run staffing: Project.staffing / staffingGoal / reviewPolicy keep only a known value; anything else is removed (the
  // default then applies through staffingModeOf / staffingGoalOf / reviewPolicyOf). Never filled in here.
  for (const [key, valid] of [
    ['staffing', isStaffingMode],
    ['staffingGoal', isStaffingGoal],
    ['reviewPolicy', isReviewPolicy]
  ] as const) {
    if (key in project && !valid(project[key])) {
      console.debug(`${key}: dropped an unknown value`)
      next = { ...next }
      delete next[key]
      changed = true
    }
  }
  const limited = cleanProjectLimits(next)
  if (limited !== next) {
    next = limited
    changed = true
  }
  if ('client' in project) {
    const client = cleanClient(project.client)
    if (client !== project.client) {
      next = { ...next }
      if (client === undefined) delete next.client
      else next.client = client
      changed = true
    }
  }
  const hasAllowed = 'allowedDirectories' in project
  const hasRefs = 'referenceDirectories' in project
  if (!hasAllowed && !hasRefs) return { project: next, changed }
  const projectPath = typeof project.path === 'string' && project.path ? project.path : undefined
  const opts: AllowedDirectoryOpts = { home, ...(projectPath ? { projectPath } : {}) }
  next = { ...next }
  let allowed: string[] | undefined
  if (hasAllowed) {
    allowed = cleanAllowedDirectories(project.allowedDirectories, dataDir, opts)
    if (allowed === undefined) delete next.allowedDirectories
    else next.allowedDirectories = allowed
    if (JSON.stringify(allowed) !== JSON.stringify(project.allowedDirectories)) changed = true
  }
  if (hasRefs) {
    let refs = cleanReferenceDirectories(project.referenceDirectories, dataDir, opts)
    const writable = Array.isArray(next.allowedDirectories) ? next.allowedDirectories : []
    if (refs && writable.length) {
      const before = refs.length
      refs = refs.filter((r) => !writable.some((a) => sameFolder(a, r)))
      if (refs.length !== before) console.debug('referenceDirectories: dropped an entry (also an allowed folder)')
    }
    if (refs === undefined) delete next.referenceDirectories
    else next.referenceDirectories = refs
    if (JSON.stringify(refs) !== JSON.stringify(project.referenceDirectories)) changed = true
  }
  return { project: next, changed }
}

function sameFolder(a: string, b: string): boolean {
  if (pathKey(a) === pathKey(b)) return true
  try {
    return samePath(a, b)
  } catch {
    return false
  }
}

/**
 * Team files (src/main/teamFiles/service.ts) see every `save`: `beforeSave` gets the stored project (null when it is
 * new) and the cleaned incoming one, and returns the project to store (usually `next`; a rebased copy when the files
 * were ingested first). It must not throw. `saveInternal` bypasses it.
 */
export interface ProjectSaveHook {
  beforeSave(before: Project | null, next: Project): Project
}

/**
 * The projects and format version of a parsed `projects.json` (pure; ProjectStore's load and the CLI's read-only
 * reader). Not migrated. A null file throws, as the store's load always did (it then starts empty).
 */
export function parseProjectsFile(parsed: unknown): { projects: Project[]; version: number } {
  const p = parsed as { version?: unknown; projects?: Project[] }
  return {
    projects: Array.isArray(p.projects) ? p.projects : [],
    version: typeof p.version === 'number' && Number.isFinite(p.version) ? p.version : 1
  }
}

/** How long after a role's latest rename save main keeps carrying the id grants it added for that rename (renamedSlugGrants). */
export const RENAME_CARRY_MS = 120_000

/** Simple JSON-file store. Projects are small and few, so a database is overkill for now. */
export class ProjectStore {
  private saveHook?: ProjectSaveHook
  private file: string
  private projects: Project[] = []
  /** Format version of the loaded projects.json; a missing file is current. */
  private fileVersion = PROJECTS_FILE_VERSION
  private tierContext?: TierContextFor
  private dataDir: string
  private home: string
  /**
   * renamedSlugGrants bookkeeping (memory only, per project): server ids main moved to a renamed role's id grant, carried
   * into later renderer saves of that role until mcp:upsert / remove names the server (forgetRenamedServer) or
   * RENAME_CARRY_MS passes; and the old slugs main removed, which a stale whole-spec mcp:upsert must not write back while no
   * role holds them (renamedAwaySlugs).
   */
  private renameCarry = new Map<string, Map<string, { ids: Set<string>; at: number }>>()
  private renamedAway = new Map<string, Set<string>>()

  /**
   * `opts.tierContext` gives a connection's tier mapping for the invalid-model fallback (sanitizeRoleModels).
   * `opts.home` overrides os.homedir() for the allowed-directory rules (tests).
   */
  constructor(dataDir: string, opts: { tierContext?: TierContextFor; home?: string } = {}) {
    this.tierContext = opts.tierContext
    this.dataDir = dataDir
    this.home = opts.home ?? homedir()
    this.file = join(dataDir, 'projects.json')
    this.load()
    this.migrateAll()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = parseProjectsFile(JSON.parse(readFileSync(this.file, 'utf8')))
        this.projects = parsed.projects
        this.fileVersion = parsed.version
      }
    } catch (e) {
      console.error('Failed to read projects.json, starting empty:', e)
      this.projects = []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: PROJECTS_FILE_VERSION, projects: this.projects }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /**
   * Boot migration, run by the constructor: projects saved before connections existed get provider.connection
   * and Role.tier (see migrateProject). Persists only when something changed. Returns how many projects changed.
   */
  migrateAll(): number {
    let changed = 0
    const legacyLimits = this.fileVersion < 2
    this.projects = this.projects.map((p) => {
      const limits = legacyLimits ? dropLegacyLimitDefaults(p) : { project: p, changed: false }
      const m = migrateProject(limits.project)
      const clean = sanitizeRoleModels(m.project, this.tierContext)
      const dirs = withCleanAllowedDirectories(clean.project, this.dataDir, this.home)
      if (limits.changed || m.changed || clean.changed || dirs.changed) changed++
      return dirs.project
    })
    // Persist after a version bump too, so the one-time limits migration never runs again on explicit 3 / 8 values.
    if (changed || this.fileVersion < PROJECTS_FILE_VERSION) {
      if (this.projects.length || changed) this.persist()
      this.fileVersion = PROJECTS_FILE_VERSION
    }
    return changed
  }

  /** Installed once by index.ts after the team files service exists. */
  setTeamFilesHook(hook: ProjectSaveHook | undefined): void {
    this.saveHook = hook
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): Project | null {
    return this.projects.find((p) => p.id === id) ?? null
  }

  /**
   * Validates the path (createPathError) and throws its message. `mock` needs `opts.mockAvailable` (the mock
   * adapter is registered); it sets provider.id 'mock' so every run of the project is token-free.
   */
  create(
    input: ProjectCreateInput,
    settings?: AppSettings,
    opts: {
      mockAvailable?: boolean
      fs?: PathFs
      prepare?: (p: Project) => Project
      importRoles?: (p: Project, sources: unknown) => Project
      fromTemplate?: (p: Project, templateId: string) => Project
      /**
       * Start from the team in the folder's `.orgai/` (ProjectCreateInput.teamFiles). `build` returns the project with the
       * files' team applied (it throws a readable message for a stale digest or a problem) and wins over importRoles and
       * fromTemplate; `adopted` runs once the project is stored.
       */
      teamFiles?: { build: (p: Project) => Project; adopted: (p: Project) => void }
    } = {}
  ): Project {
    const error = createPathError(input, checkProjectPath(input.path, opts.fs))
    if (error) throw new Error(error)
    if (input.mock && !opts.mockAvailable) throw new Error('The mock adapter is not available. Start OrgAI with ORGAI_MOCK=1 to use it.')
    let project = newProject({ name: input.name, path: cleanProjectPath(input.path), brief: input.brief, setupKind: input.setupKind, kind: input.kind }, settings)
    // Mock projects stay on the anthropic defaults and the mock adapter; others take the default connection.
    if (input.mock) project.provider = { ...project.provider, id: 'mock' }
    else if (opts.prepare) project = opts.prepare(project)
    const fromFiles = !!input.teamFiles && !!opts.teamFiles
    if (fromFiles) project = (opts.teamFiles as NonNullable<typeof opts.teamFiles>).build(project)
    // Imported agents replace the default chart after the connection is chosen, so their models map to it.
    let imported = fromFiles
    if (!fromFiles && Array.isArray(input.importAgents) && input.importAgents.length && opts.importRoles) {
      const before = project
      project = opts.importRoles(project, input.importAgents)
      imported = project.roles !== before.roles
    }
    // A team template pre-fills the chart only when the agent import produced nothing (importAgents wins).
    if (!imported && typeof input.templateId === 'string' && input.templateId && opts.fromTemplate) project = opts.fromTemplate(project, input.templateId)
    project = sanitizeRoleModels(project, this.tierContext).project
    // A folder that came with agent config of its own (a cloned repository, or a quick chat promoted to a project) starts
    // gated: runs ignore that config until the user accepts it. A missing folder or an engagement stays ungated.
    const trust = initialFolderConfigTrust(project)
    if (trust) project = { ...project, folderConfigTrust: trust }
    this.projects.push(project)
    this.persist()
    if (fromFiles) {
      try {
        opts.teamFiles?.adopted(project)
      } catch (e) {
        console.warn(`Team files: could not record the adopted team: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return project
  }

  /**
   * Every save (saveFromRenderer, update) passes Role.model through sanitizeRoleModels and allowedDirectories through
   * cleanAllowedDirectories.
   */
  save(project: Project): Project {
    if (isVirtualProjectId(project?.id)) throw new Error('An assistant project (Chat, Skill assistant, harness) cannot be stored.')
    let cleaned = withCleanAllowedDirectories(sanitizeRoleModels(project, this.tierContext).project, this.dataDir, this.home).project
    // Team files: the hook may rebase the project (a change pulled into the folder is kept) and writes the team files.
    if (this.saveHook) {
      try {
        const hooked = this.saveHook.beforeSave(this.get(project.id), cleaned)
        if (hooked !== cleaned) cleaned = withCleanAllowedDirectories(sanitizeRoleModels(hooked, this.tierContext).project, this.dataDir, this.home).project
      } catch (e) {
        console.warn(`Team files: the save hook failed; saving without it: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return this.commitSave(cleaned)
  }

  /** Store a project without the team files hook (the service's own saves: a team change that came from the files). */
  saveInternal(project: Project): Project {
    if (isVirtualProjectId(project?.id)) throw new Error('An assistant project (Chat, Skill assistant, harness) cannot be stored.')
    return this.commitSave(withCleanAllowedDirectories(sanitizeRoleModels(project, this.tierContext).project, this.dataDir, this.home).project)
  }

  /**
   * Old slugs a renderer save moved off this project's servers (renamedSlugGrants) that no role holds now: mcp:upsert drops
   * exactly these from an incoming `roles` list (a stale renderer copy writing a renamed role's old slug back). Any other
   * slug no role holds is left alone (a removed role with Undo available, team files awaiting approval).
   */
  renamedAwaySlugs(projectId: string): ReadonlySet<string> {
    return this.renamedAway.get(projectId) ?? new Set()
  }

  /** The user acted on server `serverId` (mcp:upsert / remove): main stops carrying it into later renderer saves. */
  forgetRenamedServer(projectId: string, serverId: string): void {
    const book = this.renameCarry.get(projectId)
    if (!book) return
    for (const [roleId, c] of book) {
      c.ids.delete(serverId)
      if (!c.ids.size) book.delete(roleId)
    }
    if (!book.size) this.renameCarry.delete(projectId)
  }

  private commitSave(cleaned: Project): Project {
    // A slug a role holds again is that role's: no longer a renamed-away slug.
    const away = this.renamedAway.get(cleaned.id)
    if (away) {
      for (const r of cleaned.roles ?? []) if (r) away.delete(r.slug)
      if (!away.size) this.renamedAway.delete(cleaned.id)
    }
    const updated = { ...cleaned, updatedAt: new Date().toISOString() }
    const idx = this.projects.findIndex((p) => p.id === cleaned.id)
    if (idx === -1) this.projects.push(updated)
    else this.projects[idx] = updated
    this.persist()
    return updated
  }

  /**
   * Save a project the renderer sent. mcpServers and plugins change only through mcp:* / plugins:*, so a stale
   * renderer copy must not wipe them: the stored values win. Unknown, unsafe and harness ids are refused:
   * projects are created through create() (projects:create) so renderer-supplied servers never land unvalidated.
   */
  saveFromRenderer(project: Project): Project {
    if (!isSafeId(project?.id)) throw new Error('Invalid project id')
    if (isVirtualProjectId(project.id)) throw new Error(project.id === HARNESS_PROJECT_ID ? 'The harness project cannot be saved' : 'An assistant project (Chat, Skill assistant) cannot be saved')
    const stored = this.get(project.id)
    if (!stored) throw new Error('Project not found')
    const next: Project = reconcileNearLimitProject(stored, { ...project })
    // A renderer may never change a project's kind (it selects the rules file and where OrgAI writes).
    if (stored.kind !== undefined) next.kind = stored.kind
    else delete next.kind
    // Nor the folder config gate: only projects:setFolderConfigTrust changes it. A new folder is judged afresh.
    if (typeof next.path === 'string' && next.path !== stored.path) {
      const trust = initialFolderConfigTrust({ path: next.path, kind: stored.kind })
      if (trust) next.folderConfigTrust = trust
      else delete next.folderConfigTrust
    } else if (stored.folderConfigTrust !== undefined) next.folderConfigTrust = stored.folderConfigTrust
    else delete next.folderConfigTrust
    if (stored.mcpServers !== undefined) next.mcpServers = stored.mcpServers
    else delete next.mcpServers
    // A rename moves the role's slug-keyed server grants to its id (renamedSlugGrants): no stale old slug stays behind.
    if (Array.isArray(next.roles)) {
      const now = Date.now()
      const carried = new Map<string, Set<string>>()
      const book = this.renameCarry.get(project.id) ?? new Map<string, { ids: Set<string>; at: number }>()
      for (const [roleId, c] of book) if (now - c.at <= RENAME_CARRY_MS) carried.set(roleId, c.ids)
      const moved = renamedSlugGrants(stored, next.roles, carried)
      next.roles = moved.roles
      if (moved.mcpServers) next.mcpServers = moved.mcpServers
      const kept = new Map<string, { ids: Set<string>; at: number }>()
      const present = new Set(next.roles.filter(Boolean).map((r) => r.id))
      for (const [roleId, c] of book) if (present.has(roleId) && now - c.at <= RENAME_CARRY_MS) kept.set(roleId, c)
      // The window runs from the role's latest rename save.
      const storedSlug = new Map(stored.roles.filter(Boolean).map((r) => [r.id, r.slug]))
      for (const [roleId, ids] of moved.carry) {
        const prev = kept.get(roleId)
        const renamedNow = next.roles.find((r) => r?.id === roleId)?.slug !== storedSlug.get(roleId)
        kept.set(roleId, { ids: new Set([...(prev?.ids ?? []), ...ids]), at: renamedNow || !prev ? now : prev.at })
      }
      if (kept.size) this.renameCarry.set(project.id, kept)
      else this.renameCarry.delete(project.id)
      if (moved.moved.length) this.renamedAway.set(project.id, new Set([...(this.renamedAway.get(project.id) ?? []), ...moved.moved]))
    }
    if (stored.plugins !== undefined) next.plugins = stored.plugins
    else delete next.plugins
    // Skills change only through skills:*: the stored list wins, and a role keeps only grants that exist there.
    if (stored.skills !== undefined) next.skills = stored.skills
    else delete next.skills
    const known = new Set((stored.skills ?? []).map((s) => s.id))
    if (Array.isArray(next.roles)) {
      next.roles = next.roles.map((r) => {
        if (!r || r.skills === undefined) return r
        const kept = Array.isArray(r.skills) ? [...new Set(r.skills.filter((id) => typeof id === 'string' && known.has(id)))] : []
        return { ...r, skills: kept }
      })
    }
    if (next.skillEvaluation !== undefined) next.skillEvaluation = storedSkillEvaluation(next.skillEvaluation)
    if (next.teamReview !== undefined) next.teamReview = teamReviewOf(next)
    return this.save(next)
  }

  /** Read-modify-write one stored project. Throws when it does not exist. */
  update(id: string, fn: (p: Project) => Project): Project {
    const stored = this.get(id)
    if (!stored) throw new Error('Project not found')
    return this.save(fn(structuredClone(stored)))
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }
}
