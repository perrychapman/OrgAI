/**
 * Integration: `orgai mcp` against a real in-process mock host (one per command) (cli-spec 6.3, Wave 5). The host
 * gets a fake key custodian and an open vault (Wave 7: an orgai host stores secrets in vault.json once a
 * custodian works), so set-secret and the mock OAuth sign-in can be checked end to end. No tokens, no network.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types'
import type { CliIo } from '../types'

// The host's store comes from openSecretStore (Wave 7, cli-standalone.md 5.6): give it a fake key custodian and create
// the vault up front (the dispatcher's storesSecret predicates, which await prepareWrite per call, land separately).
vi.mock('../../main/store/secrets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/store/secrets')>()
  const { fakeCustody } = await import('../../main/store/vaultTesting')
  const custody = fakeCustody()
  return {
    ...real,
    openSecretStore: async (opts: Parameters<typeof real.openSecretStore>[0]) => {
      const store = await real.openSecretStore({ ...opts, custodian: custody.factory })
      await store.prepareWrite()
      return store
    }
  }
})

const { withSeedHost } = await import('../testing/seedHost')
const { main } = await import('../index')
const { MOCK_AUTHORIZE_URL } = await import('../../main/mcp/service')

describe('orgai mcp against a real inproc host', () => {
  let userDataDir: string
  let projectDir: string
  let project: Project
  const saved = { mock: process.env.ORGAI_MOCK, claudePath: process.env.ORGAI_CLAUDE_PATH }

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
    // These MCP cases do not exercise provider authentication. Keep the management host's connection probe from
    // starting an installed Claude CLI with data/auth-cwd as its working directory while this fixture is torn down.
    process.env.ORGAI_CLAUDE_PATH = join(userDataDir, 'missing-claude-runtime')
    projectDir = join(userDataDir, 'project')
    mkdirSync(projectDir)
    writeProductMarker(userDataDir, 'orgai-cli')
    // Each cli() call starts its own host on this folder (sharing the fake custodian above); a seed host makes the project.
    project = await withSeedHost(userDataDir, (client) => client.call<Project>('projects:create', [{ name: 'Mcp int', path: projectDir, brief: '', mock: true }]), { scopes: ['read', 'configure'] })
  }, 60_000)

  afterAll(async () => {
    const authCwdCreated = existsSync(join(userDataDir, 'data', 'auth-cwd'))
    if (saved.mock === undefined) delete process.env.ORGAI_MOCK
    else process.env.ORGAI_MOCK = saved.mock
    if (saved.claudePath === undefined) delete process.env.ORGAI_CLAUDE_PATH
    else process.env.ORGAI_CLAUDE_PATH = saved.claudePath
    rmSync(userDataDir, { recursive: true, force: true })
    expect(authCwdCreated).toBe(false)
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
