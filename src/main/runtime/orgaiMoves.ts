import { pathKey } from './repoLock'

/**
 * The ledger of the moves OrgAI itself makes to a checkout's HEAD: a merge into the main checkout (or a parent report's
 * worktree) and the switch to Project.mainBranch that comes before it. The merge gate (rootPin.ts) pins the checkout around
 * the project's test command; a parallel report's merge into the same checkout while the tests ran is OrgAI's normal
 * operation and must not look like drift. Every OrgAI move is recorded here, under the repository lock, with the HEAD it came
 * from and the HEAD it produced, and advances a per-checkout generation. A pin carries the generation it was read at; when the
 * checkout's HEAD later differs, it is explained only if the moves recorded since form an unbroken chain from the pinned HEAD
 * to the HEAD now (anything done by someone else in between breaks the chain: the next OrgAI move starts from a HEAD the
 * previous one did not produce).
 *
 * In memory, one process: another OrgAI process (the `orgai` CLI) merging into the same checkout is not in this ledger and
 * reads as a change by someone else. Pure: no git here (worktrees.ts reads the states, rootPin.ts compares).
 */

export interface HeadState {
  /** HEAD's commit, or 'none' (unborn). */
  head: string
  /** The branch ref HEAD is on, or 'detached'. */
  branch: string
}

interface Move {
  gen: number
  from: HeadState
  to: HeadState
}

interface Ledger {
  gen: number
  moves: Move[]
}

/** Moves kept per checkout; a pin older than that cannot be explained and reads as a change by someone else. */
export const ORGAI_MOVES_KEPT = 64

const ledgers = new Map<string, Ledger>()

export const sameHeadState = (a: HeadState, b: HeadState): boolean => a.head === b.head && a.branch === b.branch

/** The generation of `root`'s ledger now (0 before OrgAI moved anything in this process). */
export function orgAiGeneration(root: string): number {
  return ledgers.get(pathKey(root))?.gen ?? 0
}

/** Record that OrgAI moved `root`'s HEAD from `from` to `to`. No-op when it did not move. Call it holding the repository lock. */
export function recordOrgAiMove(root: string, from: HeadState, to: HeadState): void {
  if (sameHeadState(from, to)) return
  const key = pathKey(root)
  const ledger = ledgers.get(key) ?? { gen: 0, moves: [] }
  ledger.gen += 1
  ledger.moves.push({ gen: ledger.gen, from: { ...from }, to: { ...to } })
  if (ledger.moves.length > ORGAI_MOVES_KEPT) ledger.moves.splice(0, ledger.moves.length - ORGAI_MOVES_KEPT)
  ledgers.set(key, ledger)
}

/**
 * True when HEAD of `root` went from `was` (read at generation `wasGen`) to `now` only through moves OrgAI recorded: every
 * generation since is still held, and each starts where the one before ended.
 */
export function movedOnlyByOrgAi(root: string, was: HeadState, wasGen: number, now: HeadState): boolean {
  const ledger = ledgers.get(pathKey(root))
  if (!ledger || ledger.gen <= wasGen) return false
  const since = ledger.moves.filter((m) => m.gen > wasGen)
  if (since.length !== ledger.gen - wasGen || since[0]?.gen !== wasGen + 1) return false
  let at = was
  for (const m of since) {
    if (!sameHeadState(m.from, at)) return false
    at = m.to
  }
  return sameHeadState(at, now)
}

/** Forget every recorded move (tests). */
export function resetOrgAiMoves(): void {
  ledgers.clear()
}
