import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { gitExecutable } from '../host/systemBinaries'
import { hasRepoFilterDriver } from '../projects/gitInfo'
import { movedOnlyByOrgAi, orgAiGeneration } from './orgaiMoves'
import { commonGitDir, gitPath } from './repoLock'
import { gitGuarded } from './worktrees'

/**
 * What the merge gate pins about the checkout a merge lands in (the main checkout, or a parent report's worktree) around the
 * project's test command. The command is repository code the agents edited, run as the user: it can reach the main checkout
 * through the shared git directory (`git -C <root> commit`, `git add`, a hook, `core.hooksPath` in `.git/config`) even though
 * its working directory is the finished copy. The branch tip is pinned elsewhere (worktrees.ts branchTip); this pins the
 * target:
 *
 * PINNED, hard (a change between the two readings always refuses the merge, the copy is kept):
 * - the repository's `config` and, when present, `config.worktree` and `info/attributes` (content digest): where a hook path, a
 *   merge or diff driver, a filter or an alias would be named;
 * - the `hooks` directory (file names and content digests; a symlink by its target);
 * - the `.gitattributes` files that are not tracked, in the root and in the folders of the files the merge changes (an
 *   untracked one can select a merge driver, or the built-in `union`, for the merge);
 * PINNED, soft (a change is read against what OrgAI itself did meanwhile, see "Moves of OrgAI's own"):
 * - HEAD's commit and the branch (or detached state) it is on;
 * - the index, entry by entry (`ls-files -s`: mode, object, stage, path), so a staged change or an unmerged entry shows;
 * - tracked working-tree changes (`diff-files --raw`: which tracked files differ from the index, and how), unless the
 *   repository defines a filter driver of its own (`hasRepoFilterDriver`): `git diff-files` would run its clean program, so
 *   the working tree is then reported "not pinned" and left alone;
 * - `changes`: the staged and unstaged differences against HEAD as one digest, which a merge of other files does not move.
 *
 * Moves of OrgAI's own (orgaiMoves.ts). A merge of another report into the same checkout while the tests ran (several reports
 * finishing together is normal) moves HEAD, the index and the files it touches. Every OrgAI move is recorded under the
 * repository lock; when HEAD moved only through recorded moves and `changes` is unchanged, the pin is read again and the merge
 * goes on (the report's reviewed commit is merged into the new HEAD, conflicts are handled as always). Anything else that moved
 * a soft part reads as a change "by something other than OrgAI": the test command, or the user committing or editing in the
 * project folder, which git cannot tell apart. The caller then asks the user once when a review card is part of the merge, and
 * refuses otherwise (nobody is there to ask).
 *
 * NOT PINNED (said plainly, never claimed): untracked files other than the `.gitattributes` above; a tracked file that was
 * already modified before the tests and was modified again (the raw diff shows the same row); other refs and other worktrees;
 * the object database; the user's own system and global config and the global hooks directory they name (the merge ignores
 * them, worktrees.ts mergeInto); a process the test command leaves running (it is outside the command's lifetime, and the
 * readings are taken when it has ended); the working tree of a repository with its own filter drivers; a file a config
 * `include.path` names. The merge itself and what follows run through the guarded git runner with hooks off.
 *
 * Every git call here goes through gitGuarded (hostile-config overrides, a pinned read-only environment on a plain `.git`
 * checkout). A part git cannot read is given a value that never equals another reading, so it counts as moved. Files are
 * opened without following a link and read only when regular and small (a FIFO, a device, a link or a huge file counts as
 * moved, it is never read).
 */

export interface RootPin {
  head: string
  branch: string
  index: string
  worktree: string
  /** The staged and unstaged differences against HEAD (see above). Not a label: it only decides whether OrgAI's moves explain the rest. */
  changes: string
  config: string
  attributes: string
  hooks: string
  /** The generation of OrgAI's own moves of this checkout when the pin was read (orgaiMoves.ts). */
  gen: number
  /** The folders (relative, '' = the root) whose `.gitattributes` the pin looked at. */
  attrDirs: string[]
}

type Labelled = Exclude<keyof RootPin, 'gen' | 'attrDirs' | 'changes'>

const BIG = { maxBuffer: 64 * 1024 * 1024 }
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
/** A reading that cannot be compared: it never equals another one. */
const unreadable = (): string => `unreadable:${randomUUID()}`

const HOOK_FILES_MAX = 500
/** A config, attributes or hook file larger than this is not read (it counts as moved). */
const FILE_BYTES_MAX = 4 * 1024 * 1024
/** Folders whose `.gitattributes` are looked at (the root first). */
const ATTR_DIRS_MAX = 300

/**
 * The digest of one file: 'none' when it does not exist, a content digest for a regular small file, and an unreadable value
 * for anything else (a link, a FIFO, a device, a directory, a file over FILE_BYTES_MAX, an error). The file is opened
 * without following a link and without blocking, and checked after opening, so a swap between the check and the read cannot
 * make this wait on a pipe.
 */
export function fileDigest(path: string | null): string {
  if (!path) return 'none'
  let fd: number | undefined
  try {
    try {
      // lstat first: a link (also on Windows, where O_NOFOLLOW does not exist), a FIFO, a device or a folder is never opened.
      const first = lstatSync(path)
      if (!first.isFile() || first.size > FILE_BYTES_MAX) return unreadable()
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'none' : unreadable()
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > FILE_BYTES_MAX) return unreadable()
    return sha(readFileSync(fd))
  } catch {
    return unreadable()
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function hooksDigest(dir: string | null): string {
  if (!dir) return unreadable()
  try {
    try {
      lstatSync(dir)
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : unreadable()
    }
    const parts: string[] = []
    const names = readdirSync(dir).sort()
    for (const name of names.slice(0, HOOK_FILES_MAX)) {
      const full = join(dir, name)
      const st = lstatSync(full)
      // A link is recorded by its target and never followed; a regular file by content; anything else cannot be compared.
      const what = st.isSymbolicLink() ? `link:${readlinkSync(full)}` : st.isDirectory() ? 'dir' : st.isFile() ? fileDigest(full) : unreadable()
      parts.push(`${name}\0${what}`)
    }
    if (names.length > HOOK_FILES_MAX) parts.push(`+${names.length - HOOK_FILES_MAX}`)
    return sha(parts.join('\n'))
  } catch {
    return unreadable()
  }
}

/** The folders of `files` and the root, relative with '/', the root first, at most ATTR_DIRS_MAX. */
export function attributeDirsOf(files: readonly string[]): string[] {
  const dirs = new Set<string>([''])
  for (const f of files) {
    const parts = f.replace(/\\/g, '/').split('/').filter(Boolean)
    parts.pop()
    let at = ''
    for (const p of parts) {
      at = at ? `${at}/${p}` : p
      dirs.add(at)
      if (dirs.size >= ATTR_DIRS_MAX) return [...dirs]
    }
  }
  return [...dirs]
}

/** The untracked `.gitattributes` files of `dirs` (content digests); a tracked one is reviewed content and left out. */
async function attributesDigest(root: string, dirs: readonly string[]): Promise<string> {
  const rels = dirs.map((d) => (d ? `${d}/.gitattributes` : '.gitattributes'))
  const tracked = await gitGuarded(root, ['ls-files', '-z', '--', ...rels], BIG)
  if (!tracked.ok) return unreadable()
  const known = new Set(tracked.out.split('\0').filter(Boolean))
  const parts: string[] = []
  for (const rel of rels) {
    if (known.has(rel)) continue
    const d = fileDigest(join(root, ...rel.split('/')))
    if (d !== 'none') parts.push(`${rel}\0${d}`)
  }
  return sha(parts.join('\n'))
}

/** Read the pin of `root` now. Never throws. `attrDirs`: the folders whose `.gitattributes` are looked at (default the root). */
export async function pinRoot(root: string, opts: { attrDirs?: readonly string[] } = {}): Promise<RootPin> {
  const gen = orgAiGeneration(root)
  const attrDirs = opts.attrDirs?.length ? [...opts.attrDirs] : ['']
  const bin = gitExecutable()
  const head = await gitGuarded(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const branch = await gitGuarded(root, ['symbolic-ref', '--quiet', 'HEAD'])
  const index = await gitGuarded(root, ['ls-files', '--stage', '-z'], BIG)
  let worktree: string
  let filesRaw: string | undefined
  if (!bin) worktree = unreadable()
  else if (await hasRepoFilterDriver(bin, root)) {
    worktree = 'not pinned'
    filesRaw = 'not pinned'
  } else {
    const diff = await gitGuarded(root, ['diff-files', '--raw', '-z', '--no-ext-diff', '--no-textconv'], BIG)
    worktree = diff.ok ? sha(diff.out) : unreadable()
    if (diff.ok) filesRaw = diff.out
  }
  // Staged differences against HEAD, plus the working tree's against the index: unchanged by a merge of other files.
  const staged = head.ok && head.out ? await gitGuarded(root, ['diff-index', '--cached', '--raw', '-z', '--no-ext-diff', '--no-textconv', 'HEAD'], BIG) : undefined
  const changes = staged?.ok && filesRaw !== undefined ? sha(`${staged.out}\0\0${filesRaw}`) : unreadable()
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
    changes,
    config: sha([fileDigest(local), fileDigest(perWorktree), fileDigest(attributes)].join('|')),
    attributes: await attributesDigest(root, attrDirs),
    hooks: hooksDigest(common ? join(common, 'hooks') : null),
    gen,
    attrDirs
  }
}

const LABELS: Record<Labelled, string> = {
  head: 'its HEAD commit',
  branch: 'the branch it is on',
  index: 'its index (staged changes)',
  worktree: 'its tracked files',
  config: 'the repository config',
  attributes: 'its untracked .gitattributes files',
  hooks: 'the git hooks'
}
const HARD: Labelled[] = ['config', 'attributes', 'hooks']
const SOFT: Labelled[] = ['head', 'branch', 'index', 'worktree']

/** What differs between two readings, in plain words (empty = the same). */
export function pinDrift(was: RootPin, now: RootPin): string[] {
  return (Object.keys(LABELS) as Labelled[]).filter((k) => was[k] !== now[k]).map((k) => LABELS[k])
}

/** The refusal sentence for a drift, ending with what to do. */
export function pinDriftMessage(labels: readonly string[], checkout: string): string {
  return (
    `Not merged: while the project's tests ran, ${labels.join(', ')} of ${checkout} changed. The test command runs repository code as you and can reach ` +
    `that checkout through the shared git folder, and OrgAI cannot tell its changes from yours (a commit or an edit in the project folder while the tests ran), so it does not merge after one. ` +
    `Look at what changed (git log, git status, .git/config, .git/hooks), undo anything you did not mean, then integrate again.`
  )
}

/**
 * The checkout against an earlier pin:
 * - same: nothing moved;
 * - orgai: HEAD, the index and tracked files moved only through merges (or the main-branch switch) OrgAI itself recorded, and
 *   the changes against HEAD are as they were: `pin` is the reading now and the merge goes on;
 * - hard: the config, the hooks or an untracked `.gitattributes` moved (always a refusal, whoever did it);
 * - folder: HEAD, the index or tracked files moved by something other than OrgAI (the test command, or the user): `pin` is the
 *   reading now, for a caller that asks the user and goes on.
 */
export type PinVerdict =
  | { kind: 'same' | 'orgai'; pin: RootPin }
  | { kind: 'hard'; labels: string[] }
  | { kind: 'folder'; labels: string[]; pin: RootPin; was: RootPin }

export async function rootVerdict(root: string, was: RootPin): Promise<PinVerdict> {
  const now = await pinRoot(root, { attrDirs: was.attrDirs })
  const all = pinDrift(was, now)
  if (!all.length) return { kind: 'same', pin: now }
  if (HARD.some((k) => was[k] !== now[k])) return { kind: 'hard', labels: all }
  const explained = movedOnlyByOrgAi(root, { head: was.head, branch: was.branch }, was.gen, { head: now.head, branch: now.branch })
  if (explained && was.changes === now.changes) return { kind: 'orgai', pin: now }
  // OrgAI's own moves explain HEAD but not the files: the tracked files (or the index) were changed as well.
  const labels = explained ? [LABELS.worktree] : SOFT.filter((k) => was[k] !== now[k]).map((k) => LABELS[k])
  return { kind: 'folder', labels, pin: now, was }
}

/** The drift sentence of `root` against an earlier pin, or undefined when nothing moved (or only OrgAI's own merges did). */
export async function rootDrift(root: string, was: RootPin): Promise<string | undefined> {
  const v = await rootVerdict(root, was)
  return v.kind === 'hard' || v.kind === 'folder' ? pinDriftMessage(v.labels, root) : undefined
}


/**
 * Control, invisible and bidirectional-override code points (C0, DEL, C1, soft hyphen, Arabic letter mark, Mongolian vowel
 * separator, zero-width and direction marks, line and paragraph separators and embeddings, word joiner and invisible operators,
 * isolates, BOM, interlinear annotation): repository text is shown without them. Written as code points, not as a pattern.
 */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]
]

function stripHidden(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    // A line break is kept so the text can be cut into lines; every other hidden code point goes.
    if (c === 0x0a || !HIDDEN_RANGES.some(([a, b]) => c >= a && c <= b)) out += ch
  }
  return out
}

const NOTE_COMMITS = 5
/** Lines and bytes of each stat block of the re-ask note (what comes from the repository is bounded). */
const NOTE_STAT_LINES = 12
const NOTE_STAT_BYTES = 1600
const NOTE_LINE_CHARS = 120
const NOTE_STAT_OPTIONS = ['diff', '--stat=100,60', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']

/** Repository text as plain text: hidden characters removed, each line clamped, at most `maxLines` lines and `maxBytes` bytes. */
export function plainRepositoryText(text: string, maxLines: number, maxBytes: number): string {
  const lines = stripHidden(text)
    .split('\n')
    .map((l) => (l.length > NOTE_LINE_CHARS ? `${l.slice(0, NOTE_LINE_CHARS)}...` : l).trimEnd())
    .filter((l) => l.length > 0)
  const kept: string[] = []
  let bytes = 0
  for (const l of lines.slice(0, maxLines)) {
    bytes += Buffer.byteLength(l, 'utf8') + 1
    if (bytes > maxBytes) break
    kept.push(l)
  }
  if (kept.length < lines.length) kept.push(`... ${lines.length - kept.length} more line${lines.length - kept.length === 1 ? '' : 's'} not shown`)
  return kept.join('\n')
}

/**
 * The plain reason shown when the user is asked again after the project folder changed while the tests ran, in the review
 * card's existing `stat` text field (nothing in the card's own fields changes). It says plainly that the project folder itself
 * changed and that approving merges the report on top of that change, and carries a bounded summary of the root's own change,
 * labelled as text from the repository: commit subjects (at most five), `git diff --stat` between the two HEADs, and the stat of
 * the staged and the unstaged changes (the unstaged one only when the repository has no filter driver of its own, as the pin).
 * Every git call goes through the guarded runner and runs no external diff or textconv program. Repository text (subjects, file
 * names) is stripped of control and bidirectional characters and clamped; this function never throws.
 */
export async function folderChangeNote(root: string, was: RootPin, now: RootPin): Promise<string> {
  const parts: string[] = []
  const blocks: string[] = []
  const moved = was.head !== now.head && was.head !== 'none' && now.head !== 'none'
  if (moved) {
    const log = await gitGuarded(root, ['log', '--format=%h %s', '--no-show-signature', '-n', String(NOTE_COMMITS), `${was.head}..${now.head}`])
    const subjects = log.ok && log.out ? plainRepositoryText(log.out, NOTE_COMMITS + 1, NOTE_STAT_BYTES) : ''
    if (subjects) {
      parts.push('new commits')
      blocks.push(`Commits (up to ${NOTE_COMMITS}):\n${subjects.split('\n').map((l) => `  ${l}`).join('\n')}`)
    } else parts.push('HEAD moved')
    const stat = await gitGuarded(root, [...NOTE_STAT_OPTIONS, `${was.head}..${now.head}`, '--'], { maxBuffer: 4 * 1024 * 1024 })
    if (stat.ok && stat.out) blocks.push(`Changed by those commits (git diff --stat):\n${plainRepositoryText(stat.out, NOTE_STAT_LINES, NOTE_STAT_BYTES)}`)
  } else if (was.head !== now.head) parts.push('HEAD moved')
  if (was.branch !== now.branch) parts.push('the checked-out branch changed')
  if (was.changes !== now.changes) {
    parts.push('tracked files or staged changes differ')
    const bin = gitExecutable()
    if (now.head !== 'none') {
      const staged = await gitGuarded(root, [...NOTE_STAT_OPTIONS, '--cached', 'HEAD', '--'], { maxBuffer: 4 * 1024 * 1024 })
      if (staged.ok && staged.out) blocks.push(`Staged now (git diff --cached --stat):\n${plainRepositoryText(staged.out, NOTE_STAT_LINES, NOTE_STAT_BYTES)}`)
    }
    if (bin && !(await hasRepoFilterDriver(bin, root))) {
      const unstaged = await gitGuarded(root, [...NOTE_STAT_OPTIONS, '--'], { maxBuffer: 4 * 1024 * 1024 })
      if (unstaged.ok && unstaged.out) blocks.push(`Edited, not staged (git diff --stat):\n${plainRepositoryText(unstaged.out, NOTE_STAT_LINES, NOTE_STAT_BYTES)}`)
    } else blocks.push('Edits that are not staged are not listed: this repository defines its own filter program, which OrgAI does not run.')
  }
  const head =
    `The project folder changed while the tests ran (${parts.length ? parts.join('; ') : 'something moved'}). ` +
    `The project folder itself changed while the tests ran, not only the copy they ran in: if you approve, OrgAI merges the report on top of that change, in the folder as it is now. Merge it there?`
  if (!blocks.length) return head
  return `${head}\n\nThe lines below are text from the repository (commit subjects, file names), not from OrgAI:\n${blocks.join('\n')}`
}
