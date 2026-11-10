/**
 * Integration (cli-parity 3.4 as built, read-only): what waits for approval, against a real in-process mock host over its
 * real socket. `orgai team files status` lists a pending change with the gate's summary (text and JSON); `orgai projects
 * trust show` reads the folder config; the approve-shaped commands
 * decide nothing; no socket channel approves. No tokens, no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Project, TeamFilesStatus } from '../shared/types'
import { writeProductMarker } from '../main/store/productMarker'
import { main } from './index'
import { withSeedHost } from './testing/seedHost'
import type { CliIo } from './types'

let userDataDir: string
let repo: string
let project: Project
const env: NodeJS.ProcessEnv = { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0', PATH: process.env.PATH }

async function run(args: string[], format: 'text' | 'json' = 'text'): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: CliIo = {
    stdout: { write: (s: string) => ((out += s), true), isTTY: false, columns: 120 },
    stderr: { write: (s: string) => ((err += s), true), isTTY: false },
    stdinIsTTY: false
  }
  const code = await main(['--data-dir', userDataDir, '--no-color', '--output-format', format, ...args], { env: { ...env }, io, cwd: repo })
  return { code, out, err }
}

const reviewerFile = (): string => join(repo, '.orgai', 'agents', 'reviewer.md')
const addTool = (tool: string): void => writeFileSync(reviewerFile(), readFileSync(reviewerFile(), 'utf8').replace(/tools:\n/, `tools:\n  - "${tool}"\n`), 'utf8')
const codeOf = (e: unknown): string | undefined => (e as { data?: { code?: string } }).data?.code

beforeAll(async () => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-approvals-')))
  repo = join(userDataDir, 'repo')
  mkdirSync(repo)
  writeProductMarker(userDataDir, 'orgai-cli')
  await withSeedHost(
    userDataDir,
    async (c) => {
      project = await c.call<Project>('projects:create', [{ name: 'Approvals app', path: repo, brief: '', mock: true }])
      // The first status writes the project's team files.
      expect((await c.call<TeamFilesStatus>('teamFiles:status', [{ projectId: project.id }])).state).toBe('in-sync')
    },
    { scopes: ['read', 'configure'] }
  )
  // An agent edits a role file: the reviewer gains Bash. That needs approval.
  addTool('Bash')
}, 60_000)

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('what waits for approval, end to end (read-only)', () => {
  it('orgai team files status lists the pending change with the gate summary, and says where approving is done', async () => {
    const t = await run(['team', 'files', 'status'])
    expect(t.code, t.err).toBe(0)
    expect(t.out).toContain('Approvals app: 1 change waits for approval')
    expect(t.out).toMatch(/Reviewer.*Bash/)
    expect(t.out).toContain('Approving is not available in the terminal yet: a terminal cannot yet prove that a person, not an agent, is answering.')
    const j = await run(['team', 'files', 'status'], 'json')
    const list = JSON.parse(j.out).teamFiles as TeamFilesStatus[]
    expect(list.map((s) => s.projectId)).toEqual([project.id])
    expect(list[0].digest).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it('the approve-shaped commands decide nothing (exit 2, the files stay pending)', async () => {
    for (const args of [['team', 'files', 'approve', '--yes'], ['team', 'files', 'reject'], ['projects', 'trust', 'allow']]) {
      const r = await run(args)
      expect(r.code, args.join(' ')).toBe(2)
      expect(r.err).toContain('in the terminal')
    }
    const t = await run(['team', 'files', 'status'], 'json')
    expect((JSON.parse(t.out).teamFiles as TeamFilesStatus[])[0].state).toBe('pending')
  }, 60_000)

  it('projects trust show reads the folder config', async () => {
    const j = await run(['projects', 'trust', 'show'], 'json')
    expect(j.code, j.err).toBe(0)
    expect(JSON.parse(j.out).folderConfig.digest).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it('no socket channel approves: the desktop decisions stay desktop-only whatever scopes the owner holds', async () => {
    await withSeedHost(
      userDataDir,
      async (c) => {
        const s = (await c.call<TeamFilesStatus[]>('teamFiles:listAttention', [])).find((x) => x.projectId === project.id)!
        for (const [ch, arg] of [
          ['teamFiles:approve', { projectId: project.id, digest: s.digest }],
          ['teamFiles:reject', { projectId: project.id, digest: s.digest }],
          ['teamFiles:undo', { projectId: project.id }],
          ['teamFiles:commit', { projectId: project.id }],
          ['projects:setFolderConfigTrust', { projectId: project.id, trust: true, digest: s.digest }]
        ] as const) {
          const err = await c.call(ch, [arg]).catch((e: unknown) => e)
          expect(codeOf(err), ch).toBe('desktop_unavailable')
        }
        for (const ch of ['approvals:offer', 'approvals:answer']) expect(codeOf(await c.call(ch, [{}]).catch((e: unknown) => e)), ch).toBe('unknown_channel')
      },
      { scopes: ['read', 'operate', 'decide', 'configure'] }
    )
  }, 60_000)
})
