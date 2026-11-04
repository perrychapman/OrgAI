import { describe, expect, it } from 'vitest'
import {
  LAST_SEEN_KEY,
  buildAttentionCtx,
  deleteProjectBody,
  elapsedLabel,
  endedKind,
  heroFigure,
  planStepLabel,
  projectAttentionOrder,
  readLastSeen,
  sinceLastSeen,
  weekCost,
  writeLastSeen,
  type EndedRunLike
} from './dashboard'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = 10 * DAY

describe('projectAttentionOrder', () => {
  const ps = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
    { id: 'd', name: 'Delta' }
  ]
  it('orders by decisions, live runs, newest start, then name', () => {
    const out = projectAttentionOrder(ps, {
      a: { decisions: 0, liveRuns: 1, newestStart: 5 },
      b: { decisions: 2, liveRuns: 0, newestStart: 1 },
      c: { decisions: 0, liveRuns: 0, newestStart: 9 },
      d: { decisions: 0, liveRuns: 0 }
    })
    expect(out.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('falls back to name when nothing differs and does not mutate', () => {
    const input = [ps[2], ps[0], ps[1]]
    const out = projectAttentionOrder(input, {})
    expect(out.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(input[0].id).toBe('c')
  })
  it('puts a project with no runs after one with an old run', () => {
    const out = projectAttentionOrder(ps.slice(0, 2), { b: { decisions: 0, liveRuns: 0, newestStart: 1 } })
    expect(out.map((p) => p.id)).toEqual(['b', 'a'])
  })
})

describe('buildAttentionCtx', () => {
  it('counts live runs, decisions and the newest start from runs and history', () => {
    const ctx = buildAttentionCtx(
      [
        {
          summary: { id: 'r1', projectId: 'p1', status: 'running', startedAt: 50 },
          agents: { a1: { name: 'X' } },
          questions: [{ id: 'q1', agentId: 'a1', question: 'Which?' }]
        },
        { summary: { id: 'r2', projectId: 'p1', status: 'finished', startedAt: 40 }, agents: {} }
      ],
      { p1: [{ id: 'r2', startedAt: 40 }], p2: [{ id: 'r3', startedAt: 7 }, { id: 'r4', startedAt: 9 }], p3: [] }
    )
    expect(ctx.p1).toEqual({ decisions: 1, liveRuns: 1, newestStart: 50 })
    expect(ctx.p2).toEqual({ decisions: 0, liveRuns: 0, newestStart: 9 })
    expect(ctx.p3).toEqual({ decisions: 0, liveRuns: 0 })
  })
})

describe('last seen storage', () => {
  const store = (initial?: string): { map: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } => {
    const map = new Map<string, string>()
    if (initial !== undefined) map.set(LAST_SEEN_KEY, initial)
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  }
  it('round trips', () => {
    const s = store()
    writeLastSeen(s, 1234.9)
    expect(s.map.get(LAST_SEEN_KEY)).toBe('1234')
    expect(readLastSeen(s)).toBe(1234)
  })
  it('returns null for absent, junk and no storage', () => {
    expect(readLastSeen(store())).toBeNull()
    expect(readLastSeen(store('abc'))).toBeNull()
    expect(readLastSeen(store(''))).toBeNull()
    expect(readLastSeen(store('-5'))).toBeNull()
    expect(readLastSeen(store('Infinity'))).toBeNull()
    expect(readLastSeen(null)).toBeNull()
    expect(readLastSeen(undefined)).toBeNull()
  })
  it('tolerates throwing storage', () => {
    const bad = {
      getItem: (): string | null => {
        throw new Error('no')
      },
      setItem: (): void => {
        throw new Error('no')
      }
    }
    expect(readLastSeen(bad)).toBeNull()
    expect(() => writeLastSeen(bad, 5)).not.toThrow()
  })
  it('ignores a bad timestamp on write', () => {
    const s = store()
    writeLastSeen(s, NaN)
    writeLastSeen(s, 0)
    expect(s.map.size).toBe(0)
  })
})

describe('endedKind', () => {
  const r = (extra: Partial<EndedRunLike>): EndedRunLike => ({ id: 'r', status: 'finished', startedAt: 1, ...extra })
  it('classifies', () => {
    expect(endedKind(r({}))).toBe('finished')
    expect(endedKind(r({ status: 'error' }))).toBe('failed')
    expect(endedKind(r({ endedBy: 'user' }))).toBe('stopped')
    expect(endedKind(r({ endedBy: 'app', endedWhile: 'working' }))).toBe('closed')
    expect(endedKind(r({ endedBy: 'app', endedWhile: 'waiting' }))).toBe('closed-waiting')
    expect(endedKind(r({ endedWithApp: true }))).toBe('closed')
    expect(endedKind(r({ status: 'paused' }))).toBe('paused')
  })
  it('is null for live runs', () => {
    for (const status of ['starting', 'running', 'idle', 'stopping'] as const) expect(endedKind(r({ status }))).toBeNull()
  })
})

describe('sinceLastSeen', () => {
  const run = (id: string, startedAt: number, extra: Partial<EndedRunLike> = {}): EndedRunLike => ({ id, status: 'finished', startedAt, ...extra })
  it('keeps runs that ended after lastSeen, newest first, and skips live ones', () => {
    const out = sinceLastSeen(
      [run('old', 1, { endedAt: 100 }), run('a', 1, { endedAt: 300 }), run('b', 1, { endedAt: 200, status: 'error' }), run('live', 1, { status: 'running' })],
      150,
      NOW
    )
    expect(out.items.map((i) => i.run.id)).toEqual(['a', 'b'])
    expect(out.items[1].kind).toBe('failed')
    expect(out.more).toBe(0)
  })
  it('excludes a run that ended exactly at lastSeen', () => {
    expect(sinceLastSeen([run('a', 1, { endedAt: 150 })], 150, NOW).items).toHaveLength(0)
  })
  it('uses the start when there is no end', () => {
    const out = sinceLastSeen([run('p', 500, { status: 'paused' })], 100, NOW)
    expect(out.items[0]).toMatchObject({ kind: 'paused', endedAt: 500 })
  })
  it('on a first visit returns the last 24 hours', () => {
    const out = sinceLastSeen([run('in', 1, { endedAt: NOW - 23 * HOUR }), run('out', 1, { endedAt: NOW - 25 * HOUR })], null, NOW)
    expect(out.items.map((i) => i.run.id)).toEqual(['in'])
  })
  it('caps and counts the rest', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((n) => run(`r${n}`, n, { endedAt: 1000 + n }))
    const out = sinceLastSeen(rows, 0.5, NOW, { cap: 3 })
    expect(out.items.map((i) => i.run.id)).toEqual(['r7', 'r6', 'r5'])
    expect(out.more).toBe(4)
  })
  it('counts a duplicated run once', () => {
    const a = run('a', 1, { endedAt: 300 })
    expect(sinceLastSeen([a, { ...a }], 0.5, NOW).items).toHaveLength(1)
  })
})

describe('weekCost', () => {
  const run = (id: string, startedAt: number, usage?: { costUsd: number | null; costPartial?: true }): { id: string; startedAt: number; usage?: { costUsd: number | null; costPartial?: true } } => ({ id, startedAt, usage })
  it('sums runs in the rolling week', () => {
    const out = weekCost([run('a', NOW - DAY, { costUsd: 1.5 }), run('b', NOW - 6 * DAY, { costUsd: 0.5 }), run('old', NOW - 8 * DAY, { costUsd: 99 })], NOW)
    expect(out).toEqual({ costUsd: 2, partial: false, runs: 2 })
  })
  it('marks partial when one cost is unknown or partial', () => {
    expect(weekCost([run('a', NOW, { costUsd: 1 }), run('b', NOW, { costUsd: null })], NOW)).toEqual({ costUsd: 1, partial: true, runs: 2 })
    expect(weekCost([run('a', NOW, { costUsd: 1, costPartial: true })], NOW)).toEqual({ costUsd: 1, partial: true, runs: 1 })
    expect(weekCost([run('a', NOW, { costUsd: 1 }), run('b', NOW)], NOW).partial).toBe(true)
  })
  it('is null, not 0, when everything is unknown', () => {
    expect(weekCost([run('a', NOW, { costUsd: null }), run('b', NOW)], NOW)).toEqual({ costUsd: null, partial: true, runs: 2 })
  })
  it('keeps a known zero', () => {
    expect(weekCost([run('a', NOW, { costUsd: 0 })], NOW)).toEqual({ costUsd: 0, partial: false, runs: 1 })
  })
  it('dedupes by run id and handles no runs', () => {
    expect(weekCost([run('a', NOW, { costUsd: 2 }), run('a', NOW, { costUsd: 2 })], NOW)).toEqual({ costUsd: 2, partial: false, runs: 1 })
    expect(weekCost([], NOW)).toEqual({ costUsd: 0, partial: false, runs: 0 })
  })
})

describe('elapsedLabel', () => {
  it('formats', () => {
    expect(elapsedLabel(NOW, NOW)).toBe('just started')
    expect(elapsedLabel(NOW - 59_000, NOW)).toBe('just started')
    expect(elapsedLabel(NOW - 4 * MIN, NOW)).toBe('4 min')
    expect(elapsedLabel(NOW - (HOUR + 12 * MIN), NOW)).toBe('1 h 12 min')
    expect(elapsedLabel(NOW - 2 * HOUR, NOW)).toBe('2 h')
    expect(elapsedLabel(NOW - 2 * DAY - HOUR, NOW)).toBe('2 d')
  })
  it('treats a future start as just started', () => {
    expect(elapsedLabel(NOW + 5 * MIN, NOW)).toBe('just started')
  })
})

describe('planStepLabel', () => {
  const steps = (...s: string[]): { steps: { status: string }[] } => ({ steps: s.map((status) => ({ status })) })
  it('names the first step not done', () => {
    expect(planStepLabel(steps('done', 'done', 'in_progress', 'pending', 'pending', 'pending', 'pending'))).toBe('Step 3 of 7')
    expect(planStepLabel(steps('done', 'skipped', 'blocked'))).toBe('Step 3 of 3')
  })
  it('says when all are done', () => {
    expect(planStepLabel(steps('done', 'skipped'))).toBe('All 2 steps done')
    expect(planStepLabel(steps('done'))).toBe('All 1 step done')
  })
  it('is null without a plan or steps', () => {
    expect(planStepLabel(null)).toBeNull()
    expect(planStepLabel(undefined)).toBeNull()
    expect(planStepLabel({ steps: [] })).toBeNull()
  })
})

describe('heroFigure', () => {
  it('prefers decisions, then running, then quiet', () => {
    expect(heroFigure({ decisions: 3, running: 2 }).figure).toBe('3 need you')
    expect(heroFigure({ decisions: 1, running: 0 })).toEqual({ figure: '1 needs you', caption: 'decision waiting' })
    expect(heroFigure({ decisions: 0, running: 2 })).toEqual({ figure: '2 running', caption: 'runs in progress' })
    expect(heroFigure({ decisions: 0, running: 1 }).caption).toBe('run in progress')
    expect(heroFigure({ decisions: 0, running: 0 }).figure).toBe('All quiet')
  })
})

describe('deleteProjectBody', () => {
  it('covers the cases', () => {
    expect(deleteProjectBody({ openRuns: 1, historyRuns: 3 })).toBe('Ends 1 open run and deletes the history, transcripts and costs of 3 runs. Files in its folder are untouched.')
    expect(deleteProjectBody({ openRuns: 2, historyRuns: 1 })).toBe('Ends 2 open runs and deletes the history, transcripts and costs of 1 run. Files in its folder are untouched.')
    expect(deleteProjectBody({ openRuns: 0, historyRuns: 4 })).toBe('Deletes the history, transcripts and costs of 4 runs. Files in its folder are untouched.')
    expect(deleteProjectBody({ openRuns: 1, historyRuns: 0 })).toBe('Ends 1 open run and deletes the project from OrgAI. Files in its folder are untouched.')
    expect(deleteProjectBody({ openRuns: 0, historyRuns: 0 })).toBe('Deletes the project from OrgAI. It has no runs. Files in its folder are untouched.')
  })
})
