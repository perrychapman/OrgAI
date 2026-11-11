/** Wording for compactions of an agent's conversation (RunEvent agent.compacted, AgentInstance.compactions). Pure. */

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st... */
export function ordinal(n: number): string {
  const v = Math.max(0, Math.floor(n))
  const tens = v % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : v % 10 === 1 ? 'st' : v % 10 === 2 ? 'nd' : v % 10 === 3 ? 'rd' : 'th'
  return `${v}${suffix}`
}

/** "Lead compacted its context (3rd time)." */
export function compactionLine(name: string, count: number): string {
  return `${name} compacted its context (${ordinal(count)} time).`
}

/** "compacted 3x" for an agent row, '' for none. */
export function compactionCount(count: number | undefined): string {
  return count && count > 0 ? `compacted ${count}x` : ''
}
