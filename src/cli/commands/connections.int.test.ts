/**
 * Integration: `orgai connections | models | usage | notes` against a real in-process mock host over its real socket
 * (cli-spec Wave 5, W5-T3). Only calls the mock host answers without spawning a provider CLI or touching the network:
 * connections list / show (cached statuses), models list / prices (the builtin catalog), usage show / csv
 * (persisted summaries), notes and the engagement plan (files in the data dir), and a set-default refusal.
 * Skipped here: connections test / connect / login (they spawn `claude auth status` or the Codex app-server) and
 * usage refresh (the Claude usage probe spawns the CLI). No tokens.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowFullTerminalAccess } from '../testing/terminalAccess'
import type { Project } from '../../shared/types'
import { connectHost } from '../client/hostClient'
import { main } from '../index'
import { startInprocHost, type InprocHost } from '../inprocHost'
import type { HostClient } from '../types'
import { CLI_VERSION } from '../version'

describe('connections, models, usage and notes against a real inproc host', () => {
  let userDataDir: string
  let dataDir: string
  let engDir: string
  let host: InprocHost
  let seed: HostClient
  let eng: Project

  async function cli(args: string[], cwd = engDir): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const io = { stdout: { write: (s: string) => ((out += s), true), isTTY: false, columns: 120 }, stderr: { write: (s: string) => ((err += s), true), isTTY: false }, stdinIsTTY: false }
    const code = await main(['--data-dir', userDataDir, '--host', 'daemon', '--no-color', ...args], { io, cwd, env: { PATH: process.env.PATH } })
    return { code, out, err }
  }

  beforeAll(async () => {
    userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-w5t3-')))
    dataDir = join(userDataDir, 'data')
    engDir = join(userDataDir, 'engagement')
    mkdirSync(engDir)
    // Clients of this host other than its starting context have no owner key: allow them decide / configure (review H2).
    writeProductMarker(userDataDir, 'orgai-cli')
    allowFullTerminalAccess(join(userDataDir, 'data'))
    host = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false, shared: true })
    const res = await connectHost({ dataDir, scopes: ['read', 'operate', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    if (!res.ok) throw new Error(res.message)
    seed = res.client
    eng = await seed.call<Project>('projects:create', [{ name: 'Acme review', path: engDir, brief: '', kind: 'engagement', mock: true }])
  }, 60_000)

  afterAll(async () => {
    seed?.close()
    await host?.stop(true).catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('connections list --output-format json carries every connection, no secret', async () => {
    const r = await cli(['connections', 'list', '--output-format', 'json'])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    const ids = j.connections.map((c: { id: string }) => c.id) as string[]
    // Built-ins first, then the proxies (a fresh profile has none; an old settings file migrates its LiteLLM as 'litellm').
    expect(ids.slice(0, 2)).toEqual(['anthropic', 'openai'])
    for (const id of ids.slice(2)) expect(id).toMatch(/^(litellm|proxy-[0-9a-f]{8})$/)
    expect(j.connections.filter((c: { isDefault: boolean }) => c.isDefault)).toHaveLength(1)
    for (const id of ids.slice(2)) {
      const show = await cli(['connections', 'show', id])
      expect(show.code).toBe(0)
      expect(show.out).toContain('API key: not set')
    }
    expect(JSON.stringify(j)).not.toMatch(/apiKey|sk-/)
  })

  it('set-default to a connection that is not connected exits 1 with the host sentence', async () => {
    const r = await cli(['connections', 'set-default', 'openai'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/OpenAI is (not connected|turned off)|Connect it first/)
  })

  it('models list and prices', async () => {
    const list = await cli(['models', 'list', '--output-format', 'json'])
    expect(list.code).toBe(0)
    const models = JSON.parse(list.out).models as { id: string; price: unknown }[]
    expect(models.length).toBeGreaterThan(0)
    const prices = await cli(['models', 'prices'])
    expect(prices.code).toBe(0)
    expect(prices.out).toContain('USD per million tokens.')
    expect(prices.out).not.toMatch(/\$0\.00 \/ \$0\.00/)
  })

  it('usage show and csv on an engagement with no runs', async () => {
    const show = await cli(['usage', 'show', '--range', 'month'])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Acme review: 0 runs this month')
    const out = join(userDataDir, 'usage.csv')
    const csv = await cli(['usage', 'csv', '--out', out])
    expect(csv.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toMatch(/^\ufeff?project,client,/)
    expect((await cli(['usage', 'csv', '--out', out])).code).toBe(1)
  })

  it('notes add / list / show / edit (stale and fresh) / remove', async () => {
    const add = await cli(['notes', 'add', '--title', 'Kickoff call', '--text', 'We met the sponsor.', '--output-format', 'json'])
    expect(add.code).toBe(0)
    const id = JSON.parse(add.out).note.id as string
    const rev = JSON.parse(add.out).note.updatedAt as number
    const list = await cli(['notes', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).toContain('Kickoff call')
    const show = await cli(['notes', 'show', 'kickoff call'])
    expect(show.out).toContain('We met the sponsor.')
    // Someone else saves in between: the CLI edit based on the old revision is refused.
    await new Promise((r) => setTimeout(r, 5))
    await seed.call('projects:saveNote', [{ projectId: eng.id, noteId: id, title: 'Kickoff call', text: 'Edited in the app.' }])
    const stale = await cli(['notes', 'edit', id, '--text', 'Mine', '--expected-updated-at', String(rev)])
    expect(stale.code).toBe(1)
    expect(stale.err).toContain('The note changed since you read it')
    const fresh = await cli(['notes', 'edit', id, '--title', 'Kickoff'])
    expect(fresh.code).toBe(0)
    expect((await cli(['notes', 'show', id])).out).toContain('Edited in the app.')
    expect((await cli(['notes', 'remove', id, '--yes'])).code).toBe(0)
    expect((await cli(['notes', 'list'])).out).toContain('No context notes')
  })

  it('notes plan set / show and a stale plan save', async () => {
    const set = await cli(['notes', 'plan', 'set', '--text', '# Plan\nScope: billing.', '--output-format', 'json'])
    expect(set.code).toBe(0)
    const rev = JSON.parse(set.out).plan.updatedAt as number
    const show = await cli(['notes', 'plan'])
    expect(show.code).toBe(0)
    expect(show.out).toContain('Scope: billing.')
    await new Promise((r) => setTimeout(r, 5))
    await seed.call('projects:updateEngagementDocument', [{ projectId: eng.id, text: 'Theirs', expectedUpdatedAt: rev }])
    const stale = await cli(['notes', 'plan', 'set', '--text', 'Mine', '--expected-updated-at', String(rev)])
    expect(stale.code).toBe(1)
    expect((await cli(['notes', 'plan'])).out).toContain('Theirs')
  })
})
