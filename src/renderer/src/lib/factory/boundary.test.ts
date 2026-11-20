// Import boundary of the Factory Floor (docs/design/factory-floor.md section 10): the factory and Pocket Office share
// nothing, only the canvas component and its engine load three, and the pure modules stay free of three, React and DOM.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = resolve(__dirname, '..', '..')
const FACTORY_LIB = join(RENDERER_SRC, 'lib', 'factory')
const FACTORY_COMPONENTS = join(RENDERER_SRC, 'components', 'canvas', 'factory')
const OFFICE_LIB = join(RENDERER_SRC, 'lib', 'office')
const OFFICE_COMPONENTS = join(RENDERER_SRC, 'components', 'canvas', 'office')

const SOURCE = /\.(ts|tsx|mts|js|mjs|css)$/

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...filesUnder(p))
    else if (SOURCE.test(name)) out.push(p)
  }
  return out
}

/** Every module specifier in a source file: static imports and re-exports, side-effect imports, import(), CSS @import. */
function specifiers(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]/g
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) found.push(m[1])
  return found
}

/** Absolute path a relative specifier points at, or null for a package or alias specifier. */
function target(file: string, spec: string): string | null {
  if (spec.startsWith('@renderer/')) return join(RENDERER_SRC, spec.slice('@renderer/'.length))
  if (!spec.startsWith('.')) return null
  return resolve(dirname(file), spec)
}

const inside = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + sep)
const rel = (p: string): string => relative(RENDERER_SRC, p).split(sep).join('/')

const factoryFiles = [...filesUnder(FACTORY_LIB), ...filesUnder(FACTORY_COMPONENTS)]
/** Every renderer source file: the three-only and lazy-chunk rules hold app-wide, not only inside the factory folders. */
const rendererFiles = filesUnder(RENDERER_SRC)
const officeFiles = [...filesUnder(OFFICE_LIB), ...filesUnder(OFFICE_COMPONENTS)]
const isTest = (f: string): boolean => /\.test\.(ts|tsx)$/.test(f)

describe('specifiers', () => {
  it('finds every import form and ignores comments', () => {
    const src = [
      "import a from './a'",
      "import type { B } from '../b'",
      "export { c } from './c'",
      "import './d.css'",
      "const e = import('./e')",
      "// import f from './f'",
      "/* import g from './g' */",
      "import {\n  h,\n  i\n} from 'three'"
    ].join('\n')
    expect(specifiers(src)).toEqual(expect.arrayContaining(['./a', '../b', './c', './d.css', './e', 'three']))
    expect(specifiers(src)).not.toContain('./f')
    expect(specifiers(src)).not.toContain('./g')
  })
})

describe('factory import boundary', () => {
  it('has factory and renderer sources to check', () => {
    expect(rendererFiles.some((f) => f.endsWith('LiveRunView.tsx'))).toBe(true)
    expect(factoryFiles.some((f) => f.endsWith('types.ts'))).toBe(true)
    expect(factoryFiles.some((f) => f.endsWith('FactoryScene.tsx'))).toBe(true)
  })

  it('never imports Pocket Office code, styles or assets', () => {
    const bad: string[] = []
    for (const file of factoryFiles) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const t = target(file, spec)
        const office = t ? inside(t, OFFICE_LIB) || inside(t, OFFICE_COMPONENTS) || /[\\/](office[^\\/]*\.css|assets[\\/]office)/.test(t) : /office/i.test(spec)
        if (office) bad.push(`${rel(file)} -> ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('is never imported by Pocket Office', () => {
    const bad: string[] = []
    for (const file of officeFiles) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const t = target(file, spec)
        const factory = t ? inside(t, FACTORY_LIB) || inside(t, FACTORY_COMPONENTS) || /[\\/]factory[^\\/]*\.css$/.test(t) : /factory/i.test(spec)
        if (factory) bad.push(`${rel(file)} -> ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('loads three only from FactoryCanvas, engine/ and builders/', () => {
    const allowed = (f: string): boolean => {
      const r = rel(f)
      return r === 'components/canvas/factory/FactoryCanvas.tsx' || r.startsWith('components/canvas/factory/engine/') || r.startsWith('components/canvas/factory/builders/')
    }
    const bad: string[] = []
    for (const file of rendererFiles) {
      // A pure module's test may import three's math classes (the camera agreement test, section 2).
      if (isTest(file) && inside(file, FACTORY_LIB)) continue
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if ((spec === 'three' || spec.startsWith('three/')) && !allowed(file)) bad.push(`${rel(file)} -> ${spec}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('never loads FactoryCanvas or the engine statically from outside the lazy chunk', () => {
    const bad: string[] = []
    for (const file of rendererFiles) {
      const r = rel(file)
      if (r === 'components/canvas/factory/FactoryCanvas.tsx' || r.includes('/engine/') || r.includes('/builders/')) continue
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\b(?:import|export)\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
        if (/FactoryCanvas|\/engine\/|\/builders\//.test(m[1])) bad.push(`${r} -> ${m[1]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('keeps the pure modules free of React, the DOM layer and other renderer components', () => {
    const bad: string[] = []
    for (const file of filesUnder(FACTORY_LIB)) {
      if (isTest(file)) continue
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec === 'react' || spec.startsWith('react-') || spec.startsWith('react/') || spec === 'three' || spec.startsWith('three/') || spec.includes('/components/')) {
          bad.push(`${rel(file)} -> ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('never uses a runtime code generator, a worker or WASM', () => {
    const bad: string[] = []
    for (const file of factoryFiles) {
      if (isTest(file)) continue
      const src = readFileSync(file, 'utf8')
      if (/\beval\s*\(|\bnew\s+Function\s*\(|\bnew\s+(?:Shared)?Worker\s*\(|WebAssembly\.|URL\.createObjectURL/.test(src)) bad.push(rel(file))
    }
    expect(bad).toEqual([])
  })
})
