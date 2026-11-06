/**
 * Integration: `orgai projects` against a real in-process host over its real socket (cli-spec Wave 5, W5-T1). A
 * `--host inproc daemon start` host owns a temp data dir; every command goes through `main(argv)` with process.stdout /
 * stderr captured and connects to that host as a normal CLI client. Mock adapter only; no tokens.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allowFullTerminalAccess } from '../testing/terminalAccess'
import type { DaemonInfo } from '../../shared/types'

type Main = (argv: string[]) => Promise<number>

describe('orgai projects against a real inproc host', () => {
  let userDataDir: string
  let codeDir: string
  let engDir: string
  let main: Main
  let hostDone: Promise<number>
  const saved = { mock: process.env.ORGAI_MOCK, data: process.env.ORGAI_DATA_DIR }
  let out = ''
  let err = ''

  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const o0 = out.length
    const e0 = err.length
    const code = await main(['--data-dir', userDataDir, '--no-color', ...args])
    return { code, out: out.slice(o0), err: err.slice(e0) }
  }
  const json = async (args: string[]): Promise<{ code: number; doc: Record<string, unknown>; err: string }> => {
    const r = await cli([...args, '--output-format', 'json'])
    let doc: Record<string, unknown> = {}
    try {
      doc = JSON.parse(r.out) as Record<string, unknown>
    } catch {
      throw new Error(`not JSON (exit ${r.code}): ${r.out} ${r.err}`)
    }
    return { code: r.code, doc, err: r.err }
  }

  const daemonInfo = (): DaemonInfo | null => {
    try {
      return JSON.parse(readFileSync(join(userDataDir, 'data', 'run', 'daemon.json'), 'utf8')) as DaemonInfo
    } catch {
      return null
    }
  }

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(realpathSync(tmpdir()), 'orgai-projects-int-'))
    codeDir = join(userDataDir, 'code-repo')
    engDir = join(userDataDir, 'client-folder')
    mkdirSync(codeDir)
    mkdirSync(engDir)
    process.env.ORGAI_MOCK = '1'
    process.env.ORGAI_DATA_DIR = userDataDir
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => ((out += String(s)), true)) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => ((err += String(s)), true)) as typeof process.stderr.write)
    main = ((await import('../index')) as unknown as { main: Main }).main
    // Clients of this host other than its starting context have no owner key: allow them decide / configure (review H2).
    allowFullTerminalAccess(join(userDataDir, 'data'))
    hostDone = main(['--data-dir', userDataDir, '--host', 'inproc', 'daemon', 'start'])
    const end = Date.now() + 30_000
    while (daemonInfo()?.state !== 'ready') {
      if (Date.now() > end) throw new Error('the inproc daemon did not become ready')
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 60_000)

  afterAll(async () => {
    await cli(['daemon', 'stop', '--force']).catch(() => undefined)
    await hostDone?.catch(() => undefined)
    vi.restoreAllMocks()
    process.env.ORGAI_MOCK = saved.mock
    process.env.ORGAI_DATA_DIR = saved.data
    if (saved.mock === undefined) delete process.env.ORGAI_MOCK
    if (saved.data === undefined) delete process.env.ORGAI_DATA_DIR
    rmSync(userDataDir, { recursive: true, force: true })
  }, 30_000)

  it('create (code and engagement), list and check', async () => {
    const code = await json(['projects', 'create', codeDir, '--name', 'Code int'])
    expect(code.code).toBe(0)
    expect(code.doc.project).toMatchObject({ name: 'Code int', kind: 'code', path: codeDir, connection: expect.any(String) })

    const eng = await json(['projects', 'create', engDir, '--kind', 'engagement', '--client', 'Acme Corp'])
    expect(eng.code).toBe(0)
    expect(eng.doc.project).toMatchObject({ name: 'client-folder', kind: 'engagement', client: 'Acme Corp' })

    const again = await cli(['projects', 'create', codeDir])
    expect(again.code).toBe(1)
    expect(again.err).toContain('already the OrgAI project "Code int"')

    const list = await cli(['projects', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/Code int\s+Project/)
    expect(list.out).toMatch(/client-folder\s+Engagement\s+Acme Corp/)

    const check = await json(['projects', 'check', codeDir])
    expect(check.code).toBe(0)
    expect(check.doc.check).toMatchObject({ exists: true, isDirectory: true, existingProjectName: 'Code int' })
  })

  it('set --max-budget 5, then none (cleared through the null codec)', async () => {
    const set = await json(['--project', codeDir, 'projects', 'set', '--max-budget', '5', '--max-depth', '3'])
    expect(set.code).toBe(0)
    expect(set.doc.project).toMatchObject({ maxBudgetUsd: 5, limits: { depth: 3, explicit: { depth: true } } })
    const cleared = await json(['--project', codeDir, 'projects', 'set', '--max-budget', 'none', '--max-depth', 'auto'])
    expect(cleared.code).toBe(0)
    expect(cleared.doc.project).toMatchObject({ maxBudgetUsd: null, limits: { explicit: { depth: false } } })
    const show = await cli(['projects', 'show', codeDir])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Budget per run:  no cap')
    expect(show.out).toMatch(/Subagent depth:\s+Automatic \(\d\)/)
  })

  it('remove --yes', async () => {
    const r = await json(['projects', 'remove', engDir, '--yes'])
    expect(r.code).toBe(0)
    expect(r.doc).toMatchObject({ removed: true, result: { kind: 'engagement' } })
    const list = await json(['projects', 'list'])
    expect((list.doc.projects as { name: string }[]).map((p) => p.name)).toEqual(['Code int'])
    const none = await cli(['projects', 'remove', engDir, '--yes'])
    expect(none.code).toBe(2)
  })
})
