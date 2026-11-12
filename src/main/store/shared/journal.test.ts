/**
 * Journal engine tests (docs/design/parallel-sessions.md 4.9). Real temp dirs, no tokens. Kill points are simulated
 * by throwing from `apply` (before or after the effect) and then recovering with fresh handlers.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hook = vi.hoisted(() => ({ onWrite: null as null | ((file: string) => void) }))
vi.mock('./atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomicWrite')>()
  return {
    ...actual,
    writeFileAtomic: (file: string, data: string | Uint8Array, mode?: number) => {
      hook.onWrite?.(file)
      return actual.writeFileAtomic(file, data, mode)
    }
  }
})

import {
  abandonJournal,
  beginJournal,
  canonicalPath,
  checkSharedLocators,
  commitJournal,
  findPendingJournals,
  localLocatorPath,
  readJournal,
  recoverJournal,
  removeStaleOwnSharedLocators,
  resolveNeedsAttention,
  runStep,
  sharedLocatorPath,
  type ForeignJournalState,
  type JournalRecord,
  type StepHandler,
  type StepHandlers
} from './journal'

let root: string
let control: string
let cache: string
let world: Record<string, string>
let failAt: { step: string; afterEffect: boolean } | null

interface SetArgs {
  k: string
  from: string
  to: string
}

function makeHandlers(): StepHandlers {
  const set: StepHandler = {
    pre: (a) => world[(a as SetArgs).k] === (a as SetArgs).from,
    post: (a) => world[(a as SetArgs).k] === (a as SetArgs).to,
    apply: (a) => {
      const x = a as SetArgs & { id?: string }
      if (failAt && failAt.step === x.k && !failAt.afterEffect) throw new Error('crash')
      world[x.k] = x.to
      if (failAt && failAt.step === x.k && failAt.afterEffect) throw new Error('crash')
    },
    inverse: (a) => {
      world[(a as SetArgs).k] = (a as SetArgs).from
    }
  }
  return { set }
}

function record(opId: string, rule: 'forward' | 'back' = 'forward', keys = ['project-p1']): Omit<JournalRecord, 'state'> {
  return {
    opId,
    op: 'test',
    hostId: 'h1',
    requiredLocks: ['team-p1'],
    resources: keys,
    rule,
    steps: ['a', 'b', 'c'].map((k) => ({ id: `s-${k}`, kind: 'set', args: { k, from: '0', to: '1' } }))
  }
}

async function runAll(h: ReturnType<typeof beginJournal>, handlers: StepHandlers): Promise<void> {
  for (const s of h.record.steps) await runStep(h, s.id, handlers.set)
}

const localDir = (key: string): string => join(control, 'journal', 'by-resource', key)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-journal-'))
  control = join(root, 'data', 'control')
  cache = join(root, 'cache', 'journal')
  mkdirSync(control, { recursive: true })
  world = { a: '0', b: '0', c: '0' }
  failAt = null
  hook.onWrite = null
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('begin / run / commit', () => {
  it('writes locators and the canonical journal, then removes everything on commit', async () => {
    const h = beginJournal(control, record('op1'))
    expect(existsSync(localLocatorPath(control, 'project-p1', 'op1'))).toBe(true)
    expect(readJournal(control, 'op1')?.state).toBe('active')
    await runAll(h, makeHandlers())
    expect(world).toEqual({ a: '1', b: '1', c: '1' })
    commitJournal(h)
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
    expect(existsSync(localLocatorPath(control, 'project-p1', 'op1'))).toBe(false)
  })

  it('refuses to commit while a step is not done', () => {
    const h = beginJournal(control, record('op1'))
    expect(() => commitJournal(h)).toThrow(/unfinished/)
    expect(readJournal(control, 'op1')?.state).toBe('active')
  })

  it('validates opId and resource keys before writing anything', () => {
    expect(() => beginJournal(control, record('../evil'))).toThrow(/Invalid journal operation id/)
    expect(() => beginJournal(control, record('ok', 'forward', ['a/b']))).toThrow(/Invalid journal resource key/)
    expect(() => beginJournal(control, record('ok', 'forward', ['..']))).toThrow(/Invalid journal resource key/)
    expect(() => beginJournal(control, record('ok'), { sharedLocators: { cacheJournalDir: cache, resourceKeys: ['x'], folderId: 'bad/id' } })).toThrow(/Invalid folder id/)
    expect(existsSync(join(control, 'journal'))).toBe(false)
  })

  it('durable ordering: every locator exists before the canonical file is written', () => {
    const seen: { locatorsPresent: boolean; sharedPresent: boolean }[] = []
    hook.onWrite = (file) => {
      if (file === canonicalPath(control, 'op1') && seen.length === 0) {
        seen.push({
          locatorsPresent: existsSync(localLocatorPath(control, 'project-p1', 'op1')) && existsSync(localLocatorPath(control, 'library', 'op1')),
          sharedPresent: existsSync(sharedLocatorPath(cache, 'output-file-ab', 'f1', 'op1'))
        })
      }
    }
    beginJournal(control, record('op1', 'forward', ['project-p1', 'library']), {
      sharedLocators: { cacheJournalDir: cache, resourceKeys: ['output-file-ab'], folderId: 'f1' }
    })
    expect(seen).toEqual([{ locatorsPresent: true, sharedPresent: true }])
    const shared = JSON.parse(readFileSync(sharedLocatorPath(cache, 'output-file-ab', 'f1', 'op1'), 'utf8'))
    expect(shared).toEqual({ dataFolder: join(root, 'data'), opId: 'op1' })
  })

  it('commit removes locators before the canonical journal', () => {
    const h = beginJournal(control, record('op1'))
    for (const s of h.record.steps) {
      s.started = true
      s.done = true
    }
    // The committed state is written durably first; then locators go before the canonical file.
    let committedSeenWithLocator = false
    hook.onWrite = (file) => {
      if (file === canonicalPath(control, 'op1')) committedSeenWithLocator = existsSync(localLocatorPath(control, 'project-p1', 'op1'))
    }
    commitJournal(h)
    expect(committedSeenWithLocator).toBe(true)
    expect(existsSync(localLocatorPath(control, 'project-p1', 'op1'))).toBe(false)
  })
})

describe('kill points', () => {
  for (const afterEffect of [false, true]) {
    for (const k of ['a', 'b', 'c']) {
      it(`forward: crash ${afterEffect ? 'after' : 'before'} the effect of step ${k} completes on recovery`, async () => {
        const h = beginJournal(control, record('op1', 'forward'))
        failAt = { step: k, afterEffect }
        await expect(runAll(h, makeHandlers())).rejects.toThrow('crash')
        failAt = null
        const res = await recoverJournal(control, 'op1', makeHandlers())
        expect(res.status).toBe('committed')
        expect(world).toEqual({ a: '1', b: '1', c: '1' })
        expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
        expect(readdirSync(join(control, 'journal', 'by-resource'))).toEqual([])
      })

      it(`back: crash ${afterEffect ? 'after' : 'before'} the effect of step ${k} restores on recovery`, async () => {
        const h = beginJournal(control, record('op1', 'back'))
        failAt = { step: k, afterEffect }
        await expect(runAll(h, makeHandlers())).rejects.toThrow('crash')
        failAt = null
        const res = await recoverJournal(control, 'op1', makeHandlers())
        expect(res.status).toBe('rolled-back')
        expect(world).toEqual({ a: '0', b: '0', c: '0' })
        expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
        expect(existsSync(localDir('project-p1'))).toBe(false)
      })
    }
  }

  it('crash between steps (after done, before the next started) rolls forward', async () => {
    const h = beginJournal(control, record('op1'))
    const handlers = makeHandlers()
    await runStep(h, 's-a', handlers.set)
    const res = await recoverJournal(control, 'op1', handlers)
    expect(res.status).toBe('committed')
    expect(world).toEqual({ a: '1', b: '1', c: '1' })
  })

  it('back: a crash during rollback continues from the recorded undone steps', async () => {
    const h = beginJournal(control, record('op1', 'back'))
    const handlers = makeHandlers()
    await runAll(h, handlers)
    let calls = 0
    const flaky: StepHandlers = {
      set: {
        ...handlers.set,
        inverse: (a) => {
          if (++calls === 2) throw new Error('crash in rollback')
          return handlers.set.inverse!(a)
        }
      }
    }
    await expect(recoverJournal(control, 'op1', flaky)).rejects.toThrow('crash in rollback')
    const mid = readJournal(control, 'op1')!
    expect(mid.steps.map((s) => !!s.undone)).toEqual([false, false, true])
    expect(await recoverJournal(control, 'op1', handlers)).toEqual({ status: 'rolled-back' })
    expect(world).toEqual({ a: '0', b: '0', c: '0' })
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
  })

  it('an abandoned journal recovers like an active one', async () => {
    const h = beginJournal(control, record('op1'))
    failAt = { step: 'b', afterEffect: false }
    await expect(runAll(h, makeHandlers())).rejects.toThrow()
    failAt = null
    abandonJournal(h)
    expect(readJournal(control, 'op1')?.state).toBe('abandoned')
    expect((await recoverJournal(control, 'op1', makeHandlers())).status).toBe('committed')
    expect(world.c).toBe('1')
  })
})

describe('unstarted journals', () => {
  it('are discarded with their locators, never rolled forward (both rules)', async () => {
    for (const rule of ['forward', 'back'] as const) {
      beginJournal(control, record(`op-${rule}`, rule))
      const res = await recoverJournal(control, `op-${rule}`, makeHandlers())
      expect(res.status).toBe('removed')
      expect(existsSync(canonicalPath(control, `op-${rule}`))).toBe(false)
      expect(existsSync(localLocatorPath(control, 'project-p1', `op-${rule}`))).toBe(false)
    }
    expect(world).toEqual({ a: '0', b: '0', c: '0' })
  })

  it('never re-creates missing locators of an unstarted journal', async () => {
    beginJournal(control, record('op1'))
    rmSync(localDir('project-p1'), { recursive: true })
    await recoverJournal(control, 'op1', makeHandlers())
    expect(existsSync(localDir('project-p1'))).toBe(false)
  })

  it('crash after the canonical write but before step 1 started: discarded, and its shared locator does not block another folder', async () => {
    const sharedOpts = { sharedLocators: { cacheJournalDir: cache, resourceKeys: ['output-file-ab'], folderId: 'f1' } }
    beginJournal(control, record('op1', 'forward', ['output-file-ab']), sharedOpts)
    // Another folder, while the journal is still present and not committed, is refused.
    const reader = (dataFolder: string, opId: string): ForeignJournalState =>
      readJournal(join(dataFolder, 'control'), opId) ? 'pending' : 'absent'
    const blocked = checkSharedLocators(cache, 'output-file-ab', 'f2', reader)
    expect(blocked).toEqual({ proceed: false, refusalFolder: join(root, 'data'), reason: 'pending' })
    // Recovery discards it (no step started); afterwards the other folder proceeds.
    await recoverJournal(control, 'op1', makeHandlers())
    expect(checkSharedLocators(cache, 'output-file-ab', 'f2', reader)).toEqual({ proceed: true })
    expect(existsSync(sharedLocatorPath(cache, 'output-file-ab', 'f1', 'op1'))).toBe(false)
  })

  it('a shared locator whose canonical was never written is stale for another folder and removed', () => {
    const dir = join(cache, 'output-file-ab')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'f1-op9.json'), JSON.stringify({ dataFolder: join(root, 'data'), opId: 'op9' }))
    const reader = (dataFolder: string, opId: string): ForeignJournalState =>
      readJournal(join(dataFolder, 'control'), opId) ? 'pending' : 'absent'
    expect(checkSharedLocators(cache, 'output-file-ab', 'f2', reader)).toEqual({ proceed: true })
    expect(existsSync(join(dir, 'f1-op9.json'))).toBe(false)
  })
})

describe('needs-attention', () => {
  it('a step whose target changed (pre and post false) stops recovery, keeps the journal and refuses the operation', async () => {
    const h = beginJournal(control, record('op1'))
    const handlers = makeHandlers()
    await runStep(h, 's-a', handlers.set)
    failAt = { step: 'b', afterEffect: false }
    await expect(runStep(h, 's-b', handlers.set)).rejects.toThrow('crash') // started, effect never landed
    failAt = null
    world.b = 'someone-else' // neither '0' nor '1'
    const res = await recoverJournal(control, 'op1', handlers)
    expect(res).toMatchObject({ status: 'needs-attention', stepId: 's-b' })
    expect(readJournal(control, 'op1')?.state).toBe('needs-attention')
    // The journal stays findable, so the operation on that resource is refused.
    const pending = findPendingJournals(control, ['project-p1'])
    expect(pending.find((p) => p.opId === 'op1')?.record.state).toBe('needs-attention')
    // Recovering again is idempotent and does not touch the target.
    expect(await recoverJournal(control, 'op1', handlers)).toMatchObject({ status: 'needs-attention', stepId: 's-b' })
    expect(world.b).toBe('someone-else')
  })

  async function stuckJournal(rule: 'forward' | 'back'): Promise<void> {
    const h = beginJournal(control, record('op1', rule))
    const handlers = makeHandlers()
    await runStep(h, 's-a', handlers.set)
    failAt = { step: 'b', afterEffect: false }
    await expect(runStep(h, 's-b', handlers.set)).rejects.toThrow()
    failAt = null
    world.b = 'changed'
    expect((await recoverJournal(control, 'op1', handlers)).status).toBe('needs-attention')
  }

  it('manual finish (forward) applies what it can, settles the stuck step, commits and removes', async () => {
    await stuckJournal('forward')
    const res = await resolveNeedsAttention(control, 'op1', 'finish', makeHandlers())
    expect(res.status).toBe('committed')
    expect(world).toEqual({ a: '1', b: 'changed', c: '1' })
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
    expect(existsSync(localDir('project-p1'))).toBe(false)
  })

  it('manual finish (back) undoes what it can and removes the journal', async () => {
    await stuckJournal('back')
    const res = await resolveNeedsAttention(control, 'op1', 'finish', makeHandlers())
    expect(res.status).toBe('rolled-back')
    expect(world).toEqual({ a: '0', b: 'changed', c: '0' })
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
  })

  it('manual discard removes locators and journal and touches no target', async () => {
    await stuckJournal('forward')
    expect((await resolveNeedsAttention(control, 'op1', 'discard', makeHandlers())).status).toBe('removed')
    expect(world).toEqual({ a: '1', b: 'changed', c: '0' })
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
    expect(existsSync(localDir('project-p1'))).toBe(false)
  })

  it('resolve refuses a journal that is not in needs-attention', async () => {
    beginJournal(control, record('op1'))
    await expect(resolveNeedsAttention(control, 'op1', 'discard', makeHandlers())).rejects.toThrow(/not in needs-attention/)
  })
})

describe('locator repair and committed journals', () => {
  it('re-creates missing locators (local and shared) only for a started journal', async () => {
    const sharedOpts = { sharedLocators: { cacheJournalDir: cache, resourceKeys: ['output-file-ab'], folderId: 'f1' } }
    const h = beginJournal(control, record('op1', 'forward', ['project-p1', 'output-file-ab']), sharedOpts)
    failAt = { step: 'b', afterEffect: false }
    await expect(runAll(h, makeHandlers())).rejects.toThrow()
    failAt = null
    rmSync(localDir('project-p1'), { recursive: true })
    rmSync(join(cache, 'output-file-ab'), { recursive: true })
    // While recovery runs, the locators are back (observed at the first resumed durable write).
    let repaired: boolean[] = []
    hook.onWrite = (file) => {
      if (file === canonicalPath(control, 'op1') && repaired.length === 0) {
        repaired = [existsSync(localLocatorPath(control, 'project-p1', 'op1')), existsSync(sharedLocatorPath(cache, 'output-file-ab', 'f1', 'op1'))]
      }
    }
    await recoverJournal(control, 'op1', makeHandlers())
    expect(repaired).toEqual([true, true])
    expect(existsSync(localDir('project-p1'))).toBe(false)
    expect(readdirSync(cache)).toEqual([])
  })

  it('a committed journal with half-removed locators finishes the removal and re-creates nothing', async () => {
    const sharedOpts = { sharedLocators: { cacheJournalDir: cache, resourceKeys: ['output-file-ab'], folderId: 'f1' } }
    const h = beginJournal(control, record('op1', 'forward', ['project-p1', 'library', 'output-file-ab']), sharedOpts)
    await runAll(h, makeHandlers())
    h.record.state = 'committed'
    writeFileSync(canonicalPath(control, 'op1'), JSON.stringify(h.record))
    rmSync(localDir('project-p1'), { recursive: true }) // half removed
    expect(await recoverJournal(control, 'op1', makeHandlers())).toEqual({ status: 'committed' })
    expect(existsSync(canonicalPath(control, 'op1'))).toBe(false)
    expect(existsSync(localDir('project-p1'))).toBe(false)
    expect(existsSync(localDir('library'))).toBe(false)
    expect(existsSync(sharedLocatorPath(cache, 'output-file-ab', 'f1', 'op1'))).toBe(false)
  })

  it('findPendingJournals reads state from the canonical file and removes stale locators', async () => {
    const h = beginJournal(control, record('op1', 'forward', ['project-p1', 'library']))
    expect(findPendingJournals(control, ['project-p1', 'library']).map((p) => p.opId)).toEqual(['op1'])
    // stale: locator with no canonical
    mkdirSync(localDir('library'), { recursive: true })
    writeFileSync(join(localDir('library'), 'ghost'), '')
    expect(findPendingJournals(control, ['library']).map((p) => p.opId)).toEqual(['op1'])
    expect(existsSync(join(localDir('library'), 'ghost'))).toBe(false)
    // state is what the canonical file says, not what a locator suggests
    abandonJournal(h)
    expect(findPendingJournals(control, ['library'])[0].record.state).toBe('abandoned')
    expect(findPendingJournals(control, ['project-zzz'])).toEqual([])
  })

  it('removeStaleOwnSharedLocators removes only own locators whose canonical journal is absent', () => {
    const sharedOpts = { sharedLocators: { cacheJournalDir: cache, resourceKeys: ['output-file-ab'], folderId: 'f1' } }
    beginJournal(control, record('live', 'forward', ['output-file-ab']), sharedOpts)
    const dir = join(cache, 'output-file-ab')
    writeFileSync(join(dir, 'f1-dead.json'), '{}')
    writeFileSync(join(dir, 'f9-other.json'), '{}')
    expect(removeStaleOwnSharedLocators(control, cache, 'output-file-ab', 'f1')).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['f1-live.json', 'f9-other.json'])
  })
})

describe('checkSharedLocators', () => {
  function put(folder: string, opId: string, dataFolder: string): void {
    const dir = join(cache, 'k1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${folder}-${opId}.json`), JSON.stringify({ dataFolder, opId }))
  }

  it('removes absent and committed foreign locators and proceeds; ignores its own', () => {
    put('f1', 'a1', '/x')
    put('f1', 'a2', '/x')
    put('f2', 'mine', '/me')
    const state: Record<string, ForeignJournalState> = { a1: 'absent', a2: 'committed' }
    const res = checkSharedLocators(cache, 'k1', 'f2', (_d, op) => state[op])
    expect(res).toEqual({ proceed: true })
    expect(readdirSync(join(cache, 'k1'))).toEqual(['f2-mine.json'])
  })

  it('refuses on a pending foreign journal naming its folder, keeping the locator', () => {
    put('f1', 'a1', '/x')
    const res = checkSharedLocators(cache, 'k1', 'f2', () => 'pending')
    expect(res).toEqual({ proceed: false, refusalFolder: '/x', reason: 'pending' })
    expect(existsSync(join(cache, 'k1', 'f1-a1.json'))).toBe(true)
  })

  it('refuses on an unreadable foreign folder or a malformed locator, removing nothing', () => {
    put('f1', 'a1', '/x')
    expect(checkSharedLocators(cache, 'k1', 'f2', () => 'unreadable')).toEqual({ proceed: false, refusalFolder: '/x', reason: 'unreadable' })
    writeFileSync(join(cache, 'k1', 'f3-bad.json'), 'not json')
    const res = checkSharedLocators(cache, 'k1', 'f2', () => 'absent')
    expect(res.proceed).toBe(false)
    expect(res.reason).toBe('unreadable')
    expect(existsSync(join(cache, 'k1', 'f3-bad.json'))).toBe(true)
  })

  it('proceeds when there is no locator directory', () => {
    expect(checkSharedLocators(cache, 'nokey', 'f2', () => 'pending')).toEqual({ proceed: true })
  })
})

describe('idempotence', () => {
  for (const rule of ['forward', 'back'] as const) {
    it(`recovering twice gives the same result (${rule})`, async () => {
      const h = beginJournal(control, record('op1', rule))
      failAt = { step: 'b', afterEffect: true }
      await expect(runAll(h, makeHandlers())).rejects.toThrow()
      failAt = null
      const first = await recoverJournal(control, 'op1', makeHandlers())
      const snapshot = { ...world }
      const second = await recoverJournal(control, 'op1', makeHandlers())
      expect(first.status).toBe(rule === 'forward' ? 'committed' : 'rolled-back')
      expect(second).toEqual({ status: 'removed' })
      expect(world).toEqual(snapshot)
    })
  }
})
