/**
 * The documents the reference service searches: README.md, docs/how-it-works.md and docs/design/*.md except the UX and
 * UI review walks. Vite inlines them at build time (`import.meta.glob` with ?raw, eager), so they travel inside the
 * main chunk and the CLI bundle and nothing is read from disk at run time (a packaged app has no docs folder).
 * Vitest resolves the same glob. Bundled docs are OrgAI's own text, but still go out only inside fences.
 */
const RAW = import.meta.glob(
  [
    '../../../README.md',
    '../../../docs/how-it-works.md',
    '../../../docs/design/*.md',
    '!../../../docs/design/ux-review*',
    '!../../../docs/design/ui-review*'
  ],
  { query: '?raw', import: 'default', eager: true }
)

/** file base name (without .md) -> markdown text, sorted by name. */
export function bundledDocs(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(RAW).sort()) {
    const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    out[base] = RAW[key]
  }
  return out
}
