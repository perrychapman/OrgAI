/**
 * Cross-run messages reach a run's transcript as persisted system rows on its root, written by the main process:
 *   "Sent to run <id> (<project>: <prompt>): <text>"
 *   "Note from run <id> (<project>: <prompt>), from its orchestrator: <text>"
 * The renderer shows them as a sender row and a tinted receiver row. Everything here is peer-controlled text:
 * callers must render `body` and `peer` as plain text, never Markdown.
 */
export interface PeerNote {
  direction: 'out' | 'in'
  /** The other run's id. */
  runId: string
  /** "<project>: <prompt>" of the other run, as the harness wrote it. */
  peer: string
  /** The message itself. */
  body: string
}

const OUT = /^Sent to run (\S+) \(([\s\S]*?)\): ([\s\S]*)$/
const IN = /^Note from run (\S+) \(([\s\S]*?)\), from its orchestrator: ([\s\S]*)$/

/** Parses a cross-run system row; null for any other text. */
export function parsePeerNote(text: string): PeerNote | null {
  const out = OUT.exec(text)
  if (out) return { direction: 'out', runId: out[1], peer: out[2], body: out[3] }
  const inn = IN.exec(text)
  if (inn) return { direction: 'in', runId: inn[1], peer: inn[2], body: inn[3] }
  return null
}
