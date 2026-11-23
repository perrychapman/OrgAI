import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitExecutable } from '../host/systemBinaries'
import { hasRepoFilterDriver } from '../projects/gitInfo'
import { commonGitDir, gitPath } from './repoLock'
import { gitGuarded } from './worktrees'

/**
 * What the merge gate pins about the checkout a merge lands in (the main checkout, or a parent report's worktree) around the
 * project's test command. The command is repository code the agents edited, run as the user: it can reach the main checkout
 * through the shared git directory (`git -C <root> commit`, `git add`, a hook, `core.hooksPath` in `.git/config`) even though
 * its working directory is the finished copy. The branch tip is pinned elsewhere (worktrees.ts branchTip); this pins the
 * target:
 *
 * PINNED (a change between the two readings refuses the merge, the copy is kept):
 * - HEAD's commit and the branch (or detached state) it is on;
 * - the index, entry by entry (`ls-files -s`: mode, object, stage, path), so a staged change or an unmerged entry shows;
 * - tracked working-tree changes (`diff-files --raw`: which tracked files differ from the index, and how), unless the
 *   repository defines a filter driver of its own (`hasRepoFilterDriver`): `git diff-files` would run its clean program, so
 *   the working tree is then reported "not pinned" and left alone;
 * - the repository's `config` and, when present, `config.worktree` and `info/attributes` (content digest): where a hook path, a
 *   merge or diff driver, a filter or an alias would be named;
 * - the `hooks` directory (file names and content digests).
 *
 * NOT PINNED (said plainly, never claimed): untracked files; a tracked file that was already modified before the tests and was
 * modified again (the raw diff shows the same row); other refs and other worktrees; the object database; the user's own system and
 * global config and the global hooks directory they name; a process the test command leaves running (it is outside the
 * command's lifetime, and the readings are taken when it has ended); the working tree of a repository with its own filter
 * drivers. The merge itself and what follows run through the guarded git runner with hooks off (worktrees.ts mergeInto).
 *
 * Every git call here goes through gitGuarded (hostile-config overrides, a pinned read-only environment on a plain `.git`
 * checkout). A part git cannot read is given a value that never equals another reading, so it counts as moved.
 */

export interface RootPin {
  head: string
  branch: string
  index: string
  worktree: string
  config: string
  hooks: string
}

const BIG = { maxBuffer: 64 * 1024 * 1024 }
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** A reading that cannot be compared: it never equals another one. */
const unreadable = (): string => `unreadable:${randomUUID()}`

const HOOK_FILES_MAX = 500
const HOOK_FILE_BYTES_MAX = 4 * 1024 * 1024

function fileDigest(path: string | null): string {
  if (!path) return 'none'
  try {
    if (!existsSync(path)) return 'none'
    return sha(readFileSync(path))
  } catch {
    return unreadable()
  }
}

function hooksDigest(dir: string | null): string {
  if (!dir) return unreadable()
  try {
    if (!existsSync(dir)) return 'none'
    const parts: string[] = []
    const names = readdirSync(dir).sort()
    for (const name of names.slice(0, HOOK_FILES_MAX)) {
      const full = join(dir, name)
      const st = lstatSync(full)
      parts.push(`${name}\0${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.size > HOOK_FILE_BYTES_MAX ? `big:${st.size}` : sha(readFileSync(full))}`)
    }
    if (names.length > HOOK_FILES_MAX) parts.push(`+${names.length - HOOK_FILES_MAX}`)
    return sha(parts.join('\n'))
  } catch {
    return unreadable()
  }
}

/** Read the pin of `root` now. Never throws. */
export async function pinRoot(root: string): Promise<RootPin> {
  const bin = gitExecutable()
  const head = await gitGuarded(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const branch = await gitGuarded(root, ['symbolic-ref', '--quiet', 'HEAD'])
  const index = await gitGuarded(root, ['ls-files', '--stage', '-z'], BIG)
  let worktree: string
  if (!bin) worktree = unreadable()
  else if (await hasRepoFilterDriver(bin, root)) worktree = 'not pinned'
  else {
    const diff = await gitGuarded(root, ['diff-files', '--raw', '-z', '--no-ext-diff', '--no-textconv'], BIG)
    worktree = diff.ok ? sha(diff.out) : unreadable()
  }
  const common = await commonGitDir(root).catch(() => null)
  const [local, perWorktree, attributes] = await Promise.all([
    common ? Promise.resolve(join(common, 'config')) : Promise.resolve(null),
    gitPath(root, 'config.worktree').catch(() => null),
    common ? Promise.resolve(join(common, 'info', 'attributes')) : Promise.resolve(null)
  ])
  return {
    // An unborn HEAD prints nothing and fails quietly: both readings say 'none'. (Without git every other part is unreadable.)
    head: head.ok ? head.out : 'none',
    branch: branch.ok ? branch.out : 'detached',
    index: index.ok ? sha(index.out) : unreadable(),
    worktree,
    config: sha([fileDigest(local), fileDigest(perWorktree), fileDigest(attributes)].join('|')),
    hooks: hooksDigest(common ? join(common, 'hooks') : null)
  }
}

const LABELS: Record<keyof RootPin, string> = {
  head: 'its HEAD commit',
  branch: 'the branch it is on',
  index: 'its index (staged changes)',
  worktree: 'its tracked files',
  config: 'the repository config',
  hooks: 'the git hooks'
}

/** What differs between two readings, in plain words (empty = the same). */
export function pinDrift(was: RootPin, now: RootPin): string[] {
  return (Object.keys(LABELS) as (keyof RootPin)[]).filter((k) => was[k] !== now[k]).map((k) => LABELS[k])
}

/** The refusal sentence for a drift, ending with what to do. */
export function pinDriftMessage(labels: readonly string[], checkout: string): string {
  return (
    `Not merged: while the project's tests ran, ${labels.join(', ')} of ${checkout} changed. The test command runs repository code as you and can reach ` +
    `that checkout through the shared git folder, so OrgAI does not merge after it has. Look at what changed (git log, git status, .git/config, .git/hooks), ` +
    `undo anything you did not mean, then integrate again.`
  )
}

/** The drift sentence of `root` against an earlier pin, or undefined when nothing moved. */
export async function rootDrift(root: string, was: RootPin): Promise<string | undefined> {
  const labels = pinDrift(was, await pinRoot(root))
  return labels.length ? pinDriftMessage(labels, root) : undefined
}
