/**
 * The read-only commands beside another orgai (cli-standalone-default.md 4.3): each one answers from the saved files
 * with the snapshot line, and none of them connects, starts a host or writes anything (no socket hello, no store
 * construction, no migration). Run through the command functions with a context whose connect and startInproc fail.
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeProductMarker } from '../main/store/productMarker'
import { SNAPSHOT_NOTE } from './ownedMessage'
import { runCompletions } from './commands/completions'
import { runDoctor } from './commands/doctor'
import { runProjects } from './commands/projects'
import { runRuns } from './commands/runs'
import { runSecrets } from './commands/secrets'
import { runStatus } from './commands/status'
import { runUsage } from './commands/usage'
import { fakeContext, project, record, summary } from './testing/fakeContext'
import { CliError, EXIT } from './types'

const p1 = project('p1', '/work/app', { name: 'App' })
const runs = [summary('run_one111', { startedAt: 1000, title: 'First', projectId: 'p1' })]
const records = { run_one111: record(runs[0]) }

/** Every file under a folder with its size and mtime: a write, a new file or a migration changes it. */
function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name)
      const st = statSync(path)
      out.push(`${path}:${st.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`}`)
      if (st.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

describe('read-only commands beside a live owner', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'orgai-matrix-'))
  const dataDir = join(userDataDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeProductMarker(dataDir, 'orgai-cli')
  writeFileSync(join(dataDir, 'projects.json'), '{}')

  const cases: [string, (c: ReturnType<typeof fakeContext>['ctx']) => Promise<number>, boolean][] = [
    ['status', (c) => runStatus(c, []), true],
    ['runs list', (c) => runRuns(c, ['list']), true],
    ['runs show', (c) => runRuns(c, ['show', 'R1']), true],
    ['projects list', (c) => runProjects(c, ['list']), true],
    ['projects show', (c) => runProjects(c, ['show']), true],
    ['usage show', (c) => runUsage(c, ['show']), true],
    ['secrets status', (c) => runSecrets(c, ['status']), true],
    ['doctor', (c) => runDoctor(c, []), false],
    ['completions', (c) => runCompletions(c, ['bash']), false]
  ]

  for (const [name, call, notes] of cases) {
    it(`${name}: no connect, no host, no write${notes ? ', and the snapshot line' : ''}`, async () => {
      const f = fakeContext({
        cwd: '/work/app',
        paths: { userDataDir, dataDir },
        store: { projects: [p1], runs, records, hostState: 'ready', daemon: { pid: 4242, ownerCwd: '/work/other', state: 'ready', startedAt: 1, appVersion: '9.9' } as never }
      })
      const before = listing(userDataDir)
      const code = await call(f.ctx)
      expect(code).toBe(EXIT.ok)
      expect(f.connectCalls).toEqual([])
      expect(f.inprocCalls).toEqual([])
      expect(listing(userDataDir)).toEqual(before)
      if (notes) expect(f.err()).toContain(SNAPSHOT_NOTE)
    })
  }

  it('usage show counts the saved runs of the project', async () => {
    const f = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, paths: { userDataDir, dataDir }, store: { projects: [p1], runs, hostState: 'ready' } })
    await runUsage(f.ctx, ['show'])
    expect(JSON.parse(f.out())).toMatchObject({ project: { id: 'p1' }, runs: 1 })
  })

  it('secrets status reads vault.json metadata only', async () => {
    const f = fakeContext({ globals: { outputFormat: 'json' }, paths: { userDataDir, dataDir }, store: { hostState: 'ready' } })
    await runSecrets(f.ctx, ['status'])
    const j = JSON.parse(f.out())
    expect(j.snapshot).toBe(true)
    expect(j.checks.map((c: { id: string }) => c.id)).toContain('vault')
  })

  describe('another orgai takes the folder between the owner check and the host start', () => {
    /** First readStore says stopped, later ones ready; starting a host fails like a lost race (exit 6). */
    const racing = (args: Parameters<typeof fakeContext>[0] = {}) => {
      const f = fakeContext({
        cwd: '/work/app',
        globals: { outputFormat: 'json' },
        paths: { userDataDir, dataDir },
        store: { projects: [p1], runs, records, hostState: 'ready' },
        inproc: () => {
          throw new CliError('orgai is already running. Use that one, or quit it first.', EXIT.hostBusy)
        },
        ...args
      })
      const read = f.ctx.readStore
      let n = 0
      f.ctx.readStore = async () => ({ ...(await read()), hostState: n++ === 0 ? 'stopped' : 'ready' })
      return f
    }

    it('usage show falls back to the saved files instead of exit 6', async () => {
      const f = racing()
      expect(await runUsage(f.ctx, ['show'])).toBe(EXIT.ok)
      expect(JSON.parse(f.out())).toMatchObject({ project: { id: 'p1' }, runs: 1 })
    })

    it('secrets status falls back to the saved files with a stable JSON shape', async () => {
      const f = racing()
      expect(await runSecrets(f.ctx, ['status'])).toBe(EXIT.ok)
      const j = JSON.parse(f.out())
      expect(j).toMatchObject({ secrets: null, snapshot: true })
      expect(j.checks.find((c: { id: string }) => c.id === 'vault').detail).not.toContain('no host is running')
    })
  })
})
