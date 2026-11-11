/**
 * Model lineage and version comparison from ids alone (no catalog metadata): which model in a list is the newest of
 * its family. Handles ids like `claude-opus-4-1-20250805`, `claude-opus-5-5`, `claude-3-5-sonnet-20241022`,
 * `claude-sonnet-5-5[1m]`, `anthropic/claude-opus-5-5`, `gpt-6.1-sol`, `gpt-5-mini`. A model whose id does not read as
 * name + version (an alias such as `opus`, `inherit`, an opaque proxy name) has no family: callers must then not warn.
 * Pure; no dependencies.
 */

export interface ParsedModelId {
  /** The non-numeric name parts joined by '-', e.g. "claude-opus", "gpt-sol", "claude-sonnet". */
  family: string
  /** Version numbers in order of appearance: claude-opus-4-1 and claude-3-5-sonnet give [4,1] and [3,5]; gpt-6.1-sol [6,1]. */
  version: number[]
}

const DATE_STAMP = /^(19|20)\d{6}$/
const NUMERIC = /^\d+(\.\d+)*$/
const IGNORED = new Set(['latest', 'preview', 'exp', 'experimental'])

/** The family and version of a model id, or undefined when the id does not carry both. */
export function parseModelId(model: string): ParsedModelId | undefined {
  let id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  const names: string[] = []
  const version: number[] = []
  for (const token of id.split(/[-_]/)) {
    if (!token || DATE_STAMP.test(token) || IGNORED.has(token)) continue
    if (NUMERIC.test(token)) version.push(...token.split('.').map(Number))
    else if (/^\d/.test(token)) return undefined
    else names.push(token)
  }
  if (names.length === 0 || version.length === 0 || version.some((n) => !Number.isSafeInteger(n))) return undefined
  return { family: names.join('-'), version }
}

/** Negative when a is older than b, positive when newer, 0 when equal (a missing trailing part counts as 0). */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The id of a strictly newer model of the same family in `catalog`, or undefined when `model` is the newest, its
 * family or version cannot be read, or no catalog id is comparable. When several are newer, the newest is returned.
 */
export function newerInFamily(model: string, catalog: readonly string[]): string | undefined {
  const own = parseModelId(model)
  if (!own) return undefined
  let best: { id: string; version: number[] } | undefined
  for (const id of catalog) {
    const p = parseModelId(id)
    if (!p || p.family !== own.family) continue
    if (compareVersions(p.version, own.version) <= 0) continue
    if (!best || compareVersions(p.version, best.version) > 0) best = { id, version: p.version }
  }
  return best?.id
}
