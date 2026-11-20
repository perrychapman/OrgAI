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

/** The hue index 1..PROJECT_HUES for a project id. An empty id (Chat, no project) gets 0: the neutral mark. */
export function projectHue(projectId: string | null | undefined): number {
  if (!projectId) return 0
  return (fnv1a(projectId) % PROJECT_HUES) + 1
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
