/**
 * Project identity on the Dashboard (docs/design/dashboard-overhaul.md "Visual pass"): a stable hue and a monogram per
 * project, so the same project looks the same in Pick up, Today, Working now, Your week and the project tiles. Pure.
 *
 * The hue is one of PROJECT_HUES fixed tokens (`--project-1` .. `--project-8` in tokens.css, measured in both themes),
 * picked by a hash of the project id, never of its name: renaming a project keeps its colour. Colour is never the only
 * signal; the monogram and the name always sit beside it.
 */

export const PROJECT_HUES = 8

/** 32-bit FNV-1a over UTF-16 code units: stable across runs and platforms, cheap, well spread for short ids. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The hue a project id hashes to, 1..PROJECT_HUES, before collisions are resolved. */
export function hashedHue(projectId: string): number {
  return (fnv1a(projectId) % PROJECT_HUES) + 1
}

/**
 * Hues for a list of projects in their stored order (creation order), so up to PROJECT_HUES projects never share a hue:
 * each takes its hashed hue, or, when an earlier project holds it, the next hue (wrapping) among the least used. A new
 * project appended to the list never changes the hue of an earlier one; deleting a project may shift later ones that had
 * collided. Pure.
 */
export function assignProjectHues(projectIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const used = new Array<number>(PROJECT_HUES + 1).fill(0)
  for (const id of projectIds) {
    if (!id || out.has(id)) continue
    const start = hashedHue(id)
    const least = Math.min(...used.slice(1))
    let hue = start
    for (let k = 0; k < PROJECT_HUES; k++) {
      const h = ((start - 1 + k) % PROJECT_HUES) + 1
      if (used[h] === least) {
        hue = h
        break
      }
    }
    used[hue]++
    out.set(id, hue)
  }
  return out
}

/** The assignment for the projects the renderer knows now; set by `useProjectHueRegistry` (DashboardView). */
let registry: Map<string, number> = new Map()
let registryKey = ''

/** Replace the known-project assignment (idempotent for the same id list). */
export function registerProjectHues(projectIds: readonly string[]): void {
  const key = projectIds.join('\u0000')
  if (key === registryKey) return
  registryKey = key
  registry = assignProjectHues(projectIds)
}

/**
 * The hue index 1..PROJECT_HUES for a project id: the registered assignment when the project is known, else its hashed
 * hue. An empty id (Chat, no project) gets 0: the neutral mark.
 */
export function projectHue(projectId: string | null | undefined): number {
  if (!projectId) return 0
  return registry.get(projectId) ?? hashedHue(projectId)
}

/** The CSS colour for a hue index: `var(--project-N)`, or the neutral `var(--text-tertiary)` for 0. */
export function projectHueVar(hue: number): string {
  return hue >= 1 && hue <= PROJECT_HUES ? `var(--project-${hue})` : 'var(--text-tertiary)'
}

/** Words of a name, splitting on spaces, punctuation and camelCase / digit boundaries; letters and digits only. */
function words(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
}

/**
 * The monogram: the first letters of the first two words ("Billing API" -> "BA"), one word gives its first letter
 * ("orgai" -> "O"), uppercased. A name with no letter or digit gives "?" so the badge is never blank. A parenthetical
 * suffix ("E2E dash busy (orgai test)") is ignored, so it does not take the second letter.
 */
export function projectMonogram(name: string | null | undefined): string {
  const base = (name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim() || (name ?? '')
  const w = words(base)
  if (w.length === 0) return '?'
  const first = [...w[0]][0] ?? ''
  const second = w.length > 1 ? ([...w[1]][0] ?? '') : ''
  return (first + second).toLocaleUpperCase()
}
