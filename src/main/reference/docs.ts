/**
 * The documents the reference service searches: README.md, docs/how-it-works.md and docs/design/*.md except the UX and
 * UI review walks and the withdrawn or superseded CLI designs. Vite inlines them at build time (`import.meta.glob` with ?raw), so they travel inside the
 * main bundle and the CLI bundle and nothing is read from disk at run time (a packaged app has no docs folder). The glob is
 * lazy: each document is its own small chunk that loads on the first reference query (`loadBundledDocs`), so a host that
 * never answers one (every `orgai exec`) never parses roughly 1 MB of markdown.
 * Vitest resolves the same glob. Bundled docs are OrgAI's own text, but still go out only inside fences.
 */
const RAW = import.meta.glob(
  [
    '../../../README.md',
    '../../../docs/how-it-works.md',
    '../../../docs/design/*.md',
    '!../../../docs/design/ux-review*',
    '!../../../docs/design/ui-review*',
    // Withdrawn or superseded by cli-standalone-default.md (the daemon, --host and Terminal access): the CLI command
    // table comes from commandTable.ts instead.
    '!../../../docs/design/cli-approvals.md',
    '!../../../docs/design/cli-spec.md',
    '!../../../docs/design/cli-standalone.md'
  ],
  { query: '?raw', import: 'default' }
)

let loaded: Record<string, string> | undefined
let loading: Promise<Record<string, string>> | undefined

/** file base name (without .md) -> markdown text, sorted by name. Loads every document once and caches the result. */
export function loadBundledDocs(): Promise<Record<string, string>> {
  return (loading ??= (async () => {
    const out: Record<string, string> = {}
    for (const key of Object.keys(RAW).sort()) {
      const base = key.slice(key.lastIndexOf('/') + 1).replace(/\.md$/i, '')
      out[base] = await RAW[key]()
    }
    loaded = out
    return out
  })())
}

/**
 * The same map, synchronously, once `loadBundledDocs()` has resolved. Throws before that: the documents are loaded
 * lazily and no sync read exists. Callers inside a service or test await `loadBundledDocs()` first.
 */
export function bundledDocs(): Record<string, string> {
  if (!loaded) throw new Error('The bundled docs are not loaded yet; await loadBundledDocs() first.')
  return loaded
}
