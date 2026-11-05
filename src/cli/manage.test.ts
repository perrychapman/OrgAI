import { afterEach, describe, expect, it } from 'vitest'
import type { HostRpcErrorCode, HostScope } from '../shared/types'
import { TERMINAL_ACCESS_HINT } from './client/ensureHost'
import {
  confirm,
  hostCall,
  hostError,
  isRemoteSession,
  manageDeps,
  readSecretValue,
  requireEngagement,
  requireProject,
  runSubcommands,
  sshForwardCommand,
  subscribeTopics,
  withHost
} from './manage'
import { resetSkewWarning } from './runRef'
import { fakeContext, fakeInproc, FakeHostClient, noHost, project, rpcError } from './testing/fakeContext'
import { CliError, EXIT, type CliContext } from './types'

const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  resetSkewWarning()
})

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

describe('hostError', () => {
  const table: [HostRpcErrorCode, number][] = [
    ['bad_request', EXIT.usage],
    ['unknown_channel', EXIT.usage],
    ['scope_denied', 1],
    ['stale_target_digest', 1],
    ['stale_revision', 1],
    ['host_draining', EXIT.hostBusy],
    ['host_starting', EXIT.hostBusy],
    ['terminal_server_disabled', 1],
    ['auth_failed', EXIT.auth],
    ['frame_too_large', 1]
  ]
  it.each(table)('%s -> exit %i', (code, exit) => {
    const e = hostError(rpcError({ code, message: `host says ${code}` }))
    expect(e.exitCode).toBe(exit)
    if (code === 'terminal_server_disabled') expect(e.message).toBe(TERMINAL_ACCESS_HINT)
    else expect(e.message).toContain(`host says ${code}`)
    if (code === 'scope_denied') expect(e.message).toContain('another version')
  })

  it('passes a CliError through and maps a plain error to 1', () => {
    const c = new CliError('mine', 4)
    expect(hostError(c)).toBe(c)
    expect(hostError(new Error('socket closed'))).toMatchObject({ exitCode: 1, message: 'socket closed' })
  })

  it('hostCall rejects with the mapped CliError', async () => {
    const client = new FakeHostClient({ 'kit:applyBundle': () => Promise.reject(rpcError({ code: 'stale_target_digest', message: 'The library changed.' })) })
    const e = await caught(hostCall(client, 'kit:applyBundle', [{}]))
    expect(e).toMatchObject({ exitCode: 1, message: 'The library changed.' })
  })
})

describe('withHost', () => {
  it('stops an inproc host it started and closes the client, also when fn throws', async () => {
    const client = new FakeHostClient({}, { hello: ALL })
    const inproc = fakeInproc()
    const f = fakeContext({ globals: { host: 'inproc' }, connect: [client], inproc: async () => inproc })
    expect(await withHost(f.ctx, ['read', 'configure'], async () => 7)).toBe(7)
    expect(client.closed).toBe(true)
    expect(inproc.stops).toEqual([true])

    const client2 = new FakeHostClient({}, { hello: ALL })
    const inproc2 = fakeInproc()
    const g = fakeContext({ globals: { host: 'inproc' }, connect: [client2], inproc: async () => inproc2 })
    const e = await caught(
      withHost(g.ctx, ['read'], async () => {
        throw new CliError('nope', 3)
      })
    )
    expect(e.exitCode).toBe(3)
    expect(client2.closed).toBe(true)
    expect(inproc2.stops).toEqual([true])
  })

  it('refuses a missing granted scope with exit 1 and cleans up', async () => {
    const client = new FakeHostClient({}, { hello: { grantedScopes: ['read', 'operate', 'decide'] } })
    const f = fakeContext({ connect: [client] })
    let ran = false
    const e = await caught(withHost(f.ctx, ['read', 'configure'], async () => (ran = true)))
    expect(e.exitCode).toBe(1)
    expect(e.message).toBe('The OrgAI host did not grant the access this needs (configure). A host of another version accepts only read, operate and decide from this CLI.')
    expect(ran).toBe(false)
    expect(client.closed).toBe(true)
  })

  it('notes a headless host it started', async () => {
    const client = new FakeHostClient({}, { hello: ALL })
    const f = fakeContext({ connect: [noHost(), client], launcher: { waitForReady: async () => client.daemon } })
    await withHost(f.ctx, ['read'], async () => undefined)
    expect(f.err()).toContain('Started the OrgAI host in the background.')
  })
})

describe('requireProject / requireEngagement', () => {
  const p1 = project('p1', '/work/app')
  const client = (): FakeHostClient => new FakeHostClient({ 'projects:list': () => [p1] })

  it('no project is exit 2', async () => {
    const f = fakeContext({ cwd: '/elsewhere' })
    const e = await caught(requireProject(f.ctx, client()))
    expect(e.exitCode).toBe(EXIT.usage)
    expect(e.message).toContain('pass --project <id-or-path>')
  })

  it('a --project that matches nothing is exit 2', async () => {
    const f = fakeContext({ globals: { project: 'nope' } })
    expect((await caught(requireProject(f.ctx, client()))).exitCode).toBe(EXIT.usage)
  })

  it('a managed agent worktree resolves to its parent project', async () => {
    const f = fakeContext({
      cwd: '/work/app/.claude/worktrees/agent-1',
      resolveProject: (projects) => ({ project: projects[0], via: 'cwd', managedWorktree: { mainCheckout: '/work/app' } })
    })
    expect((await requireProject(f.ctx, client())).id).toBe('p1')
  })

  it('requireEngagement', () => {
    expect(() => requireEngagement(project('e', '/e', { kind: 'engagement' } as never), 'context notes')).not.toThrow()
    try {
      requireEngagement(p1, 'context notes')
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toMatchObject({ exitCode: EXIT.usage, message: 'This is a code project; context notes belongs to engagements.' })
    }
  })
})

describe('confirm', () => {
  const tty = (stdin: boolean, stdout: boolean): CliContext => {
    const f = fakeContext({ stdinIsTTY: stdin })
    f.ctx.io.stdout.isTTY = stdout
    return f.ctx
  }

  it('--yes needs no terminal', async () => {
    manageDeps.ttyConfirm = async () => {
      throw new Error('must not ask')
    }
    expect(await confirm(tty(false, false), 'Remove it?', true)).toBe(true)
  })

  it('no terminal on stdin is exit 2', async () => {
    for (const ctx of [tty(false, false), tty(false, true)]) {
      const e = await caught(confirm(ctx, 'Remove it?', false))
      expect(e).toMatchObject({ exitCode: EXIT.usage, message: 'Remove it? Pass --yes to confirm without a terminal.' })
    }
  })

  it('a piped stdout still asks on /dev/tty (cli-spec 6.3(4))', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), true)
    expect(await confirm(tty(true, false), 'Import it?', false)).toBe(true)
    expect(asked).toEqual(['Import it?'])
  })

  it('asks on the terminal', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), false)
    expect(await confirm(tty(true, true), 'Remove it?', false)).toBe(false)
    manageDeps.ttyConfirm = async () => true
    expect(await confirm(tty(true, true), 'Remove it?', false)).toBe(true)
    expect(asked).toEqual(['Remove it?'])
  })
})

describe('readSecretValue', () => {
  it('reads a set environment variable', async () => {
    const f = fakeContext({ env: { MY_TOKEN: 'tok-1' } })
    expect(await readSecretValue(f.ctx, { fromEnv: 'MY_TOKEN', what: 'the token' })).toBe('tok-1')
  })

  it('a missing or empty variable is exit 2 naming the variable, never a value', async () => {
    for (const env of [{}, { MY_TOKEN: '' }]) {
      const f = fakeContext({ env: { ...env, OTHER: 'secret-value' } })
      const e = await caught(readSecretValue(f.ctx, { fromEnv: 'MY_TOKEN', what: 'the token' }))
      expect(e.exitCode).toBe(EXIT.usage)
      expect(e.message).toContain('MY_TOKEN')
      expect(e.message).not.toContain('secret-value')
    }
  })

  it('stdin: one trailing newline trimmed, at most 64 KB', async () => {
    const limits: number[] = []
    const f = fakeContext()
    for (const [raw, want] of [
      ['abc\n', 'abc'],
      ['abc\r\n', 'abc'],
      ['abc\n\n', 'abc\n'],
      ['  abc', '  abc']
    ]) {
      manageDeps.readStdin = async (max) => (limits.push(max), raw)
      expect(await readSecretValue(f.ctx, { stdin: true, what: 'the token' })).toBe(want)
    }
    expect(limits.every((l) => l === 64 * 1024)).toBe(true)
    manageDeps.readStdin = async () => '\n'
    expect((await caught(readSecretValue(f.ctx, { stdin: true, what: 'the token' }))).exitCode).toBe(EXIT.usage)
  })

  it('both sources, no source or a terminal stdin is exit 2', async () => {
    const f = fakeContext({ env: { T: 'x' } })
    expect((await caught(readSecretValue(f.ctx, { fromEnv: 'T', stdin: true, what: 'the token' }))).exitCode).toBe(EXIT.usage)
    expect((await caught(readSecretValue(f.ctx, { what: 'the token' }))).exitCode).toBe(EXIT.usage)
    expect((await caught(readSecretValue(f.ctx, { fromEnv: 'not a name', what: 'the token' }))).exitCode).toBe(EXIT.usage)
    const t = fakeContext({ stdinIsTTY: true })
    expect((await caught(readSecretValue(t.ctx, { stdin: true, what: 'the token' }))).exitCode).toBe(EXIT.usage)
  })
})

describe('runSubcommands', () => {
  const routes = { list: async (_ctx: CliContext, args: string[]) => args.length }
  it('routes, and a missing or unknown subcommand is exit 2 with the usage', async () => {
    const f = fakeContext()
    expect(await runSubcommands(f.ctx, ['list', 'a', 'b'], routes, 'x <list>')).toBe(2)
    for (const args of [[], ['nope'], ['--json'], ['toString']]) {
      const e = await caught(runSubcommands(f.ctx, args, routes, 'x <list>'))
      expect(e.exitCode).toBe(EXIT.usage)
      expect(e.message).toContain('Usage: orgai x <list>')
    }
  })
})

describe('subscribeTopics', () => {
  it('subscribes, filters by the topics’ channels and unsubscribes', async () => {
    const client = new FakeHostClient({ 'host.subscribe': (p) => (p as [{ topics: string[] }])[0] })
    const seen: [string, unknown][] = []
    const off = await subscribeTopics(client, ['connections'], (c, p) => seen.push([c, p]))
    expect(client.callsOf('host.subscribe')).toEqual([[{ topics: ['connections'] }]])
    client.push('connections:event', { type: 'connection.status' })
    client.push('settings:changed', { x: 1 })
    client.push('runs:event', {})
    expect(seen).toEqual([['connections:event', { type: 'connection.status' }]])
    off()
    client.push('connections:event', { type: 'again' })
    expect(seen).toHaveLength(1)
  })

  it('a refused subscribe removes the listener', async () => {
    const client = new FakeHostClient({ 'host.subscribe': () => Promise.reject(rpcError({ code: 'scope_denied', message: 'no' })) })
    const seen: string[] = []
    await caught(subscribeTopics(client, ['connections'], (c) => seen.push(c)))
    client.push('connections:event', {})
    expect(seen).toEqual([])
  })
})

describe('SSH helpers', () => {
  it('isRemoteSession', () => {
    expect(isRemoteSession({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe(true)
    expect(isRemoteSession({ SSH_TTY: '/dev/pts/1' }, 'win32')).toBe(true)
    expect(isRemoteSession({}, 'linux')).toBe(true)
    expect(isRemoteSession({ DISPLAY: ':0' }, 'linux')).toBe(false)
    expect(isRemoteSession({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false)
    expect(isRemoteSession({}, 'darwin')).toBe(false)
  })

  it('sshForwardCommand', () => {
    const uri = 'http://127.0.0.1:38917/callback'
    expect(sshForwardCommand(uri, { SSH_CONNECTION: '10.0.0.5 51234 10.0.0.9 22', USER: 'ana' })).toBe('ssh -L 38917:127.0.0.1:38917 ana@10.0.0.9')
    expect(sshForwardCommand(uri, { SSH_CONNECTION: '10.0.0.5 51234 10.0.0.9 2222' })).toBe('ssh -L 38917:127.0.0.1:38917 -p 2222 10.0.0.9')
    expect(sshForwardCommand('http://localhost:5555/cb', {})).toBe('ssh -L 5555:127.0.0.1:5555 <this-host>')
    expect(sshForwardCommand('https://example.com:443/cb', {})).toBeNull()
    expect(sshForwardCommand('http://127.0.0.1/cb', {})).toBeNull()
    expect(sshForwardCommand('not a url', {})).toBeNull()
  })
})
