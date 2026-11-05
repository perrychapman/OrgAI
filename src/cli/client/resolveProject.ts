/**
 * Which project a command works on (cli-spec 4): `--project <id-or-path>`, else the deepest registered Project.path
 * that contains the current folder. The walk covers every ancestor up to the file system root (engagement folders are
 * often not git repositories), compares the lexical and the canonical spellings, and folds case on darwin and win32.
 *
 * Inside an OrgAI-managed agent worktree (`<repo>/.claude/worktrees/agent-<id>`) the project is the main checkout's;
 * `managedWorktree.mainCheckout` names it so run-starting commands (a later wave) can refuse with exit 2. Read-only
 * commands use the resolution as is.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Project } from '../../shared/types'
import { canonicalDeep } from '../../main/quick/scratch'
import type { ProjectResolution } from '../types'

export interface ResolveProjectOptions {
  /** --project. */
  flag?: string
  cwd: string
  platform?: NodeJS.Platform
  /** `git <args>` in `cwd`: trimmed stdout, or undefined when git is missing or fails. Injectable for tests. */
  git?: (cwd: string, args: string[]) => string | undefined
  /** canonicalDeep stand-in (tests). */
  canonical?: (p: string) => string
}

const GIT_TIMEOUT_MS = 3000

function defaultGit(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const t = out.trim()
    return t || undefined
  } catch {
    return undefined
  }
}

const pathFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix)

/** A comparison key: resolved, no trailing separator (a root keeps its own), case-folded on darwin and win32. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const pp = pathFor(platform)
  const r = pp.resolve(p)
  const root = pp.parse(r).root
  const k = r.length > root.length ? r.replace(/[\\/]+$/, '') : root
  return platform === 'darwin' || platform === 'win32' ? k.toLowerCase() : k
}

/** Every ancestor of `p` (itself first) as keys, mapped to its depth (number of segments). */
function ancestorKeys(p: string, platform: NodeJS.Platform): Map<string, number> {
  const pp = pathFor(platform)
  const out = new Map<string, number>()
  let cur = pp.resolve(p)
  const chain: string[] = []
  for (let i = 0; i < 4096; i++) {
    chain.push(cur)
    const parent = pp.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  chain.forEach((a, i) => {
    const key = pathKey(a, platform)
    if (!out.has(key)) out.set(key, chain.length - 1 - i)
  })
  return out
}

const WORKTREE_SEGMENT = /[\\/]\.claude[\\/]worktrees[\\/]agent-[^\\/]+/

/**
 * The main checkout when `dir` lies in an OrgAI-managed agent worktree: the path holds `/.claude/worktrees/agent-`,
 * and when git answers, `--git-dir` and `--git-common-dir` differ (a linked worktree) and the common dir's parent is
 * the main checkout. Without git the part before `/.claude/worktrees/` is used.
 */
export function managedWorktreeOf(dir: string, opts: { platform?: NodeJS.Platform; git?: ResolveProjectOptions['git'] } = {}): { mainCheckout: string } | undefined {
  const platform = opts.platform ?? process.platform
  const pp = pathFor(platform)
  const m = WORKTREE_SEGMENT.exec(dir)
  if (!m) return undefined
  const lexical = dir.slice(0, m.index) || pp.parse(dir).root
  const git = opts.git ?? defaultGit
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir && commonDir && pathKey(gitDir, platform) !== pathKey(commonDir, platform) && pp.basename(commonDir) === '.git') {
    return { mainCheckout: pp.dirname(pp.resolve(commonDir)) }
  }
  return { mainCheckout: lexical }
}

function spellings(p: string, canonical: (p: string) => string): string[] {
  const c = canonical(p)
  return c === p ? [p] : [p, c]
}

/** cli-spec 4 resolution. Never throws. */
export function resolveProject(projects: readonly Project[], opts: ResolveProjectOptions): ProjectResolution {
  const platform = opts.platform ?? process.platform
  const pp = pathFor(platform)
  const canonical = opts.canonical ?? ((p: string) => (platform === process.platform ? canonicalDeep(p) : p))
  const projectKeys = projects.map((p) => (typeof p.path === 'string' && p.path ? spellings(p.path, canonical).map((s) => pathKey(s, platform)) : []))

  if (opts.flag !== undefined) {
    const byId = projects.find((p) => p.id === opts.flag)
    if (byId) return { project: byId, via: 'flag' }
    const target = pp.resolve(opts.cwd, opts.flag)
    const keys = new Set(spellings(target, canonical).map((s) => pathKey(s, platform)))
    const idx = projectKeys.findIndex((ks) => ks.some((k) => keys.has(k)))
    if (idx !== -1) return { project: projects[idx], via: 'flag' }
    return { via: 'flag', error: `No OrgAI project matches ${opts.flag}.` }
  }

  const resolvedCwd = pp.resolve(opts.cwd)
  const canonCwd = canonical(resolvedCwd)
  const managed = managedWorktreeOf(canonCwd, { platform, git: opts.git }) ?? (canonCwd !== resolvedCwd ? managedWorktreeOf(resolvedCwd, { platform, git: opts.git }) : undefined)
  const lookups = managed ? spellings(managed.mainCheckout, canonical) : [...new Set([canonCwd, resolvedCwd])]
  const ancestors = new Map<string, number>()
  for (const l of lookups) for (const [k, d] of ancestorKeys(l, platform)) if (!ancestors.has(k) || ancestors.get(k)! < d) ancestors.set(k, d)

  let best: { project: Project; depth: number } | undefined
  projects.forEach((project, i) => {
    for (const k of projectKeys[i]) {
      const depth = ancestors.get(k)
      if (depth !== undefined && (!best || depth > best.depth)) best = { project, depth }
    }
  })
  const extra = managed ? { managedWorktree: managed } : {}
  return best ? { project: best.project, via: 'cwd', ...extra } : { via: 'none', ...extra }
}
