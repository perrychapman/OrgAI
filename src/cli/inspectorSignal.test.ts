import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { disableInspectorSignal } from './inspectorSignal'

const here = fileURLToPath(new URL('.', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'orgai-sig-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A child Node that loads the real module (when `guard`), signals itself and reports whether the inspector opened. */
function probe(guard: boolean): string {
  const guardJs = transformSync(readFileSync(join(here, 'inspectorSignal.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
  writeFileSync(join(dir, 'guard.mjs'), guardJs)
  writeFileSync(
    join(dir, 'probe.mjs'),
    [
      "import inspector from 'node:inspector'",
      "if (process.argv[2] === 'guard') await import('./guard.mjs')",
      "process.kill(process.pid, 'SIGUSR1')",
      "setTimeout(() => { process.stdout.write(inspector.url() ? 'open' : 'closed'); process.exit(0) }, 500)"
    ].join('\n')
  )
  // --inspect-port=0: if the inspector does open, it takes a free port, never 9229.
  const r = spawnSync(process.execPath, ['--inspect-port=0', join(dir, 'probe.mjs'), guard ? 'guard' : 'plain'], { encoding: 'utf8', timeout: 10_000 })
  return r.stdout.trim()
}

describe('the inspector signal', () => {
  it.runIf(process.platform !== 'win32')('without the module SIGUSR1 opens the inspector (the probe can tell); with it, it does not', () => {
    expect(probe(false)).toBe('open')
    expect(probe(true)).toBe('closed')
  })

  it('installs one listener, once, and nothing on Windows', () => {
    const added: string[] = []
    const listeners: (() => void)[] = []
    const proc = { platform: 'darwin' as NodeJS.Platform, on: (sig: string, fn: () => void) => (added.push(sig), listeners.push(fn), proc), listeners: () => listeners }
    disableInspectorSignal(proc as never)
    disableInspectorSignal(proc as never)
    expect(added).toEqual(['SIGUSR1'])
    const win = { platform: 'win32' as NodeJS.Platform, on: () => {
      throw new Error('no')
    }, listeners: () => [] }
    expect(() => disableInspectorSignal(win as never)).not.toThrow()
  })

  it('bin.ts (the bundle entry) and index.ts import it before anything else; bin.ts loads the rest of the CLI only after', () => {
    for (const f of ['bin.ts', 'index.ts']) {
      const src = readFileSync(join(here, f), 'utf8')
      expect(/^import\s.*$/m.exec(src)?.[0], f).toBe("import './inspectorSignal'")
    }
    const bin = readFileSync(join(here, 'bin.ts'), 'utf8')
    expect(bin.match(/^import\s.*$/gm)).toEqual(["import './inspectorSignal'"])
    expect(bin).toContain("await import('./index')")
  })
})
