/**
 * Integration: `orgai mcp` against a real in-process mock host over its real socket (cli-spec 6.3, Wave 5). The host
 * gets a writable test cipher (a `--host inproc` host normally refuses to save secrets; the desktop and headless hosts
 * save them in safeStorage), so set-secret and the mock OAuth sign-in can be checked end to end. No tokens, no network.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allowFullTerminalAccess } from '../testing/terminalAccess'
import type { Project } from '../../shared/types'
import type { CliIo } from '../types'

vi.mock('../../main/host/bootstrap', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/host/bootstrap')>()
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4)
  }
  return { ...real, bootOrgAIHost: (opts: Parameters<typeof real.bootOrgAIHost>[0]) => real.bootOrgAIHost({ ...opts, safeStorage: cipher, secrets: { overlay: opts.secrets?.overlay } }) }
})

const { startInprocHost } = await import('../inprocHost')
const { connectHost } = await import('../client/hostClient')
const { main } = await import('../index')
const { CLI_VERSION } = await import('../version')
const { MOCK_AUTHORIZE_URL } = await import('../../main/mcp/service')

describe('orgai mcp against a real inproc host', () => {
  let userDataDir: string
  let dataDir: string
  let projectDir: string
  let host: Awaited<ReturnType<typeof startInprocHost>>
  let project: Project
  const saved = process.env.ORGAI_MOCK

  async function cli(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const io: CliIo = { stdout: { write: (s: string) => ((out += s), true), isTTY: false }, stderr: { write: (s: string) => ((err += s), true), isTTY: false }, stdinIsTTY: false }
    if (opts.stdin !== undefined) {
      const { manageDeps } = await import('../manage')
      const real = manageDeps.readStdin
      manageDeps.readStdin = async () => opts.stdin!
      try {
        const code = await main(['--data-dir', userDataDir, '--no-color', '--project', projectDir, ...args], { io, env: { ...process.env, ORGAI_MOCK: '1', ...opts.env }, cwd: projectDir })
        return { code, out, err }
      } finally {
        manageDeps.readStdin = real
      }
    }
    const code = await main(['--data-dir', userDataDir, '--no-color', '--project', projectDir, ...args], { io, env: { ...process.env, ORGAI_MOCK: '1', ...opts.env }, cwd: projectDir })
    return { code, out, err }
  }

  beforeAll(async () => {
    process.env.ORGAI_MOCK = '1'
    userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-mcp-int-')))
    dataDir = join(userDataDir, 'data')
    projectDir = join(userDataDir, 'project')
    mkdirSync(projectDir)
    // Clients of this host other than its starting context have no owner key: allow them decide / configure (review H2).
    allowFullTerminalAccess(join(userDataDir, 'data'))
    host = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay: new Map(), logging: false, startBackground: false })
    const res = await connectHost({ dataDir, scopes: ['read', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    if (!res.ok) throw new Error(res.message)
    project = await res.client.call<Project>('projects:create', [{ name: 'Mcp int', path: projectDir, brief: '', mock: true }])
    res.client.close()
  }, 60_000)

  afterAll(async () => {
    await host?.stop(true).catch(() => {})
    if (saved === undefined) delete process.env.ORGAI_MOCK
    else process.env.ORGAI_MOCK = saved
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('add a stdio server, list it, set its secret from stdin, disable, enable, remove', async () => {
    const add = await cli(['mcp', 'add', 'notes', '--command', 'node', '--arg', 'server.js', '--secret-var', 'NOTES_TOKEN', '--env', 'LOG=1'])
    expect(add.code, add.err).toBe(0)
    expect(add.out).toContain('Added notes to Mcp int.')

    const list = await cli(['mcp', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/notes\s+stdio\s+on\s+-\s+NOTES_TOKEN/)

    const secret = await cli(['mcp', 'set-secret', 'notes', 'NOTES_TOKEN', '--stdin', '--output-format', 'json'], { stdin: 'int-secret-value\n' })
    expect(secret.code, secret.err).toBe(0)
    expect(secret.out + secret.err).not.toContain('int-secret-value')
    const after = JSON.parse((await cli(['mcp', 'list', '--output-format', 'json'])).out) as { servers: { name: string; missingSecrets: string[]; envSet: string[]; enabled: boolean }[] }
    expect(after.servers[0]).toMatchObject({ name: 'notes', missingSecrets: [], envSet: ['NOTES_TOKEN'] })
    expect(JSON.stringify(after)).not.toContain('int-secret-value')

    expect((await cli(['mcp', 'disable', 'notes'])).code).toBe(0)
    expect(JSON.parse((await cli(['mcp', 'show', 'notes', '--output-format', 'json'])).out).server.enabled).toBe(false)
    expect((await cli(['mcp', 'enable', 'notes'])).code).toBe(0)
    expect(JSON.parse((await cli(['mcp', 'show', 'notes', '--output-format', 'json'])).out).server.enabled).toBe(true)

    const refused = await cli(['mcp', 'remove', 'notes'])
    expect(refused.code).toBe(2)
    expect((await cli(['mcp', 'remove', 'notes', '--yes'])).code).toBe(0)
    expect((await cli(['mcp', 'list'])).out).toContain('No MCP servers in Mcp int.')
  })

  it("the host's validation refusal reaches the user", async () => {
    const r = await cli(['mcp', 'add', 'Bad Name', '--command', 'node'])
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/orgai: /)
  })

  it('library add and list', async () => {
    const add = await cli(['mcp', 'library', 'add', 'shared-docs', '--url', 'https://docs.example.com/mcp', '--secret-header', 'Authorization'])
    expect(add.code, add.err).toBe(0)
    const list = await cli(['mcp', 'library', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/shared-docs\s+mcpl_\S+\s+http/)
  })

  it('connectors list, and add of a no-sign-in preset is connected at once', async () => {
    const list = await cli(['mcp', 'connectors', 'list', '--filter', 'deepwiki'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/deepwiki\s+DeepWiki\s+No sign-in needed\s+available/)
    const add = await cli(['mcp', 'connectors', 'add', 'deepwiki'])
    expect(add.code, add.err).toBe(0)
    expect(add.out).toContain('It is connected.')
    const json = JSON.parse((await cli(['mcp', 'connectors', 'list', '--filter', 'deepwiki', '--output-format', 'json'])).out) as { connectors: { id: string; state: string; ease: string }[] }
    expect(json.connectors[0]).toMatchObject({ id: 'deepwiki', state: 'connected', ease: 'none' })
  })

  it('mcp auth on a mock OAuth connector prints the announced URL and succeeds with --no-browser', async () => {
    expect((await cli(['mcp', 'connectors', 'add', 'linear'])).code).toBe(0)
    const r = await cli(['mcp', 'auth', '--library', 'linear', '--no-browser'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('Open this URL in a browser to sign in:')
    expect(r.out).toContain(MOCK_AUTHORIZE_URL)
    expect(r.out).toMatch(/linear: authorized \(mock@example\.com\)\./)
    const ssh = await cli(['mcp', 'auth', '--library', 'linear', '--output-format', 'json'], { env: { SSH_CONNECTION: '10.1.1.1 50000 10.1.1.2 22', USER: 'dev' } })
    expect(ssh.code, ssh.err).toBe(0)
    expect(ssh.err).toContain('Forward the callback first: ssh -L 38917:127.0.0.1:38917 dev@10.1.1.2')
    expect(JSON.parse(ssh.out)).toMatchObject({ ok: true, authorizeUrl: MOCK_AUTHORIZE_URL, openedBrowser: false, status: { state: 'authorized' } })
    const revoke = await cli(['mcp', 'revoke', '--library', 'linear', '--yes'])
    expect(revoke.code).toBe(0)
    expect(revoke.out).toContain('Signed linear out')
  })
})
