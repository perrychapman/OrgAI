/**
 * Run labels. Every run of a project gets a stable index by start order (R1 is the oldest). The index repeats on
 * the run tab, the run header and the transcript header, so one run is recognisable everywhere.
 */

interface Indexed {
  id: string
  startedAt: number
}

/** run id -> 1-based index, by start order (ties broken by id). Pass every known run of ONE project. */
export function runIndexMap(runs: readonly Indexed[]): Map<string, number> {
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const out = new Map<string, number>()
  sorted.forEach((r, i) => out.set(r.id, i + 1))
  return out
}

/** "R2", or "R?" while the run is not known to its project yet. */
export const runTag = (index: number | undefined): string => (index ? `R${index}` : 'R?')

/** One-line prompt text. Image-only prompts read "Image prompt". */
export function promptLine(prompt: string | undefined): string {
  return (prompt ?? '').replace(/\s+/g, ' ').trim() || 'Image prompt'
}

/** The prompt cut to `max` characters with an ellipsis. */
export function shortPrompt(prompt: string | undefined, max = 32): string {
  const text = promptLine(prompt)
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** "R2: Add caching", the name decision cards and menus use for a run. */
export const runTitle = (index: number | undefined, prompt: string | undefined, max = 40): string => `${runTag(index)}: ${shortPrompt(prompt, max)}`
