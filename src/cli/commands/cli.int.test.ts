/**
 * Integration: the read-only commands against a real in-process host over its real socket (cli-spec Wave 2).
 *
 * Needs the whole wave: the CLI entry and `--host inproc` host (W2-T4: src/cli/index.ts main routing,
 * src/cli/inprocHost.ts), the socket server (W2-T1) and the sanitizer (W2-T6). Until they are merged the suite
 * skips itself. It drives everything through `main(argv)` with process.stdout / stderr captured, so it relies only on
 * the contracts (CommandFn names, flags, the wire protocol), not on T4's internals. Mock adapter only; no tokens.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { allowFullTerminalAccess } from '../testing/terminalAccess'
import { clientProof, encodeFrame, isNotification, isResponse, LineReader, newNonce, readDaemonSecret, rpcRequest, errorDataOf, type JsonRpcResponse } from '../../main/host/protocol'
import type { DaemonInfo, Project, RunRecord, RunSummary } from '../../shared/types'
import { CLI_VERSION } from '../version'

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

/** A minimal authenticated socket client (scopes beyond 'read' to seed data; the CLI under test asks for 'read'). */
class SeedClient {
  private socket!: Socket
  private reader = new LineReader()
  private nextId = 2
  private waiting = new Map<number | string, (r: JsonRpcResponse) => void>()

  static async open(dataDir: string, info: DaemonInfo): Promise<SeedClient> {
    const c = new SeedClient()
    await c.handshake(dataDir, info)
    return c
  }

  private handshake(dataDir: string, info: DaemonInfo): Promise<void> {
    const secret = readDaemonSecret(dataDir)
    if (!secret) throw new Error('daemon.secret unreadable')
    this.reader.maxLineBytes = 100 * 1024 * 1024
    return new Promise((resolve, reject) => {
      this.socket = netConnect(info.endpoint)
      this.socket.on('error', reject)
      let challenged = false
      this.socket.on('data', (chunk: Buffer) => {
        for (const line of this.reader.push(chunk).lines) {
          const msg = JSON.parse(line) as unknown
          if (!challenged && isNotification(msg) && msg.method === 'host.challenge') {
            challenged = true
            const p = msg.params as { hostInstanceId: string; hostNonce: string }
            const fields = {
              protocolVersion: 1 as const,
              clientKind: 'cli' as const,
              clientVersion: CLI_VERSION,
              pid: process.pid,
              cwd: process.cwd(),
              clientNonce: newNonce(),
              requestedScopes: ['read', 'operate', 'decide', 'configure'] as ('read' | 'operate' | 'decide' | 'configure')[]
            }
            const proof = clientProof(secret, { ...fields, hostInstanceId: p.hostInstanceId, hostNonce: p.hostNonce })
            this.waiting.set(1, (r) => ('error' in r ? reject(new Error(errorDataOf(r).message)) : resolve()))
            this.socket.write(encodeFrame(rpcRequest(1, 'host.hello', { ...fields, clientProof: proof })))
            continue
          }
          if (isResponse(msg) && msg.id !== null) {
            const w = this.waiting.get(msg.id)
            this.waiting.delete(msg.id)
            w?.(msg)
          }
        }
      })
    })
  }

  call<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (r) => ('error' in r ? reject(new Error(errorDataOf(r).message)) : resolve(r.result as T)))
      this.socket.write(encodeFrame(rpcRequest(id, method, params)))
    })
  }

  close(): void {
    this.socket?.destroy()
  }
}

describe.skipIf(!wave2Merged)('orgai read-only commands against a real inproc host', () => {
  let userDataDir: string
  let projectDir: string
  let main: Main
  let hostDone: Promise<number>
  let seed: SeedClient
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

  const daemonInfo = (): DaemonInfo | null => {
    try {
      return JSON.parse(readFileSync(join(userDataDir, 'data', 'run', 'daemon.json'), 'utf8')) as DaemonInfo
    } catch {
      return null
    }
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
    // Clients of this host other than its starting context have no owner key: allow them decide / configure (review H2).
    writeProductMarker(userDataDir, 'orgai-cli')
    allowFullTerminalAccess(join(userDataDir, 'data'))
    hostDone = main(['--data-dir', userDataDir, '--host', 'inproc', 'daemon', 'start'])
    const info = await until('daemon.json ready', () => {
      const d = daemonInfo()
      return d?.state === 'ready' ? d : null
    })
    seed = await SeedClient.open(join(userDataDir, 'data'), info)
    project = await seed.call<Project>('projects:create', [{ name: 'Int project', path: projectDir, brief: '', mock: true }])
    run = await seed.call<RunSummary>('runs:start', [{ projectId: project.id, prompt: 'Hello from the integration test', team: 'single' }])
    await until('the mock run to go idle', async () => (await seed.call<RunRecord | null>('runs:get', [run.id]))?.summary.status === 'idle')
  }, 60_000)

  afterAll(async () => {
    seed?.close()
    vi.restoreAllMocks()
    process.env.ORGAI_MOCK = saved.mock
    process.env.ORGAI_CLI_DATA_DIR = saved.data
    if (saved.mock === undefined) delete process.env.ORGAI_MOCK
    if (saved.data === undefined) delete process.env.ORGAI_CLI_DATA_DIR
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('status --output-format json names the inproc host', async () => {
    const r = await cli(['--project', projectDir, 'status', '--output-format', 'json'])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    expect(j).toMatchObject({ schemaVersion: 1, hostState: 'ready', liveInboxAvailable: true })
    expect(j.host).toMatchObject({ hostKind: 'inproc', state: 'ready', mock: true })
    expect(j.project.id).toBe(project.id)
  })

  it('runs list, runs show R1 and inbox', async () => {
    const list = await cli(['--project', projectDir, 'runs', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/R1\s+(Idle|Running)/)
    const show = await cli(['--project', projectDir, 'runs', 'show', 'R1'])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Hello from the integration test')
    const inbox = await cli(['--project', projectDir, 'inbox'])
    expect(inbox.code).toBe(0)
  })

  it('watch exits 0 when the session ends', async () => {
    const watching = cli(['--project', projectDir, 'watch', 'R1', '--output-format', 'stream-json'])
    await until('the watch snapshot', () => out.includes('"type":"snapshot"'))
    await seed.call('runs:stop', [run.id])
    const r = await watching
    expect(r.code).toBe(0)
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l) as { type: string; event?: { type: string; status?: string } })
    expect(lines.some((l) => l.event?.type === 'run.status' && l.event.status === 'finished')).toBe(true)
  })

  it('daemon stop, then a hostless runs list shows the run ended', async () => {
    seed.close()
    const stop = await cli(['daemon', 'stop', '--force'])
    expect(stop.code).toBe(0)
    expect(await hostDone).toBe(0)
    expect(daemonInfo()).toBeNull()
    const list = await cli(['--project', projectDir, 'runs', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toMatch(/R1\s+Stopped/)
    expect(list.err).toContain('No OrgAI host is running; showing saved data.')
  })
})
