import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// cli-spec 5.1: Ink loads only when the TUI starts. Every command other than the TUI must run without ink or react,
// so the STATIC import graph from src/cli/index.ts (dynamic `import(` and `import type` skipped) never reaches them.

const here = dirname(fileURLToPath(import.meta.url))
const FORBIDDEN = new Set(['ink', 'react', 'react/jsx-runtime', 'ink-testing-library'])

/** Static value imports and re-exports of a module's source text (type-only ones excluded). */
export function staticSpecifiers(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const re = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g
  for (const m of text.matchAll(re)) {
    if (m[5]) {
      out.push(m[5])
      continue
    }
    if (m[2]) continue
    const clause = (m[3] ?? '').trim()
    // `import { type A, type B } from` is type-only too.
    const named = /^\{([^}]*)\}$/.exec(clause)
    if (named && named[1].split(',').every((p) => p.trim() === '' || /^type\s/.test(p.trim()))) continue
    out.push(m[4])
  }
  return out
}

function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec)
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (/\.(ts|tsx|js|mjs)$/.test(cand) && existsSync(cand)) return cand
  }
  return undefined
}

function walk(entry: string): { files: Set<string>; bad: string[] } {
  const files = new Set<string>()
  const bad: string[] = []
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop() as string
    if (files.has(file)) continue
    files.add(file)
    if (file.endsWith('.tsx')) bad.push(`${file} is a .tsx module`)
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (FORBIDDEN.has(spec) || spec.startsWith('ink/') || spec.startsWith('react/')) {
        bad.push(`${file} imports ${spec}`)
        continue
      }
      if (!spec.startsWith('.')) continue
      const target = resolveRelative(file, spec)
      if (target) stack.push(target)
    }
  }
  return { files, bad }
}

describe('lazy TUI import graph', () => {
  it('parses static, type-only and dynamic imports apart', () => {
    const src = [
      "import { a } from './a'",
      "import type { B } from './b'",
      "import { type C, type D } from './c'",
      "import { type E, f } from './e'",
      "export { g } from './g'",
      "export type { H } from './h'",
      "import './side'",
      "const t = await import('./tui/index')",
      "// import { x } from 'ink'"
    ].join('\n')
    expect(staticSpecifiers(src).sort()).toEqual(['./a', './e', './g', './side'])
  })

  it('src/cli/index.ts never statically reaches ink, react or a .tsx module', () => {
    const { files, bad } = walk(resolve(here, 'index.ts'))
    expect(files.size).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })

  it('commands/tui.ts reaches the TUI only through a dynamic import', () => {
    const { bad } = walk(resolve(here, 'commands/tui.ts'))
    expect(bad).toEqual([])
    expect(readFileSync(resolve(here, 'commands/tui.ts'), 'utf8')).toMatch(/import\(\s*['"]\.\.\/tui\/index['"]\s*\)/)
  })
})
