import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildContext, FIRST_START_NOTE, resetDesktopEnvNote, reusableInproc } from './context'
import { fakeInproc } from './testing/fakeContext'
import { CliError, EXIT, type CliIo, type InprocStartOptions } from './types'

describe('reusableInproc', () => {
  it('shares one start while the host runs, starts a new one after it closed, and forgets a failed start', async () => {
    const handles = [fakeInproc(), fakeInproc(), fakeInproc()]
    const opts: (InprocStartOptions | undefined)[] = []
    let fail = false
    let next = 0
    const start = reusableInproc(async (o) => {
      opts.push(o)
      if (fail) throw new Error('owned by another host')
      return handles[next++]
    })
    const a = start({ background: { modelDiscovery: false } })
    const b = start()
    expect(await a).toBe(await b)
    expect(opts).toEqual([{ background: { modelDiscovery: false } }])
    // withHost stopped it (init's first step); the Architect's ensureHost gets a fresh host.
    await (await a).stop(true)
    const c = await start()
    expect(c).toBe(handles[1])
    expect(opts).toEqual([{ background: { modelDiscovery: false } }, {}])
    await c.stop(true)
    fail = true
    await expect(start()).rejects.toThrow('owned by another host')
    fail = false
    expect(await start()).toBe(handles[2])
  })
})

describe('buildContext', () => {
  const tmp: string[] = []
  const fresh = (): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-ctx-')))
    tmp.push(d)
    return d
  }
  afterEach(() => {
    for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
    resetDesktopEnvNote()
  })
  const sink = (): { io: CliIo; err: () => string } => {
    let err = ''
    return { io: { stdout: { write: () => true }, stderr: { write: (c: string) => ((err += c), true) }, stdinIsTTY: false } as unknown as CliIo, err: () => err }
  }
  const baseFor = (dir: string, extraEnv: NodeJS.ProcessEnv = {}, io: CliIo = sink().io) => ({
    globals: { outputFormat: 'text' as const, color: false, secretEnv: [] },
    env: { ORGAI_CLI_DATA_DIR: dir, ...extraEnv },
    cwd: dir,
    platform: 'linux' as const,
    io
  })

  it('prints the first-start note once: a new folder says orgai is separate from the app, an existing one is quiet', () => {
    const dir = join(fresh(), 'cli')
    const first = sink()
    buildContext(baseFor(dir, {}, first.io))
    expect(first.err()).toBe(`${FIRST_START_NOTE}\n`)
    const second = sink()
    buildContext(baseFor(dir, {}, second.io))
    expect(second.err()).toBe('')
  })

  it('marks a fresh folder for the CLI (0600) and keeps a CLI folder usable', () => {
    const dir = join(fresh(), 'cli')
    buildContext(baseFor(dir))
    expect(JSON.parse(readFileSync(join(dir, 'product.json'), 'utf8'))).toEqual({ product: 'orgai-cli', version: 1 })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'product.json')).mode & 0o777).toBe(0o600)
    expect(() => buildContext(baseFor(dir))).not.toThrow()
  })

  it('refuses a desktop-marked folder with exit 2 before writing anything', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'product.json'), JSON.stringify({ product: 'orgai-desktop', version: 1 }))
    let thrown: unknown
    try {
      buildContext(baseFor(dir))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).exitCode).toBe(EXIT.usage)
    expect((thrown as CliError).message).toBe(`${dir} belongs to the OrgAI app. orgai keeps its own data; choose another folder.`)
    expect(existsSync(join(dir, 'data'))).toBe(false)
  })

  it('refuses an unmarked folder whose data/ is not empty', () => {
    const dir = fresh()
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'projects.json'), '[]')
    expect(() => buildContext(baseFor(dir))).toThrow('belongs to the OrgAI app')
    expect(existsSync(join(dir, 'product.json'))).toBe(false)
  })

  it('prints the ORGAI_DATA_DIR note once per process, and only without a CLI override', () => {
    const home = fresh()
    const noOverride = (io: CliIo) => ({ ...baseFor(home, { ORGAI_DATA_DIR: '/app' }, io), env: { ORGAI_DATA_DIR: '/app' }, home })
    const a = sink()
    buildContext(noOverride(a.io))
    buildContext(noOverride(a.io))
    expect(a.err().split("ORGAI_DATA_DIR is the OrgAI app's setting; orgai uses ORGAI_CLI_DATA_DIR.\n")).toHaveLength(2)
    expect(a.err()).toContain(FIRST_START_NOTE)
    expect(existsSync(join(home, '.config', 'orgai-cli', 'product.json'))).toBe(true)
    resetDesktopEnvNote()
    const b = sink()
    buildContext({ ...baseFor(join(home, 'other'), { ORGAI_DATA_DIR: '/app' }, b.io), home })
    expect(b.err()).not.toContain('ORGAI_DATA_DIR')
  })
})
