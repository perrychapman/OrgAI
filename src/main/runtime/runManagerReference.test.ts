import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-rmr-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function rig(options: RunManagerOptions = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => '') } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, options)
  return { m, ctxs }
}

const mk = (name: string): string => {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return p
}
const warnings = (): string[] => events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.level === 'warn').map((e) => e.message)
const lower = (xs: string[]): string[] => xs.map((x) => x.toLowerCase())

/** A fake save option over one in-memory project (appends, like ProjectStore.update). */
function saver(p: Project) {
  let stored = p
  const save = vi.fn((_id: string, patch: { addDirectories?: string[] }) => {
    stored = { ...stored, ...(patch.addDirectories ? { allowedDirectories: [...(stored.allowedDirectories ?? []), ...patch.addDirectories] } : {}) }
    return stored
  })
  return { save }
}

describe('reference folders in a run', () => {
  it('lists an existing folder and warns once about a missing one', async () => {
    const refs = mk('refs')
    const gone = join(dir, 'gone')
    const { m, ctxs } = rig({ dataDir: join(dir, 'data') })
    await m.start({ project: makeProject({ path: mk('repo'), kind: 'engagement', referenceDirectories: [refs, gone] }), prompt: 'go' })
    expect(lower(ctxs[0].referenceDirectories!())).toEqual([refs.toLowerCase()])
    expect(warnings()).toContain(`Reference folder ${gone} does not exist; agents cannot read it in this run.`)
    expect(warnings().filter((w) => w.includes(gone))).toHaveLength(1)
    await m.stopAll()
  })

  it('warns about a folder that is too broad', async () => {
    const repo = mk('repo')
    const { m, ctxs } = rig({ dataDir: join(dir, 'data') })
    // A folder that contains the project is too broad.
    await m.start({ project: makeProject({ path: repo, referenceDirectories: [dir] }), prompt: 'go' })
    expect(ctxs[0].referenceDirectories!()).toEqual([])
    await m.stopAll()
  })

  it('keeps a folder in both lists only in allowedDirectories()', async () => {
    const both = mk('both')
    const only = mk('only')
    const { m, ctxs } = rig({ dataDir: join(dir, 'data') })
    await m.start({ project: makeProject({ path: mk('repo'), allowedDirectories: [both], referenceDirectories: [both, only] }), prompt: 'go' })
    expect(lower(ctxs[0].allowedDirectories!())).toEqual([both.toLowerCase()])
    expect(lower(ctxs[0].referenceDirectories!())).toEqual([only.toLowerCase()])
    await m.stopAll()
  })

  it('gives no reference folders to a quick run', async () => {
    const refs = mk('refs')
    const work = mk('work')
    const { m, ctxs } = rig({ dataDir: join(dir, 'data') })
    await m.start({
      project: makeProject({ id: 'quick', name: 'Chat', path: work, runMessaging: false, referenceDirectories: [refs] }),
      prompt: 'q',
      quick: { folder: work, team: 'default', allowEdits: false, gitRepo: false }
    })
    expect(ctxs[0].referenceDirectories).toBeUndefined()
    await m.stopAll()
  })

  it('allowDirectories refuses a reference folder and its subfolder without saving, and still saves others', async () => {
    const refs = mk('refs')
    const sub = join(refs, 'sub')
    mkdirSync(sub, { recursive: true })
    const other = mk('other')
    const p = makeProject({ path: mk('repo'), referenceDirectories: [refs] })
    const s = saver(p)
    const { m, ctxs } = rig({ dataDir: join(dir, 'data'), saveProjectPermissions: s.save })
    await m.start({ project: p, prompt: 'go' })
    const ctx = ctxs[0]
    expect(ctx.allowDirectories!([refs, sub])).toEqual([])
    expect(s.save).not.toHaveBeenCalled()
    const inForce = ctx.allowDirectories!([sub, other])
    expect(s.save).toHaveBeenCalledWith(p.id, { addDirectories: [other] })
    expect(lower(inForce)).toEqual([other.toLowerCase()])
    expect(lower(ctx.referenceDirectories!())).toEqual([refs.toLowerCase()])
    await m.stopAll()
  })
})
