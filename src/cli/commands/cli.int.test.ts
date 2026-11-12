/**
 * Integration: the read-only commands against a real in-process host over its real socket (cli-spec Wave 2).
 *
 * Needs the whole wave: the CLI entry and the in-process host (W2-T4: src/cli/index.ts main routing,
 * src/cli/inprocHost.ts), the socket server (W2-T1) and the sanitizer (W2-T6). Until they are merged the suite
 * skips itself. It drives everything through `main(argv)` with process.stdout / stderr captured, so it relies only on
 * the contracts (CommandFn names, flags, the wire protocol), not on T4's internals. Mock adapter only; no tokens.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project, RunRecord, RunSummary } from '../../shared/types'
import { withSeedHost } from '../testing/seedHost'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string): string => {
  try {
    return readFileSync(join(here, rel), 'utf8')
  } catch {
    return ''
  }
}
const wave2Merged =
  existsSync(join(here, '..', 'inprocHost.ts')) &&
  !read('../index.ts').includes('the CLI is not available yet in this build') &&
  !read('../../main/host/socketServer.ts').includes('Skeleton: nothing is served')

type Main = (argv: string[]) => Promise<number>

describe.skipIf(!wave2Merged)('orgai read-only commands read the saved files; a second orgai is refused (real in-process hosts)', () => {
  let userDataDir: string
  let projectDir: string
  let main: Main
  let project: Project
  let run: RunSummary
  const saved = { mock: process.env.ORGAI_MOCK, data: process.env.ORGAI_CLI_DATA_DIR }
  let out = ''
  let err = ''

  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const o0 = out.length
    const e0 = err.length
    const code = await main(['--data-dir', userDataDir, '--no-color', ...args])
    return { code, out: out.slice(o0), err: err.slice(e0) }
  }

  async function until<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = await fn()
      if (v) return v
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  beforeAll(async () => {
    const base = realpathSync(tmpdir())
    userDataDir = mkdtempSync(join(base, 'orgai-cli-int-'))
    projectDir = join(userDataDir, 'project')
    mkdirSync(projectDir)
    process.env.ORGAI_MOCK = '1'
    process.env.ORGAI_CLI_DATA_DIR = userDataDir
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => ((out += String(s)), true)) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => ((err += String(s)), true)) as typeof process.stderr.write)
    main = ((await import('../index')) as unknown as { main: Main }).main
    writeProductMarker(userDataDir, 'orgai-cli')
    // One host makes a project and a mock run, ends it and stops: what is left is files.
    await withSeedHost(userDataDir, async (seed) => {
      project = await seed.call<Project>('projects:create', [{ name: 'Int project', path: projectDir, brief: '', mock: true }])
      run = await seed.call<RunSummary>('runs:start', [{ projectId: project.id, prompt: 'Hello from the integration test', team: 'single' }])
      await until('the mock run to go idle', async () => (await seed.call<RunRecord | null>('runs:get', [run.id]))?.summary.status === 'idle')
      await seed.call('runs:stop', [run.id])
      await until('the run to stop', async () => (await seed.call<RunRecord | null>('runs:get', [run.id]))?.summary.status === 'finished')
    })
  }, 60_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    process.env.ORGAI_MOCK = saved.mock
    process.env.ORGAI_CLI_DATA_DIR = saved.data
    if (saved.mock === undefined) delete process.env.ORGAI_MOCK
    if (saved.data === undefined) delete process.env.ORGAI_CLI_DATA_DIR
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('status, runs list and runs show read the files with no host: no daemon.json, no note', async () => {
    const s = await cli(['--project', projectDir, 'status', '--output-format', 'json'])
    expect(s.code).toBe(0)
    const j = JSON.parse(s.out)
    expect(j).toMatchObject({ schemaVersion: 1, hostState: 'stopped', liveInboxAvailable: false })
    expect(j.project.id).toBe(project.id)
    const list = await cli(['--project', projectDir, 'runs', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/R1\s+Stopped/)
    expect(list.err).toBe('')
    const show = await cli(['--project', projectDir, 'runs', 'show', 'R1'])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Hello from the integration test')
    const projects = await cli(['projects', 'list'])
    expect(projects.code).toBe(0)
    expect(projects.out).toContain('Int project')
    expect(existsSync(join(userDataDir, 'data', 'run', 'daemon.json'))).toBe(false)
  })

  it('beside a running orgai: read-only commands answer from the files with a snapshot note; a command that needs a host is refused at once (exit 6)', async () => {
    await withSeedHost(userDataDir, async () => {
      const list = await cli(['--project', projectDir, 'runs', 'list'])
      expect(list.code).toBe(0)
      expect(list.out).toMatch(/R1\s+/)
      expect(list.err).toContain('orgai is running in another terminal; this is a saved snapshot.')
      const status = await cli(['--project', projectDir, 'status'])
      expect(status.code).toBe(0)
      expect(status.out).toContain('Another orgai running: yes')
      const doctor = await cli(['doctor'])
      expect(doctor.out).toMatch(/Another orgai is running \(pid \d+/)
      const began = Date.now()
      const refused = await cli(['--project', projectDir, 'connections', 'list'])
      expect(refused.code).toBe(6)
      expect(refused.err).toMatch(/orgai is already running in another terminal \(.*, pid \d+\)\. Use that one, or quit it first\./)
      expect(Date.now() - began).toBeLessThan(5000)
      const exec = await cli(['--project', projectDir, 'exec', 'hello'])
      expect(exec.code).toBe(6)
    })
    // The owner quit: the next command takes the folder again.
    expect((await cli(['connections', 'list'])).code).toBe(0)
  })
})
