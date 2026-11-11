import { describe, expect, it } from 'vitest'
import type { HostScope, OutputPreview, OutputReviseOptions, RunOutput } from '../../shared/types'
import { fakeContext, FakeHostClient, project, summary, type Answer } from '../testing/fakeContext'
import { CliError } from '../types'
import { defaultTarget, findOutput, runOutputs } from './outputs'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const P = project('p1', '/work', { name: 'App' })

const out = (id: string, over: Partial<RunOutput> = {}): RunOutput => ({
  id,
  projectId: 'p1',
  runId: 'run_one111',
  role: 'Writer',
  kind: 'markdown',
  title: 'Launch plan',
  fileName: 'plan.md',
  path: '/work/outputs/plan.md',
  relPath: 'outputs/plan.md',
  bytes: 2048,
  createdAt: 1000,
  source: 'produced',
  version: 2,
  versionCount: 2,
  openNoteCount: 1,
  ...over
})
const A = out('out_aaaaaaaa11111111')
const B = out('out_bbbbbbbb22222222', { runId: 'run_two222', kind: 'image', title: 'Logo', fileName: 'logo.png', relPath: 'outputs/logo.png', path: '/work/outputs/logo.png', openNoteCount: 0, version: 1, versionCount: 1 })
const runs = [summary('run_one111', { startedAt: 1000, projectId: 'p1' }), summary('run_two222', { startedAt: 2000, projectId: 'p1' })]

function setup(answers: Record<string, Answer> = {}, format: 'text' | 'json' = 'text') {
  const client = new FakeHostClient(
    {
      'projects:list': () => [P],
      'runs:list': () => runs,
      'outputs:list': () => [A, B],
      'outputs:preview': (): OutputPreview => ({ kind: 'text', text: '# Plan\nShip it \x1b[31mred' }),
      ...answers
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], cwd: '/work', store: { projects: [P], runs }, globals: { outputFormat: format } })
  return { f, client }
}

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  try {
    return await runOutputs(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('findOutput', () => {
  it('matches id, prefix, file name, path and title; refuses ambiguity and unknowns (exit 2)', () => {
    expect(findOutput([A, B], 'out_aaaaaaaa11111111')).toBe(A)
    expect(findOutput([A, B], 'out_bbbb')).toBe(B)
    expect(findOutput([A, B], 'LOGO.png')).toBe(B)
    expect(findOutput([A, B], 'outputs/plan.md')).toBe(A)
    expect(findOutput([A, B], 'launch plan')).toBe(A)
    expect(() => findOutput([A, out('out_aaaaaaaa99999999')], 'out_aaaa')).toThrow(/matches 2 outputs/)
    expect(() => findOutput([A], 'nope')).toThrow(/No output "nope"/)
    expect(() => findOutput([A], 'out_')).toThrow(/No output/)
  })
})

describe('outputs list', () => {
  it('lists the project outputs as a table (bare command lists)', async () => {
    const { f, client } = setup()
    expect(await run(f, [])).toBe(0)
    expect(f.out()).toMatch(/out_aaaaaaaa11111111\s+Launch plan\s+markdown\s+v2\s+2 KB\s+1\s+outputs\/plan\.md/)
    expect(f.out()).toContain('Logo')
    expect(client.calls.map((c) => c.method)).toContain('outputs:list')
  })

  it('--run keeps one run\'s outputs', async () => {
    const { f } = setup()
    expect(await run(f, ['list', '--run', 'R2'])).toBe(0)
    expect(f.out()).toContain('Logo')
    expect(f.out()).not.toContain('Launch plan')
  })

  it('says so when there are none; JSON has the fields', async () => {
    const { f } = setup({ 'outputs:list': () => [] })
    expect(await run(f, ['list'])).toBe(0)
    expect(f.out()).toContain('No outputs yet.')
    const j = setup({}, 'json')
    expect(await run(j.f, ['list'])).toBe(0)
    const v = JSON.parse(j.f.out())
    expect(v.outputs[0]).toMatchObject({ id: A.id, kind: 'markdown', version: 2, openNotes: 1, path: '/work/outputs/plan.md' })
  })
})

describe('outputs show', () => {
  it('prints metadata and a cleaned text preview', async () => {
    const { f } = setup()
    expect(await run(f, ['show', 'plan.md'])).toBe(0)
    const o = f.out()
    expect(o).toContain('Launch plan [out_aaaaaaaa11111111]')
    expect(o).toContain('path: /work/outputs/plan.md')
    expect(o).toContain('Preview:')
    expect(o).toContain('Ship it')
    expect(o).not.toContain('\x1b')
  })

  it('gives the path for a kind with no text preview', async () => {
    const { f } = setup({ 'outputs:preview': (): OutputPreview => ({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA' }) })
    expect(await run(f, ['show', 'logo.png'])).toBe(0)
    expect(f.out()).toContain('No text preview for image')
    expect(f.out()).toContain('/work/outputs/logo.png')
    expect(f.out()).not.toContain('base64')
  })

  it('unknown output is exit 2; JSON carries the preview text', async () => {
    const { f } = setup()
    expect(await run(f, ['show', 'zzz'])).toBe(2)
    const j = setup({}, 'json')
    expect(await run(j.f, ['show', A.id])).toBe(0)
    expect(JSON.parse(j.f.out()).preview).toMatchObject({ kind: 'text', truncated: false })
  })
})

describe('outputs revise', () => {
  const opts = (o: OutputReviseOptions): Record<string, Answer> => ({ 'outputs:reviseOptions': () => o })

  it('goes to the run that made it, whole scope, current version', async () => {
    const { f, client } = setup({ ...opts({ runs: [{ runId: 'run_one111', label: 'R1', state: 'live', madeCurrent: true }], newRunAllowed: true }), 'outputs:revise': () => ({ requestId: 'rev_1', runId: 'run_one111', mode: 'sent' }) })
    expect(await run(f, ['revise', 'plan.md', 'Shorten the intro'])).toBe(0)
    expect((client.callsOf('outputs:revise')[0] as unknown[])[0]).toEqual({ projectId: 'p1', outputId: A.id, version: 2, scope: 'whole', instruction: 'Shorten the intro', target: { type: 'run', runId: 'run_one111' } })
    expect(f.out()).toContain('Sent to the running run run_one111')
  })

  it('--new and --run choose the target; both is exit 2', async () => {
    const { f, client } = setup({ 'outputs:revise': () => ({ requestId: 'r', runId: 'run_new', mode: 'started' }) })
    expect(await run(f, ['revise', 'plan.md', 'x', '--new'])).toBe(0)
    expect(((client.callsOf('outputs:revise')[0] as { target: unknown }[])[0]).target).toEqual({ type: 'new' })
    expect(await run(setup().f, ['revise', 'plan.md', 'x', '--new', '--run', 'R1'])).toBe(2)
    expect(await run(setup().f, ['revise', 'plan.md', '  '])).toBe(2)
  })

  it('prints the host refusal and exits 1; a held run with no new run is refused', async () => {
    const r = setup({ ...opts({ runs: [], newRunAllowed: true }), 'outputs:revise': () => ({ refused: 'The run has an open card.' }) })
    expect(await run(r.f, ['revise', 'plan.md', 'x'])).toBe(1)
    expect(r.f.err()).toContain('The run has an open card.')
    const h = setup(opts({ runs: [{ runId: 'run_one111', label: 'R1', state: 'held', madeCurrent: true }], newRunAllowed: false }))
    expect(await run(h.f, ['revise', 'plan.md', 'x'])).toBe(1)
  })

  it('defaultTarget prefers a live or continuable run, then a new run', () => {
    expect(defaultTarget({ runs: [{ runId: 'a', label: '', state: 'held', madeCurrent: true }, { runId: 'b', label: '', state: 'continuable', madeCurrent: false }], newRunAllowed: true })).toEqual({ type: 'run', runId: 'b' })
    expect(defaultTarget({ runs: [], newRunAllowed: true })).toEqual({ type: 'new' })
    expect(defaultTarget({ runs: [], newRunAllowed: false })).toBeUndefined()
  })
})

describe('outputs note', () => {
  it('adds a whole-version note on the current version', async () => {
    const { f, client } = setup({ 'outputs:noteAdd': () => ({ id: 'note_0123456789abcdef', outputId: A.id, version: 2, anchor: { type: 'whole' }, text: 'Check the dates', status: 'open', createdAt: 1 }) })
    expect(await run(f, ['note', 'plan.md', 'Check the dates'])).toBe(0)
    expect((client.callsOf('outputs:noteAdd')[0] as unknown[])[0]).toEqual({ projectId: 'p1', outputId: A.id, version: 2, anchor: { type: 'whole' }, text: 'Check the dates' })
    expect(f.out()).toContain('Added a note to Launch plan v2')
  })

  it('checks the text and --version before any call', async () => {
    const { f, client } = setup()
    expect(await run(f, ['note', 'plan.md', ''])).toBe(2)
    expect(await run(f, ['note', 'plan.md', 'x'.repeat(2001)])).toBe(2)
    expect(await run(f, ['note', 'plan.md', 'x', '--version', '0'])).toBe(2)
    expect(client.calls.length).toBe(0)
  })
})
