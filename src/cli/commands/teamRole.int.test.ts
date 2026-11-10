/**
 * Integration: `orgai team role add | set | move | rm` and `mcp update --role` against a real in-process host over its
 * real socket (cli-parity 3.3). Every command goes through `main(argv)` with process.stdout / stderr captured and starts
 * its own host on a temp data dir. Mock adapter only; no tokens.
 */
import { writeProductMarker } from '../../main/store/productMarker'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Role } from '../../shared/types'

type Main = (argv: string[]) => Promise<number>

describe('orgai team role editing against a real inproc host', () => {
  let userDataDir: string
  let codeDir: string
  let main: Main
  const saved = { mock: process.env.ORGAI_MOCK, data: process.env.ORGAI_CLI_DATA_DIR }
  let out = ''
  let err = ''

  async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const o0 = out.length
    const e0 = err.length
    const code = await main(['--data-dir', userDataDir, '--no-color', '--project', codeDir, ...args])
    return { code, out: out.slice(o0), err: err.slice(e0) }
  }
  const json = async (args: string[]): Promise<{ code: number; doc: Record<string, unknown>; err: string }> => {
    const r = await cli([...args, '--output-format', 'json'])
    let doc: Record<string, unknown> = {}
    try {
      doc = JSON.parse(r.out) as Record<string, unknown>
    } catch {
      throw new Error(`not JSON (exit ${r.code}): ${r.out} ${r.err}`)
    }
    return { code: r.code, doc, err: r.err }
  }
  beforeAll(async () => {
    userDataDir = mkdtempSync(join(realpathSync(tmpdir()), 'orgai-teamrole-int-'))
    codeDir = join(userDataDir, 'code-repo')
    mkdirSync(codeDir)
    process.env.ORGAI_MOCK = '1'
    process.env.ORGAI_CLI_DATA_DIR = userDataDir
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string | Uint8Array) => ((out += String(s)), true)) as typeof process.stdout.write)
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string | Uint8Array) => ((err += String(s)), true)) as typeof process.stderr.write)
    main = ((await import('../index')) as unknown as { main: Main }).main
    writeProductMarker(userDataDir, 'orgai-cli')
    const created = await cli(['projects', 'create', codeDir, '--name', 'Roles int'])
    if (created.code !== 0) throw new Error(`projects create failed: ${created.err}`)
  }, 60_000)

  afterAll(async () => {
    vi.restoreAllMocks()
    process.env.ORGAI_MOCK = saved.mock
    process.env.ORGAI_CLI_DATA_DIR = saved.data
    if (saved.mock === undefined) delete process.env.ORGAI_MOCK
    if (saved.data === undefined) delete process.env.ORGAI_CLI_DATA_DIR
    rmSync(userDataDir, { recursive: true, force: true })
  }, 30_000)

  it('add a role, set every flag, move it, read it back, rm with reparent', async () => {
    const start = await json(['team', 'roles'])
    expect(start.code).toBe(0)
    const list = start.doc.roles as { slug: string; reportsTo: string | null }[]
    const root = list.find((r) => r.reportsTo === null)!.slug
    const other = list.find((r) => r.reportsTo !== null)!.slug

    const add = await json(['team', 'role', 'add', 'Docs Writer', '--reports-to', root, '--effort', 'low', '--yes'])
    expect(add.err).toBe('')
    expect(add.code).toBe(0)
    const added = (add.doc.role as { after: Role }).after
    expect(added).toMatchObject({ slug: 'docs-writer', effort: 'low', tools: ['Read', 'Glob', 'Grep'] })

    const helper = await json(['team', 'role', 'add', 'Helper', '--reports-to', 'docs-writer', '--yes'])
    expect(helper.code).toBe(0)

    const promptFile = join(userDataDir, 'prompt.md')
    writeFileSync(promptFile, 'You write the docs.\n')
    const set = await json([
      'team', 'role', 'set', 'docs-writer',
      '--name', 'Doc Writer', '--description', 'Writes docs', '--prompt-file', promptFile,
      '--model', 'deep', '--effort', 'high', '--staffing', 'auto', '--min-tier', 'fast', '--max-effort', 'high',
      '--tools', 'Read,Glob', '--add-tool', 'Write', '--rm-tool', 'Glob',
      '--can-spawn', 'on', '--spawnable', 'helper', '--required-reports', 'helper', '--connection', 'inherit', '--mcp', 'none', '--yes'
    ])
    expect(set.err).toBe('')
    expect(set.code).toBe(0)
    expect((set.doc.role as { before: Role }).before.slug).toBe('docs-writer')
    expect((set.doc.spend as string[]).length).toBeGreaterThan(0)

    const move = await json(['team', 'role', 'move', 'doc-writer', '--reports-to', other, '--yes'])
    expect(move.code).toBe(0)

    // Read back through a fresh host: the host kept every field.
    const show = await json(['team', 'role', 'doc-writer'])
    expect(show.code).toBe(0)
    const r = show.doc.role as Role
    expect(r).toMatchObject({
      name: 'Doc Writer',
      description: 'Writes docs',
      prompt: 'You write the docs.\n',
      tier: 'deep',
      effort: 'high',
      staffing: { mode: 'auto', minTier: 'fast', maxEffort: 'high' },
      tools: ['Read', 'Write'],
      canSpawn: true,
      requiredReports: [expect.any(String)]
    })
    const otherId = list.find((x) => x.slug === other) as unknown as { id: string }
    expect(r.reportsTo).toBe(otherId.id)
    const text = await cli(['team', 'role', 'doc-writer'])
    expect(text.out).toContain('  effort: high')
    expect(text.out).toContain('  staffing: automatic, from fast up to deep, at most high effort')
    expect(text.out).toMatch(/ {2}runs on: .+\(the project's connection\)/)

    // A role with reports needs --reparent-to; then its report moves and references are cleaned.
    const refused = await cli(['team', 'role', 'rm', 'doc-writer', '--yes'])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('--reparent-to')
    const rm = await json(['team', 'role', 'rm', 'doc-writer', '--reparent-to', root, '--yes'])
    expect(rm.code).toBe(0)
    expect((rm.doc.previousRoles as Role[]).some((x) => x.slug === 'doc-writer')).toBe(true)
    const after = (await json(['team', 'roles'])).doc.roles as { id: string; slug: string; reportsTo: string | null }[]
    expect(after.some((x) => x.slug === 'doc-writer')).toBe(false)
    const rootId = after.find((x) => x.slug === root)!.id
    expect(after.find((x) => x.slug === 'helper')?.reportsTo).toBe(rootId)
  })

  it('mcp update --role / --no-roles changes who may use a server', async () => {
    const add = await cli(['mcp', 'add', 'notes', '--command', 'node', '--arg', 'server.js'])
    expect(add.code).toBe(0)
    const slugs = ((await json(['team', 'roles'])).doc.roles as { slug: string }[]).map((r) => r.slug)
    const one = await json(['mcp', 'update', 'notes', '--role', slugs[0]])
    expect(one.code).toBe(0)
    expect(one.doc.roles).toEqual([slugs[0]])
    const none = await json(['mcp', 'update', 'notes', '--no-roles'])
    expect(none.doc).toMatchObject({ previousRoles: [slugs[0]], roles: [] })
    const bad = await cli(['mcp', 'update', 'notes', '--role', 'ghost'])
    expect(bad.code).toBe(2)
  })
})
