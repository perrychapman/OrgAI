import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEDULES_MAX, SCHEDULE_HISTORY_MAX } from '../../shared/types'
import type { Schedule, ScheduleHistoryEntry } from '../../shared/types'
import { nodeVaultFs } from '../store/durableFs'
import { ScheduleStore } from './store'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-sched-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const hex = (n: number): string => `sch_${n.toString(16).padStart(8, '0')}`

function schedule(n: number, over: Partial<Schedule> = {}): Schedule {
  return {
    id: hex(n),
    name: `Schedule ${n}`,
    prompt: 'Summarise the news',
    target: { kind: 'ask' },
    timing: { kind: 'daily', time: '09:30' },
    enabled: true,
    missed: 'run-once',
    state: 'active',
    createdAt: 1_700_000_000_000 + n,
    updatedAt: 1_700_000_000_000 + n,
    createdBy: 'user',
    consecutiveFailures: 0,
    unread: 0,
    ...over
  }
}

function entry(n: number, scheduleId: string, over: Partial<ScheduleHistoryEntry> = {}): ScheduleHistoryEntry {
  return { id: `h${n}`, scheduleId, slotAt: 1_700_000_000_000 + n, at: 1_700_000_000_000 + n + 5, trigger: 'timer', result: 'started', ...over }
}

function rawFile(dataDir: string, schedules: unknown[], history: unknown[] = [], version: unknown = 1): void {
  fs.writeFileSync(path.join(dataDir, 'schedules.json'), JSON.stringify({ version, schedules, history }))
}

describe('ScheduleStore round trip', () => {
  it('starts empty and writable when there is no file, creating the data dir on first write', () => {
    const sub = path.join(dir, 'nested', 'data')
    const store = new ScheduleStore(sub)
    expect(store.file).toBe(path.join(sub, 'schedules.json'))
    expect(store.readOnlyReason()).toBeNull()
    expect(store.list()).toEqual([])
    store.update((d) => void d.schedules.push(schedule(1)))
    expect(fs.existsSync(store.file)).toBe(true)
  })

  it('persists schedules and history, and a fresh store reads them back', () => {
    const store = new ScheduleStore(dir)
    const s = schedule(1, { modelSelection: { model: 'm', connection: 'anthropic' }, permissionMode: 'acceptEdits', budgetUsd: 2, expiresAt: 1_800_000_000_000, nextRunAt: 1_700_000_100_000, lastSlotAt: 1_700_000_050_000, stateReason: 'ok', consecutiveFailures: 2, unread: 3 })
    const e = entry(1, s.id, { detail: 'fine', runId: 'run_1', projectId: 'quick', outcome: 'finished', costUsd: 0.5 })
    const ret = store.update((d) => {
      d.schedules.push(s)
      d.history.push(e)
      return 42
    })
    expect(ret).toBe(42)
    const again = new ScheduleStore(dir)
    expect(again.readOnlyReason()).toBeNull()
    expect(again.list()).toEqual([s])
    expect(again.get(s.id)).toEqual(s)
    expect(again.get('sch_ffff')).toBeUndefined()
    expect(again.history(s.id)).toEqual([e])
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8')).version).toBe(1)
  })

  it('returns deep copies: mutating a result changes nothing', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => void d.schedules.push(schedule(1)))
    store.list()[0].name = 'changed'
    store.get(hex(1))!.target = { kind: 'team', projectId: 'p' }
    expect(store.get(hex(1))!.name).toBe('Schedule 1')
    expect(store.get(hex(1))!.target).toEqual({ kind: 'ask' })
  })

  it('sorts the list by name then id, and history newest first', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => {
      d.schedules.push(schedule(3, { name: 'beta' }), schedule(2, { name: 'Alpha' }), schedule(1, { name: 'beta' }))
      d.history.push(entry(1, hex(1), { at: 100, slotAt: 1 }), entry(2, hex(1), { at: 300, slotAt: 2 }), entry(3, hex(1), { at: 300, slotAt: 5 }), entry(4, hex(2)))
    })
    expect(store.list().map((s) => s.id)).toEqual([hex(2), hex(1), hex(3)])
    expect(store.history(hex(1)).map((e) => e.id)).toEqual(['h3', 'h2', 'h1'])
  })

  it('keeps an interval anchor as stored', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => void d.schedules.push(schedule(1, { timing: { kind: 'interval', everyMinutes: 30, anchor: 1_700_000_000_000 } })))
    expect(new ScheduleStore(dir).get(hex(1))!.timing).toEqual({ kind: 'interval', everyMinutes: 30, anchor: 1_700_000_000_000 })
  })
})

describe('ScheduleStore writes', () => {
  it('leaves no temp file behind', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => void d.schedules.push(schedule(1)))
    store.update((d) => void d.schedules.push(schedule(2)))
    expect(fs.readdirSync(dir).sort()).toEqual(['schedules.json', 'schedules.json.bak'])
  })

  it('copies the previous good file to .bak on the second write', () => {
    const store = new ScheduleStore(dir)
    expect(fs.existsSync(`${store.file}.bak`)).toBe(false)
    store.update((d) => void d.schedules.push(schedule(1)))
    expect(fs.existsSync(`${store.file}.bak`)).toBe(false) // nothing to back up yet
    const first = fs.readFileSync(store.file, 'utf8')
    store.update((d) => void d.schedules.push(schedule(2)))
    expect(fs.readFileSync(`${store.file}.bak`, 'utf8')).toBe(first)
    expect(JSON.parse(first).schedules).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8')).schedules).toHaveLength(2)
  })

  it('changes nothing when fn throws', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => void d.schedules.push(schedule(1)))
    const before = fs.readFileSync(store.file, 'utf8')
    expect(() =>
      store.update((d) => {
        d.schedules.push(schedule(2))
        d.schedules[0].name = 'changed'
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(fs.readFileSync(store.file, 'utf8')).toBe(before)
    expect(store.list().map((s) => s.name)).toEqual(['Schedule 1'])
    expect(store.readOnlyReason()).toBeNull()
  })

  it('keeps the in-memory state and rethrows when the write fails, then recovers', () => {
    let fail = true
    const failing = { ...nodeVaultFs, renameSync: (a: string, b: string) => { if (fail && b.endsWith('schedules.json')) throw Object.assign(new Error('nope'), { code: 'EIO' }); nodeVaultFs.renameSync(a, b) } }
    const store = new ScheduleStore(dir, { fs: failing })
    expect(() => store.update((d) => void d.schedules.push(schedule(1)))).toThrow(/rename failed/)
    expect(store.list()).toEqual([])
    expect(fs.existsSync(store.file)).toBe(false)
    fail = false
    store.update((d) => void d.schedules.push(schedule(1)))
    expect(store.list()).toHaveLength(1)
  })

  it('sanitizes what update writes: junk never reaches the disk', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => {
      d.schedules.push(schedule(1), { ...schedule(2), name: '' }, { ...schedule(3), permissionMode: 'bypassPermissions' } as unknown as Schedule, { ...schedule(4), extra: 'x' } as unknown as Schedule)
      d.history.push(entry(1, hex(1)), entry(2, hex(2)), entry(3, 'sch_dead'))
    })
    const onDisk = JSON.parse(fs.readFileSync(store.file, 'utf8'))
    expect(onDisk.schedules.map((s: Schedule) => s.id)).toEqual([hex(1), hex(4)])
    expect(onDisk.schedules[1]).not.toHaveProperty('extra')
    expect(onDisk.history.map((e: ScheduleHistoryEntry) => e.id)).toEqual(['h1'])
  })
})

describe('ScheduleStore unreadable file', () => {
  const sentence = (file: string): string => `OrgAI could not read ${file}. Schedules are read-only until the file is fixed or removed; nothing was overwritten.`

  it('is never overwritten: bytes identical after update attempts, update throws the sentence, list empty', () => {
    const bad = '{ this is not json'
    const file = path.join(dir, 'schedules.json')
    fs.writeFileSync(file, bad)
    const logs: string[] = []
    const store = new ScheduleStore(dir, { log: (m) => logs.push(m) })
    expect(store.readOnlyReason()).toBe(sentence(file))
    expect(store.list()).toEqual([])
    let called = false
    expect(() => store.update(() => { called = true })).toThrow(sentence(file))
    expect(() => store.update((d) => void d.schedules.push(schedule(1)))).toThrow(sentence(file))
    expect(called).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(bad)
    expect(fs.readdirSync(dir)).toEqual(['schedules.json'])
    expect(logs).toHaveLength(1)
  })

  it.each([
    ['an array root', '[]'],
    ['a wrong version', JSON.stringify({ version: 2, schedules: [], history: [] })],
    ['a missing schedules list', JSON.stringify({ version: 1, history: [] })],
    ['a null root', 'null']
  ])('treats %s as unreadable', (_name, content) => {
    const file = path.join(dir, 'schedules.json')
    fs.writeFileSync(file, content)
    const store = new ScheduleStore(dir)
    expect(store.readOnlyReason()).toBe(sentence(file))
    expect(() => store.update(() => undefined)).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(content)
  })

  it('loads a parsable .bak but stays read-only and leaves both files alone', () => {
    const good = new ScheduleStore(dir)
    good.update((d) => void d.schedules.push(schedule(1)))
    good.update((d) => void d.schedules.push(schedule(2))) // .bak now holds the one-schedule file
    const bak = fs.readFileSync(`${good.file}.bak`, 'utf8')
    fs.writeFileSync(good.file, 'garbage')
    const store = new ScheduleStore(dir)
    expect(store.readOnlyReason()).toBe(sentence(store.file))
    expect(store.list().map((s) => s.id)).toEqual([hex(1)])
    expect(() => store.update((d) => void d.schedules.push(schedule(3)))).toThrow(/read-only/)
    expect(fs.readFileSync(store.file, 'utf8')).toBe('garbage')
    expect(fs.readFileSync(`${store.file}.bak`, 'utf8')).toBe(bak)
  })

  it('does not overwrite a file that went bad after the load', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => void d.schedules.push(schedule(1)))
    fs.writeFileSync(store.file, 'garbage')
    expect(() => store.update((d) => void d.schedules.push(schedule(2)))).toThrow(/could not read/)
    expect(fs.readFileSync(store.file, 'utf8')).toBe('garbage')
    expect(store.readOnlyReason()).not.toBeNull()
    expect(store.list()).toHaveLength(1)
  })
})

describe('ScheduleStore sanitizing on read', () => {
  it('drops junk entries and unknown keys field by field', () => {
    const good = schedule(1)
    rawFile(
      dir,
      [
        { ...good, extra: 'x', timing: { kind: 'daily', time: '09:30', bogus: 1 }, target: { kind: 'ask', junk: true }, modelSelection: null, budgetUsd: null },
        { ...schedule(2), id: 'nope' },
        { ...schedule(3), id: good.id }, // duplicate id
        { ...schedule(4), name: '   ' },
        { ...schedule(5), timing: { kind: 'interval', everyMinutes: 1 } },
        { ...schedule(6), state: 'running' },
        { ...schedule(7), createdAt: 'x' },
        { ...schedule(8), createdBy: 'robot' },
        { ...schedule(9), enabled: 'yes' },
        { ...schedule(10), missed: 'maybe' },
        { ...schedule(11), budgetUsd: -1 },
        'string',
        null,
        [],
        { ...schedule(12), consecutiveFailures: -3, unread: 1.9, stateReason: `bad\u0000${'x'.repeat(400)}`, nextRunAt: 'soon', lastSlotAt: 5, lastEntry: { at: 10, slotAt: 9, trigger: 'timer', result: 'skipped', reason: 'app-closed', outcome: 'finished', runId: 'run_1', extra: 1 } },
        { ...schedule(13), lastEntry: { at: 'x' } }
      ]
    )
    const store = new ScheduleStore(dir)
    expect(store.readOnlyReason()).toBeNull()
    const list = store.list()
    // 13 is kept: only its malformed lastEntry is dropped.
    expect(list.map((s) => s.id)).toEqual([hex(1), hex(12), hex(13)])
    expect(list[2]).not.toHaveProperty('lastEntry')
    expect(list[0]).toEqual(good)
    expect(list[0]).not.toHaveProperty('extra')
    expect(Object.keys(list[0].target)).toEqual(['kind'])
    const s12 = list[1]
    expect(s12.consecutiveFailures).toBe(0)
    expect(s12.unread).toBe(1)
    expect(s12.stateReason).toHaveLength(300)
    expect(s12.stateReason).not.toMatch(/\u0000/)
    expect(s12).not.toHaveProperty('nextRunAt')
    expect(s12.lastSlotAt).toBe(5)
    expect(s12.lastEntry).toEqual({ at: 10, slotAt: 9, trigger: 'timer', result: 'skipped', reason: 'app-closed', outcome: 'finished', runId: 'run_1' })
  })

  it('drops a schedule that asks for bypassPermissions', () => {
    rawFile(dir, [{ ...schedule(1), permissionMode: 'bypassPermissions' }, { ...schedule(2), permissionMode: 'plan' }])
    const store = new ScheduleStore(dir)
    expect(store.list().map((s) => s.id)).toEqual([hex(2)])
    expect(store.get(hex(2))!.permissionMode).toBe('plan')
  })

  it('drops invalid history entries and keeps valid fields', () => {
    const id = hex(1)
    rawFile(
      dir,
      [schedule(1)],
      [
        entry(1, id, { detail: `a\u0007b\nc${'z'.repeat(400)}`, costUsd: null, outcome: 'stopped', reason: 'usage-limited' }),
        { ...entry(2, id), id: 'bad id!' },
        { ...entry(3, id), trigger: 'cron' },
        { ...entry(4, id), result: 'ok' },
        { ...entry(5, id), at: Infinity },
        { ...entry(6, id), slotAt: 'x' },
        { ...entry(7, id), scheduleId: 'nope' },
        { ...entry(8, id), id: 'h1' }, // duplicate id
        { ...entry(9, id), reason: 'weird', outcome: 'weird', runId: '../x', projectId: 'a b', costUsd: -1, extra: 1 },
        7
      ]
    )
    const store = new ScheduleStore(dir)
    const h = store.history(id)
    expect(h.map((e) => e.id).sort()).toEqual(['h1', 'h9'])
    const h1 = h.find((e) => e.id === 'h1')!
    expect(h1.detail).toHaveLength(300)
    expect(h1.detail).not.toMatch(/[\u0000-\u001f]/)
    expect(h1.costUsd).toBeNull()
    expect(h1.outcome).toBe('stopped')
    expect(h1.reason).toBe('usage-limited')
    const h9 = h.find((e) => e.id === 'h9')!
    expect(h9).toEqual({ id: 'h9', scheduleId: id, slotAt: entry(9, id).slotAt, at: entry(9, id).at, trigger: 'timer', result: 'started' })
  })
})

describe('ScheduleStore caps', () => {
  it('keeps the newest SCHEDULE_HISTORY_MAX entries per schedule and drops orphan history', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => {
      d.schedules.push(schedule(1), schedule(2))
      for (let i = 1; i <= SCHEDULE_HISTORY_MAX + 10; i++) d.history.push(entry(i, hex(1), { id: `a${i}` }))
      d.history.push(entry(1, hex(2), { id: 'b1' }), entry(1, 'sch_dead', { id: 'orphan' }))
    })
    const h1 = store.history(hex(1))
    expect(h1).toHaveLength(SCHEDULE_HISTORY_MAX)
    expect(h1[0].id).toBe(`a${SCHEDULE_HISTORY_MAX + 10}`)
    expect(h1[h1.length - 1].id).toBe('a11')
    expect(store.history(hex(2)).map((e) => e.id)).toEqual(['b1'])
    expect(store.history('sch_dead')).toEqual([])
    const onDisk = JSON.parse(fs.readFileSync(store.file, 'utf8'))
    expect(onDisk.history).toHaveLength(SCHEDULE_HISTORY_MAX + 1)
  })

  it('drops the history of a schedule when it is removed', () => {
    const store = new ScheduleStore(dir)
    store.update((d) => {
      d.schedules.push(schedule(1), schedule(2))
      d.history.push(entry(1, hex(1)), entry(2, hex(2)))
    })
    store.update((d) => {
      d.schedules = d.schedules.filter((s) => s.id !== hex(1))
    })
    expect(store.history(hex(1))).toEqual([])
    expect(store.history(hex(2))).toHaveLength(1)
  })

  it('keeps at most SCHEDULES_MAX schedules, the first ones by createdAt', () => {
    const many = Array.from({ length: SCHEDULES_MAX + 5 }, (_, i) => schedule(i + 1))
    rawFile(dir, [...many].reverse())
    const store = new ScheduleStore(dir)
    expect(store.list()).toHaveLength(SCHEDULES_MAX)
    expect(store.get(hex(SCHEDULES_MAX))).toBeDefined()
    expect(store.get(hex(SCHEDULES_MAX + 1))).toBeUndefined()
    store.update((d) => void d.schedules.push(schedule(500, { createdAt: 1 })))
    expect(store.list()).toHaveLength(SCHEDULES_MAX)
    expect(store.get(hex(500))).toBeDefined()
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8')).schedules).toHaveLength(SCHEDULES_MAX)
  })
})
