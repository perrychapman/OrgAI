/**
 * Integration: `orgai connections tier` and `orgai settings` against a real in-process mock host (one per command)
 * over its real socket. The mock host lists Anthropic's builtin catalog; nothing is discovered, spawned or spent.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withSeedHost } from '../testing/seedHost'
import type { Project } from '../../shared/types'
import { main } from '../index'

describe('connections tier and settings against a real inproc host', () => {
  let userDataDir: string
  let appDir: string

  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = ''
    let err = ''
    const io = { stdout: { write: (s: string) => ((out += s), true), isTTY: false, columns: 160 }, stderr: { write: (s: string) => ((err += s), true), isTTY: false }, stdinIsTTY: false }
    const code = await main(['--data-dir', userDataDir, '--no-color', ...args], { io, cwd: appDir, env: { PATH: process.env.PATH, ORGAI_MOCK: '1' } })
    return { code, out, err }
  }

  beforeAll(async () => {
    userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-tierset-')))
    appDir = join(userDataDir, 'app')
    mkdirSync(appDir)
    writeProductMarker(userDataDir, 'orgai-cli')
    await withSeedHost(userDataDir, (seed) => seed.call<Project>('projects:create', [{ name: 'App', path: appDir, brief: '', mock: true }]))
  }, 60_000)

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('tier shows four rows, refuses an unknown id, saves a catalog id and resets it', async () => {
    const show = await cli(['connections', 'tier', 'anthropic', '--output-format', 'json'])
    expect(show.code).toBe(0)
    const rows = JSON.parse(show.out).tiers as { tier: string; model: string | null; inCatalog: boolean }[]
    expect(rows.map((r) => r.tier)).toEqual(['top', 'deep', 'everyday', 'fast'])
    const catalog = JSON.parse((await cli(['models', 'list', '--connection', 'anthropic', '--output-format', 'json'])).out).models as { id: string }[]
    const pick = catalog.map((m) => m.id).find((id) => id !== rows.find((r) => r.tier === 'fast')?.model)!
    expect(pick).toBeTruthy()

    const bad = await cli(['connections', 'tier', 'anthropic', 'fast=not-a-model-xyz'])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("is not in Anthropic's catalog")

    const dry = await cli(['connections', 'tier', 'anthropic', `fast=${pick}`, '--dry-run', '--output-format', 'json'])
    expect(dry.code).toBe(0)
    expect(JSON.parse(dry.out)).toMatchObject({ applied: false, dryRun: true })
    expect(JSON.parse((await cli(['connections', 'tier', 'anthropic', '--output-format', 'json'])).out).tiers[3].model).toBe(rows[3].model)

    const set = await cli(['connections', 'tier', 'anthropic', `fast=${pick}`, '--output-format', 'json'])
    expect(set.code).toBe(0)
    expect(JSON.parse(set.out)).toMatchObject({ applied: true, changes: [{ tier: 'fast', to: pick }] })
    expect(JSON.parse((await cli(['connections', 'tier', 'anthropic', '--output-format', 'json'])).out).tiers[3].model).toBe(pick)

    const reset = await cli(['connections', 'tier', 'anthropic', '--reset', 'fast'])
    expect(reset.code).toBe(0)
    expect(JSON.parse((await cli(['connections', 'tier', 'anthropic', '--output-format', 'json'])).out).tiers[3].model).toBe(rows[3].model)
  }, 60_000)

  it('settings set / get round-trips through the host and never touches other fields', async () => {
    const before = JSON.parse((await cli(['settings', 'list', '--output-format', 'json'])).out).settings as { key: string; value: unknown }[]
    expect(before.length).toBeGreaterThan(10)
    expect((await cli(['settings', 'set', 'defaultKeepRuns', '33'])).code).toBe(0)
    expect((await cli(['settings', 'get', 'defaultKeepRuns'])).out.trim()).toBe('33')
    expect((await cli(['settings', 'set', 'defaultMaxBudgetUsd', '4.5'])).code).toBe(0)
    expect((await cli(['settings', 'set', 'defaultMaxBudgetUsd', 'none'])).code).toBe(0)
    expect((await cli(['settings', 'get', 'defaultMaxBudgetUsd'])).out.trim()).toBe('none')
    expect((await cli(['settings', 'set', 'setupModel', 'everyday'])).code).toBe(0)
    expect((await cli(['settings', 'set', 'setupModel', 'no-such-model-xyz'])).code).toBe(2)
    expect((await cli(['settings', 'set', 'appearance', 'dark'])).code).toBe(2)
    const after = JSON.parse((await cli(['settings', 'list', '--output-format', 'json'])).out).settings as { key: string; value: unknown }[]
    const changed = after.filter((a) => JSON.stringify(a.value) !== JSON.stringify(before.find((b) => b.key === a.key)?.value)).map((a) => a.key)
    expect(changed.sort()).toEqual(['defaultKeepRuns', 'setupModel'])
  }, 60_000)
})
