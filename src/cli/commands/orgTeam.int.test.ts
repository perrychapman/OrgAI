/**
 * Integration: `orgai org`, `team`, `worktrees` and `permissions` against a real in-process mock host over its socket
 * (cli-spec 6.3, Wave 5). The host runs in this process (startInprocHost); every command goes through `main(argv)` with
 * `--host daemon`, so it connects as a real CLI client would. Mock adapter only; no tokens, no network.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowFullTerminalAccess } from '../testing/terminalAccess'
import type { Project } from '../../shared/types'
import { connectHost } from '../client/hostClient'
import { main } from '../index'
import { startInprocHost, type InprocHost } from '../inprocHost'
import type { CliIo } from '../types'
import { CLI_VERSION } from '../version'

let userDataDir: string
let dataDir: string
let projectDir: string
let host: InprocHost
let project: Project
const env: NodeJS.ProcessEnv = { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0', PATH: process.env.PATH }

beforeAll(async () => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgteam-')))
  dataDir = join(userDataDir, 'data')
  projectDir = join(userDataDir, 'repo')
  mkdirSync(projectDir)
  // Clients of this host other than its starting context have no owner key: allow them decide / configure (review H2).
  allowFullTerminalAccess(join(userDataDir, 'data'))
  host = await startInprocHost({ userDataDir, dataDir, env: { ...env }, mock: true, overlay: new Map(), logging: false, startBackground: false })
  const res = await connectHost({ dataDir, scopes: ['read', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
  if (!res.ok) throw new Error(res.message)
  project = await res.client.call<Project>('projects:create', [{ name: 'Int app', path: projectDir, brief: '', mock: true }])
  res.client.close()
}, 60_000)

afterAll(async () => {
  await host?.stop(true).catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

async function run(args: string[], format: 'text' | 'json' = 'text'): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const io: CliIo = {
    stdout: { write: (s: string) => ((out += s), true), isTTY: false, columns: 120 },
    stderr: { write: (s: string) => ((err += s), true), isTTY: false },
    stdinIsTTY: false
  }
  const code = await main(['--data-dir', userDataDir, '--host', 'daemon', '--no-color', '--output-format', format, ...args], { env: { ...env }, io, cwd: projectDir })
  return { code, out, err }
}

describe('org / team / worktrees / permissions against an inproc host', () => {
  it('org show lists the default chart as a tree', async () => {
    const r = await run(['org', 'show'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain(`Int app: ${project.roles.length} role`)
    expect(r.out).toContain('Subagent limits:')
    const j = JSON.parse((await run(['org', 'show'], 'json')).out)
    expect(j.roles).toHaveLength(project.roles.length)
    expect(j.roles[0].depth).toBe(0)
  })

  it('permissions add, list and remove a rule', async () => {
    let r = await run(['permissions', 'add', 'Bash(npm test:*)'])
    expect(r.code, r.err).toBe(0)
    r = await run(['permissions', 'list'], 'json')
    expect(JSON.parse(r.out).rules.map((x: { rule: string }) => x.rule)).toContain('Bash(npm test:*)')
    r = await run(['permissions', 'remove', 'Bash(npm test:*)'])
    expect(r.code, r.err).toBe(0)
    r = await run(['permissions', 'list'], 'json')
    expect(JSON.parse(r.out).rules).toEqual([])
  })

  it('permissions add refuses a too-broad rule with the host sentence', async () => {
    const r = await run(['permissions', 'add', 'Bash(curl:*)'])
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/orgai: .+/)
  })

  it('permissions mode default', async () => {
    let r = await run(['permissions', 'mode', 'acceptEdits'])
    expect(r.code, r.err).toBe(0)
    r = await run(['permissions', 'mode', 'default'])
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse((await run(['permissions', 'mode'], 'json')).out).mode).toBe('default')
  })

  it('team templates save then list', async () => {
    let r = await run(['team', 'templates', 'save', '--name', 'Int team'])
    expect(r.code, r.err).toBe(0)
    r = await run(['team', 'templates', 'list'], 'json')
    expect(JSON.parse(r.out).templates.map((t: { name: string }) => t.name)).toContain('Int team')
  })

  it('worktrees list is empty', async () => {
    const r = await run(['worktrees', 'list'], 'json')
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out).worktrees).toEqual([])
  })

  it('org recommend under mock (keyword fallback, no tokens)', async () => {
    const r = await run(['org', 'recommend'], 'json')
    expect(r.code, r.err).toBe(0)
    const j = JSON.parse(r.out)
    expect(j.recommendations.projectId).toBe(project.id)
    expect(Array.isArray(j.recommendations.recommendations)).toBe(true)
  }, 60_000)
})
