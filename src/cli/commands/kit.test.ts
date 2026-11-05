import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostScope, KitApplyResult, KitImportPreview, KitPreviewItem } from '../../shared/types'
import { manageDeps } from '../manage'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, rpcError, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT, type CliContext } from '../types'
import { itemOverrides, kitChoices, kitFs, kitTarget, runKit, STALE_TARGET_CLI_MESSAGE } from './kit'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realManage = { ...manageDeps }
const realFs = { ...kitFs }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-kit-'))
})
afterEach(() => {
  Object.assign(manageDeps, realManage)
  Object.assign(kitFs, realFs)
  resetSkewWarning()
  rmSync(dir, { recursive: true, force: true })
})

const item = (key: string, status: KitPreviewItem['status'], extra: Partial<KitPreviewItem> = {}): KitPreviewItem => ({
  key,
  kind: 'skill',
  name: `name-${key}`,
  status,
  action: status === 'new' ? 'add' : 'skip',
  canReplace: true,
  size: 10,
  notes: [],
  ...extra
})

const preview = (items: KitPreviewItem[]): KitImportPreview => ({ path: '', fileName: 'k.orgai-kit.json', digest: 'D', bytes: 5, items, notes: [], targetDigest: 'T' })
const result = (extra: Partial<KitApplyResult> = {}): KitApplyResult => ({ added: 1, replaced: 0, copied: 0, skipped: 0, counts: { skills: 1, mcpServers: 0, connectorPresets: 0, templates: 0 }, failed: [], needsSecrets: [], notes: [], ...extra })

function setup(answers: Record<string, (p: unknown) => unknown> = {}, opts: FakeContextOptions = {}) {
  const client = new FakeHostClient(answers, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: dir, ...opts })
  return { client, ...f }
}

async function run(ctx: CliContext, args: string[]): Promise<{ code: number; message?: string }> {
  try {
    return { code: await runKit(ctx, args) }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, message: e.message }
    throw e
  }
}

describe('kit export', () => {
  const exported = { fileName: 'x.orgai-kit.json', rawBytesBase64: Buffer.from('{"format":"orgai.kit/1"}').toString('base64'), counts: { skills: 2, mcpServers: 0, connectorPresets: 0, templates: 0 }, bytes: 24, notes: ['Left out connector GitHub: connectors are not exported.'] }

  it('writes through a temp file + rename/link in the same folder, adding the suffix', async () => {
    const seen: string[] = []
    const realWrite = kitFs.writeFile
    kitFs.writeFile = (async (p: string, ...rest: unknown[]) => {
      seen.push(p)
      return (realWrite as (...a: unknown[]) => Promise<void>)(p, ...rest)
    }) as typeof kitFs.writeFile
    const f = setup({ 'kit:exportBundle': () => exported })
    expect((await run(f.ctx, ['export', 'mykit', '--skills', 'a,b', '--all-templates'])).code).toBe(0)
    expect(f.client.callsOf('kit:exportBundle')).toEqual([[{ include: { skills: ['a', 'b'], templates: 'all' }, fileName: 'mykit.orgai-kit.json' }]])
    const target = join(dir, 'mykit.orgai-kit.json')
    expect(readFileSync(target, 'utf8')).toBe('{"format":"orgai.kit/1"}')
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(target)
    expect(seen[0].startsWith(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual(['mykit.orgai-kit.json'])
    expect(f.out()).toContain('connectors are not exported')
  })

  it('refuses an existing file without --force (no host call); --force replaces it', async () => {
    writeFileSync(join(dir, 'k.orgai-kit.json'), 'old')
    const f = setup({ 'kit:exportBundle': () => exported })
    const r = await run(f.ctx, ['export', 'k.orgai-kit.json', '--all'])
    expect(r.code).toBe(1)
    expect(r.message).toContain('--force')
    expect(f.client.callsOf('kit:exportBundle')).toEqual([])
    const g = setup({ 'kit:exportBundle': () => exported })
    expect((await run(g.ctx, ['export', 'k.orgai-kit.json', '--all', '--force'])).code).toBe(0)
    expect(readFileSync(join(dir, 'k.orgai-kit.json'), 'utf8')).toContain('orgai.kit/1')
    expect(readdirSync(dir)).toEqual(['k.orgai-kit.json'])
  })

  it('a file that appears during the export is not clobbered', async () => {
    const f = setup({
      'kit:exportBundle': () => {
        writeFileSync(join(dir, 'race.orgai-kit.json'), 'theirs')
        return exported
      }
    })
    expect((await run(f.ctx, ['export', 'race', '--all'])).code).toBe(1)
    expect(readFileSync(join(dir, 'race.orgai-kit.json'), 'utf8')).toBe('theirs')
    expect(readdirSync(dir)).toEqual(['race.orgai-kit.json'])
  })

  it('needs a selection', async () => {
    expect((await run(setup().ctx, ['export', 'k'])).code).toBe(EXIT.usage)
    expect((await run(setup().ctx, ['export', 'k', '--skills', 'a', '--all-skills'])).code).toBe(EXIT.usage)
  })

  it('kitTarget', () => {
    expect(kitTarget('a', '/x')).toBe('/x/a.orgai-kit.json')
    expect(kitTarget('/y/b.orgai-kit.json', '/x')).toBe('/y/b.orgai-kit.json')
  })
})

describe('kit import', () => {
  const file = (): string => {
    const p = join(dir, 'in.orgai-kit.json')
    writeFileSync(p, '{"format":"orgai.kit/1"}')
    return p
  }

  it('default actions: new -> add, same / refused -> skip; a different item needs an explicit action', () => {
    const p = preview([item('skill:0', 'new'), item('skill:1', 'same'), item('skill:2', 'refused')])
    expect(kitChoices(p, undefined, new Map()).map((c) => c.action)).toEqual(['add', 'skip', 'skip'])
    const d = preview([item('skill:0', 'new'), item('skill:1', 'different')])
    expect(() => kitChoices(d, undefined, new Map())).toThrow(/need a choice/)
    expect(() => kitChoices(d, 'add', new Map())).toThrow(/need a choice/)
    expect(kitChoices(d, 'replace', new Map()).map((c) => c.action)).toEqual(['add', 'replace'])
    expect(kitChoices(d, 'skip', new Map()).map((c) => c.action)).toEqual(['skip', 'skip'])
    expect(kitChoices(d, undefined, itemOverrides(d, ['name-skill:1=copy'])).map((c) => c.action)).toEqual(['add', 'copy'])
    expect(() => itemOverrides(d, ['nope=add'])).toThrow(CliError)
    expect(() => itemOverrides(d, ['skill:1=explode'])).toThrow(CliError)
  })

  it('displays every item with commands, secrets, scripts and roles (sanitized); --yes skips only the prompt', async () => {
    const p = preview([
      item('server:0', 'new', { kind: 'server', name: 'gh\u001b[31m', command: 'npx -y @x/server@1.0.0 --flag', secretSlots: ['GH_TOKEN'] }),
      item('skill:0', 'new', { scripts: ['scripts/run.sh'], files: ['scripts/run.sh'] }),
      item('template:0', 'same', { kind: 'template', roles: [{ name: 'Lead', slug: 'lead', prompt: 'Lead the team', elevatedTools: ['Bash', 'canSpawn'] }] })
    ])
    const f = setup({ 'kit:previewBundle': () => p, 'kit:applyBundle': () => result({ needsSecrets: [{ name: 'gh', env: ['GH_TOKEN'], headers: [], perProject: false }] }) })
    expect((await run(f.ctx, ['import', file(), '--yes'])).code).toBe(0)
    const out = f.out()
    expect(out).toContain('npx -y @x/server@1.0.0 --flag')
    expect(out).toContain('GH_TOKEN')
    expect(out).toContain('scripts/run.sh')
    expect(out).toContain('can use Bash, canSpawn')
    expect(out).toContain('orgai mcp library set-secret gh')
    expect(out).not.toContain('\u001b')
    expect(f.client.callsOf('kit:previewBundle')).toEqual([[{ fileName: 'in.orgai-kit.json', rawBytesBase64: Buffer.from('{"format":"orgai.kit/1"}').toString('base64') }]])
    expect(f.client.callsOf('kit:applyBundle')).toEqual([
      [
        {
          rawBytesBase64: Buffer.from('{"format":"orgai.kit/1"}').toString('base64'),
          digest: 'D',
          targetDigest: 'T',
          choices: [
            { key: 'server:0', action: 'add' },
            { key: 'skill:0', action: 'add' },
            { key: 'template:0', action: 'skip' }
          ]
        }
      ]
    ])
  })

  it('without --yes and no terminal it is exit 2 before apply; on a terminal it asks', async () => {
    const p = preview([item('skill:0', 'new')])
    const f = setup({ 'kit:previewBundle': () => p, 'kit:applyBundle': () => result() })
    expect((await run(f.ctx, ['import', file()])).code).toBe(EXIT.usage)
    expect(f.client.callsOf('kit:applyBundle')).toEqual([])
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), false)
    const g = setup({ 'kit:previewBundle': () => p, 'kit:applyBundle': () => result() }, { stdinIsTTY: true })
    g.ctx.io.stdout.isTTY = true
    expect((await run(g.ctx, ['import', file()])).code).toBe(1)
    expect(asked).toHaveLength(1)
    expect(g.client.callsOf('kit:applyBundle')).toEqual([])
  })

  it('stale_target_digest is exit 1 with the message', async () => {
    const f = setup({ 'kit:previewBundle': () => preview([item('skill:0', 'different')]), 'kit:applyBundle': () => Promise.reject(rpcError({ code: 'stale_target_digest', message: 'Something in your library changed' })) })
    const r = await run(f.ctx, ['import', file(), '--action', 'replace', '--yes'])
    expect(r.code).toBe(1)
    expect(r.message).toBe(STALE_TARGET_CLI_MESSAGE)
  })

  it('failed items or a chosen refused item are exit 1 with a structured summary', async () => {
    const f = setup(
      { 'kit:previewBundle': () => preview([item('skill:0', 'new'), item('skill:1', 'refused', { refusal: 'shell injection' })]), 'kit:applyBundle': () => result({ failed: [{ key: 'skill:1', name: 'name-skill:1', reason: 'shell injection' }] }) },
      { globals: { outputFormat: 'json' } }
    )
    expect((await run(f.ctx, ['import', file(), '--item', 'skill:1=add', '--yes'])).code).toBe(1)
    const j = JSON.parse(f.out())
    expect(j.ok).toBe(false)
    expect(j.result.failed[0].key).toBe('skill:1')
    expect(j.refusedChosen[0]).toMatchObject({ key: 'skill:1', reason: 'shell injection' })

    const g = setup({ 'kit:previewBundle': () => preview([item('skill:0', 'new')]), 'kit:applyBundle': () => result({ failed: [{ key: 'skill:0', name: 'x', reason: 'boom' }] }) })
    expect((await run(g.ctx, ['import', file(), '--yes'])).code).toBe(1)
    expect(g.out()).toContain('Failed: x')
  })

  it('a refused item skipped by default still makes the import exit 1 (cli-spec 6.3(4))', async () => {
    const f = setup(
      { 'kit:previewBundle': () => preview([item('skill:0', 'new'), item('server:0', 'refused', { refusal: 'credential-looking argument' })]), 'kit:applyBundle': () => result() },
      { globals: { outputFormat: 'json' } }
    )
    expect((await run(f.ctx, ['import', file(), '--yes'])).code).toBe(1)
    expect((f.client.callsOf('kit:applyBundle')[0] as unknown[])[0]).toMatchObject({ choices: [{ key: 'skill:0', action: 'add' }, { key: 'server:0', action: 'skip' }] })
    const j = JSON.parse(f.out())
    expect(j.ok).toBe(false)
    expect(j.refused).toEqual([{ key: 'server:0', name: 'name-server:0', reason: 'credential-looking argument' }])
    expect(j.refusedChosen).toEqual([])

    const g = setup({ 'kit:previewBundle': () => preview([item('skill:0', 'same'), item('server:0', 'refused')]), 'kit:applyBundle': () => result() })
    expect((await run(g.ctx, ['import', file(), '--yes'])).code).toBe(1)
    expect(g.out()).toContain('Nothing to import; 1 item refused.')
    expect(g.client.callsOf('kit:applyBundle')).toEqual([])

    const h = setup({ 'kit:previewBundle': () => preview([item('skill:0', 'same')]), 'kit:applyBundle': () => result() })
    expect((await run(h.ctx, ['import', file(), '--yes'])).code).toBe(EXIT.ok)
  })

  it('a file over 50 MB is exit 2 before anything is sent', async () => {
    kitFs.stat = (async () => ({ isFile: () => true, size: 50 * 1024 * 1024 + 1 })) as unknown as typeof kitFs.stat
    const f = setup()
    expect((await run(f.ctx, ['import', join(dir, 'huge.orgai-kit.json')])).code).toBe(EXIT.usage)
    expect(f.connectCalls).toEqual([])
  })

  it('a missing file is exit 2', async () => {
    expect((await run(setup().ctx, ['import', join(dir, 'none.json')])).code).toBe(EXIT.usage)
    expect(existsSync(join(dir, 'none.json'))).toBe(false)
  })
})
