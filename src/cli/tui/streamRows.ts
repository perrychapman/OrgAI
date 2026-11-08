import type { TranscriptRow } from './types'

/** Conservative display classification, not shell parsing or an authorization rule. */
export function isCompoundCommand(command: string): boolean {
  return /[;&|`<>\r\n]|\$\(/.test(command)
}

/** Display-only shell unwrapping; the original command stays available in tool details. */
export function commandSummary(command: string): string {
  const wrapped = /^\s*(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh|dash|ksh)\s+-(?:lc|c|ic|lic)\s+([\s\S]+)$/.exec(command)
  let body = wrapped?.[1]?.trim() ?? command
  if (wrapped && (body[0] === "'" || body[0] === '"')) {
    const quote = body[0]
    for (let i = 1; i < body.length; i++) {
      if (quote === '"' && body[i] === '\\') { i++; continue }
      if (body[i] !== quote) continue
      if (i === body.length - 1) body = body.slice(1, -1)
      break // The first unescaped closing quote must enclose the whole argument.
    }
  }
  return body.replace(/\s+/g, ' ').trim()
}

/** Fold only positively matched successes; pending calls, orphan results and failures remain visible. */
export function compactToolRows(rows: readonly TranscriptRow[], expanded = false): TranscriptRow[] {
  if (expanded) return rows.map(row => row.detail ? { ...row, text: row.detail } : row)
  const out: TranscriptRow[] = []
  for (let i = 0; i < rows.length;) {
    const first = rows[i]!
    if (first.kind !== 'tool' && first.kind !== 'result') { out.push(first); i++; continue }
    const start = i
    while (i < rows.length && ['tool', 'result'].includes(rows[i].kind) && rows[i].agentId === first.agentId && rows[i].runId === first.runId) i++
    const block = rows.slice(start, i)
    const matched = new Set<string>()
    const consumed = new Set<string>()
    const callsById = new Map<string, number[]>()
    const resultsById = new Map<string, number[]>()
    block.forEach((row, at) => {
      if (!row.toolUseId) return
      const index = row.kind === 'tool' ? callsById : resultsById
      const positions = index.get(row.toolUseId) ?? []
      positions.push(at)
      index.set(row.toolUseId, positions)
    })
    for (let at = 0; at < block.length; at++) {
      const call = block[at]!
      if (call.kind !== 'tool') continue
      const calls = call.toolUseId ? callsById.get(call.toolUseId) ?? [] : [at]
      const results = call.toolUseId
        ? resultsById.get(call.toolUseId) ?? []
        : block[at + 1]?.kind === 'result' && !block[at + 1]?.toolUseId ? [at + 1] : []
      if (calls.length === 1 && results.length === 1 && results[0] > at && !consumed.has(block[results[0]].key)) {
        matched.add(call.key)
        consumed.add(block[results[0]].key)
      }
    }
    let completed: TranscriptRow[] = []
    const flush = () => {
      if (!completed.length) return
      const row = completed[0]!
      out.push({ ...row, text: completed.length === 1 ? row.summary ?? row.text : `${completed.length} tool calls completed` })
      completed = []
    }
    for (const row of block) {
      if (matched.has(row.key)) completed.push(row)
      else if (!consumed.has(row.key)) {
        flush()
        const label = row.pendingSummary ?? row.summary
        out.push(label ? { ...row, text: label } : row)
      }
    }
    flush()
  }
  return out
}
