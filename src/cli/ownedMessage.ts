/**
 * The words for "another orgai owns this data folder" (cli-standalone-default.md 4.2): the exit 6 refusal of a command
 * that needs a host, and the snapshot line of a read-only command that reads the files beside the owner.
 */
import type { DaemonInfo } from '../shared/types'

/** What the refusal knows of the owner: daemon.json's pid and ownerCwd, or just a pid, or nothing (a starting owner). */
export interface OwnerWords {
  pid?: number
  ownerCwd?: string
}

/** Exit 6 text: "orgai is already running in another terminal (<ownerCwd>, pid <pid>). Use that one, or quit it first." */
export function ownedMessage(owner: OwnerWords = {}): string {
  const where = owner.ownerCwd && owner.pid ? ` in another terminal (${owner.ownerCwd}, pid ${owner.pid})` : owner.pid ? ` (pid ${owner.pid})` : ''
  return `orgai is already running${where}. Use that one, or quit it first.`
}

/** The owner words of a daemon.json record. */
export function ownerWordsOf(info: Pick<DaemonInfo, 'pid' | 'ownerCwd'> | null | undefined): OwnerWords {
  return info ? { pid: info.pid, ...(info.ownerCwd ? { ownerCwd: info.ownerCwd } : {}) } : {}
}

/** The line a read-only command prints when it answers from the files beside a running owner. */
export const SNAPSHOT_NOTE = 'orgai is running in another terminal; this is a saved snapshot.'
