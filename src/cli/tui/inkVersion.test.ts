import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// cli-spec 5.1: Ink is pinned to an exact React 19-compatible version.

const root = resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}
// ink's exports map hides ./package.json from require.resolve, so read the installed copy by path.
const installed = (name: string): { version: string; peerDependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8'))

const EXACT = /^\d+\.\d+\.\d+$/

function parts(v: string): number[] {
  return v.split('-')[0].split('.').map((n) => Number(n))
}

/** a >= b over major.minor.patch. */
export function gte(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return true
}

describe('ink pins', () => {
  it('ink is an exact runtime dependency and ink-testing-library an exact dev dependency', () => {
    expect(pkg.dependencies.ink).toMatch(EXACT)
    expect(pkg.devDependencies['ink-testing-library']).toMatch(EXACT)
    expect(pkg.devDependencies.ink).toBeUndefined()
  })

  it('the installed versions equal the pins', () => {
    expect(installed('ink').version).toBe(pkg.dependencies.ink)
    expect(installed('ink-testing-library').version).toBe(pkg.devDependencies['ink-testing-library'])
  })

  it("ink's react peer range is satisfied by the installed react", () => {
    const range = installed('ink').peerDependencies?.react ?? ''
    const m = /^>=\s*(\d+\.\d+\.\d+)$/.exec(range.trim())
    expect(m, `unexpected react peer range ${range}`).not.toBeNull()
    expect(gte(installed('react').version, (m as RegExpExecArray)[1])).toBe(true)
  })

  it('compares versions numerically', () => {
    expect(gte('19.3.1', '19.3.0')).toBe(true)
    expect(gte('19.10.0', '19.3.0')).toBe(true)
    expect(gte('19.2.9', '19.3.0')).toBe(false)
  })
})
