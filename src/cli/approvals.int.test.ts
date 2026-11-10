/**
 * Integration: approvals at the terminal (cli-parity 3.4) against a real in-process mock host over its real socket: the
 * real hello, registry gate, dispatcher, approval gate and team files service. Only the terminal attestation is
 * injected (the code-only startInprocHost option), except in the test that uses the real one. No tokens, no network.
 *
 *   - `orgai team files status` lists a pending change (text and JSON);
 *   - approve from an exec-like ('cli') connection, a non-interactive one (the real attestation under the test runner)
 *     and an unverified terminal (the attestation refuses) is refused, and nothing changes;
 *   - approve with a stale hash is refused;
 *   - the verified path (a 'tui' connection on an attested terminal, the offer's code typed back) applies exactly the
 *     change shown.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ApprovalOffer, HostClientKind, HostScope, Project, TeamFilesStatus } from '../shared/types'
import { decideTerminalAttestation, gatherTerminalFacts, type AttestTerminalFn } from '../main/host/terminalAttestation'
import { writeProductMarker } from '../main/store/productMarker'
import { connectHost } from './client/hostClient'
import { main } from './index'
import { startInprocHost } from './inprocHost'
import type { CliIo, HostClient } from './types'
import { CLI_VERSION } from './version'

let userDataDir: string
let repo: string
let project: Project
const env: NodeJS.ProcessEnv = { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0', PATH: process.env.PATH }
const SCOPES: HostScope[] = ['read', 'operate', 'decide', 'configure', 'attested_approve']

const ATTESTED: AttestTerminalFn = async () => ({ ok: true, tty: 'ttys042' })
const IN_AGENT: AttestTerminalFn = async () => ({ ok: false, code: 'agent_ancestor', reason: 'This orgai was started from inside an agent (claude, pid 7); approvals are never taken there.' })

/** A real host on the folder with this attestation (undefined = the real one), and owner clients of the given kind. */
async function withHost<T>(attest: AttestTerminalFn | undefined, fn: (connect: (kind: HostClientKind, scopes?: HostScope[]) => Promise<HostClient>) => Promise<T>): Promise<T> {
  const host = await startInprocHost({
    userDataDir,
    dataDir: `${userDataDir}/data`,
    env: { ...env },
    mock: true,
    overlay: new Map(),
    logging: false,
    startBackground: false,
    systemCertificates: false,
    ...(attest ? { attestTerminal: attest } : {})
  })
  const opened: HostClient[] = []
  const connect = async (clientKind: HostClientKind, scopes: HostScope[] = SCOPES): Promise<HostClient> => {
    const res = await connectHost({ dataDir: `${userDataDir}/data`, scopes, clientKind, clientVersion: CLI_VERSION, cwd: repo, pid: process.pid, ownerKey: host.ownerKey!, ownerHostInstanceId: host.hostInstanceId! })
    if (!res.ok) throw new Error(res.message)
    opened.push(res.client)
    return res.client
  }
  try {
    return await fn(connect)
  } finally {
    for (const c of opened) c.close()
    await host.stop(true).catch(() => undefined)
  }
}

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

async function reviewerTools(c: HostClient): Promise<string[]> {
  const p = await c.call<Project>('projects:get', [project.id])
  return p.roles.find((r) => r.slug === 'reviewer')?.tools ?? []
}

async function pending(c: HostClient): Promise<TeamFilesStatus | undefined> {
  return (await c.call<TeamFilesStatus[]>('teamFiles:listAttention', [])).find((s) => s.projectId === project.id)
}

const codeOf = (e: unknown): string | undefined => (e as { data?: { code?: string } }).data?.code

beforeAll(async () => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-approvals-')))
  repo = join(userDataDir, 'repo')
  mkdirSync(repo)
  writeProductMarker(userDataDir, 'orgai-cli')
  await withHost(ATTESTED, async (connect) => {
    const c = await connect('cli', ['read', 'configure'])
    project = await c.call<Project>('projects:create', [{ name: 'Approvals app', path: repo, brief: '', mock: true }])
    // The first status writes the project's team files.
    const s = await c.call<TeamFilesStatus>('teamFiles:status', [{ projectId: project.id }])
    expect(s.state).toBe('in-sync')
  })
  // An agent edits a role file: the reviewer gains Bash. That needs approval.
  addTool('Bash')
}, 60_000)

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('approvals at the terminal, end to end', () => {
  it('orgai team files status lists the pending change with the gate summary', async () => {
    const t = await run(['team', 'files', 'status'])
    expect(t.code, t.err).toBe(0)
    expect(t.out).toContain('Approvals app: 1 change waits for approval')
    expect(t.out).toMatch(/Reviewer.*Bash/)
    expect(t.out).toContain('/approvals')
    const j = await run(['team', 'files', 'status'], 'json')
    const list = JSON.parse(j.out).teamFiles as TeamFilesStatus[]
    expect(list.map((s) => s.projectId)).toEqual([project.id])
    expect(list[0].digest).toMatch(/^[0-9a-f]{64}$/)
    // The approve-shaped command decides nothing.
    const a = await run(['team', 'files', 'approve', '--yes'])
    expect(a.code).toBe(2)
    expect(a.err).toContain('/approvals')
  }, 60_000)

  it("an exec-like connection ('cli', as exec, resume --exec and every management command connect) is never granted the scope; the offer is refused", async () => {
    await withHost(ATTESTED, async (connect) => {
      const c = await connect('cli')
      expect(c.hello.grantedScopes).not.toContain('attested_approve')
      expect(c.hello.grantedScopes).toContain('configure')
      const s = await pending(c)
      const err = await c.call('approvals:offer', [{ kind: 'teamFiles', projectId: project.id, digest: s!.digest }]).catch((e: unknown) => e)
      expect(codeOf(err)).toBe('scope_denied')
      // The desktop's own channels stay closed over the socket whatever the scopes.
      const desk = await c.call('teamFiles:approve', [{ projectId: project.id, digest: s!.digest }]).catch((e: unknown) => e)
      expect(codeOf(desk)).toBe('desktop_unavailable')
      expect(await reviewerTools(c)).not.toContain('Bash')
    })
  }, 60_000)

  it('the real attestation decides every offer from this process; under a test runner without a terminal it refuses', async () => {
    const verdict = decideTerminalAttestation(await gatherTerminalFacts({ coResident: true }), { coResident: true })
    await withHost(undefined, async (connect) => {
      const c = await connect('tui')
      expect(c.hello.grantedScopes).toContain('attested_approve')
      const res = await c.call<ApprovalOffer>('approvals:offer', [{ kind: 'teamFiles', projectId: project.id }]).catch((e: unknown) => e)
      if (verdict.ok) return
      // Environmental: this is the very mechanism under test (stdin not a terminal, an agent ancestor, no terminal app).
      expect(codeOf(res)).toBe('scope_denied')
      expect(await reviewerTools(c)).not.toContain('Bash')
    })
  }, 60_000)

  it('an unverified terminal (the attestation refuses: an agent ancestor) gets no offer, with the host reason', async () => {
    await withHost(IN_AGENT, async (connect) => {
      const c = await connect('tui')
      const err = await c.call('approvals:offer', [{ kind: 'teamFiles', projectId: project.id }]).catch((e: unknown) => e)
      expect(codeOf(err)).toBe('scope_denied')
      expect((err as { data?: { message?: string } }).data?.message).toContain('inside an agent')
    })
    // The terminal is checked at the offer and again after the key press.
    let ok = true
    await withHost(async () => (ok ? { ok: true, tty: 'ttys042' } : { ok: false, code: 'process_shares_terminal', reason: 'A process OrgAI started shares this terminal (claude, pid 9).' }), async (connect) => {
      const c = await connect('tui')
      expect(c.hello.grantedScopes).toContain('attested_approve')
      const offer = await c.call<ApprovalOffer>('approvals:offer', [{ kind: 'teamFiles', projectId: project.id }])
      ok = false
      const err = await c.call('approvals:answer', [{ offerId: offer.offerId, action: 'approve', code: offer.code }]).catch((e: unknown) => e)
      expect(codeOf(err)).toBe('scope_denied')
      expect(await reviewerTools(c)).not.toContain('Bash')
    })
  }, 60_000)

  it('a stale hash is refused at the offer and at the answer; nothing is applied', async () => {
    await withHost(ATTESTED, async (connect) => {
      const c = await connect('tui')
      const shown = (await pending(c))!.digest!
      const offer = await c.call<ApprovalOffer>('approvals:offer', [{ kind: 'teamFiles', projectId: project.id, digest: shown }])
      // The files change after the person looked (more power).
      addTool('Write')
      const err = await c.call('approvals:answer', [{ offerId: offer.offerId, action: 'approve', code: offer.code }]).catch((e: unknown) => e)
      expect(codeOf(err)).toBe('stale_target_digest')
      const again = await c.call('approvals:offer', [{ kind: 'teamFiles', projectId: project.id, digest: shown }]).catch((e: unknown) => e)
      expect(codeOf(again)).toBe('stale_target_digest')
      const tools = await reviewerTools(c)
      expect(tools).not.toContain('Bash')
      expect(tools).not.toContain('Write')
    })
  }, 60_000)

  it('the verified path: a tui connection on an attested terminal, the code typed back, applies exactly the change shown', async () => {
    await withHost(ATTESTED, async (connect) => {
      const c = await connect('tui')
      expect(c.hello.grantedScopes).toEqual(SCOPES)
      const offer = await c.call<ApprovalOffer>('approvals:offer', [{ kind: 'teamFiles', projectId: project.id }])
      expect(offer.actions).toContain('approve')
      expect(offer.teamFiles?.changes.filter((ch) => ch.needsApproval).map((ch) => ch.name)).toContain('Reviewer')
      // A wrong code changes nothing (the offer allows a few tries); the right one, typed in lower case, applies.
      const wrong = await c.call('approvals:answer', [{ offerId: offer.offerId, action: 'approve', code: offer.code === 'AAAA' ? 'CCCC' : 'AAAA' }]).catch((e: unknown) => e)
      expect(codeOf(wrong)).toBe('bad_request')
      expect(await reviewerTools(c)).not.toContain('Bash')
      const done = await c.call<{ message: string; teamFiles: TeamFilesStatus }>('approvals:answer', [{ offerId: offer.offerId, action: 'approve', code: offer.code.toLowerCase() }])
      // Single use: the same offer cannot be answered again.
      const replay = await c.call('approvals:answer', [{ offerId: offer.offerId, action: 'approve', code: offer.code }]).catch((e: unknown) => e)
      expect(codeOf(replay)).toBe('stale_revision')
      expect(done.teamFiles.state).toBe('in-sync')
      const tools = await reviewerTools(c)
      expect(tools).toContain('Bash')
      expect(tools).toContain('Write')
    })
    const t = await run(['team', 'files', 'status'])
    expect(t.out).toContain('No team-file changes wait for approval.')
  }, 60_000)
})
