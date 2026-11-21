import { describe, expect, it } from 'vitest'
import {
  CLOSED_WAITING_DETAIL,
  endedSinceLastVisit,
  NO_RUNS_DETAIL,
  pausedResumeCaption,
  pickUpAction,
  pickUpRows,
  resumeActionLabel,
  resumeActionName,
  resumeCaption,
  resumeRows,
  showsRunCost,
  type ResumeRow,
  type ResumeRun
} from './resumeRows'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000
const LAST_SEEN = NOW - 2 * HOUR

let seq = 0
function run(over: Partial<ResumeRun> & { id: string }): ResumeRun {
  seq += 1
  return { projectId: 'p1', status: 'finished', startedAt: NOW - 10 * HOUR + seq, kind: 'work', sessionId: `s-${over.id}`, ...over }
}

const base = { lastSeen: LAST_SEEN, now: NOW, workingHidden: false, pinned: [] as string[], projectIds: ['p1', 'p2', 'p3'] }
const rows = (summaries: ResumeRun[], over: Partial<typeof base & { max: number }> = {}): ResumeRow<ResumeRun>[] => resumeRows({ summaries, ...base, ...over })
const shape = (rs: ResumeRow<ResumeRun>[]): string[] => rs.map((r) => `${r.kind}:${r.key}`)

describe('resumeRows order and kinds', () => {
  it('orders paused, closed, failed, finished, pinned, recent', () => {
    const summaries = [
      run({ id: 'old', startedAt: NOW - 50 * HOUR, endedAt: NOW - 49 * HOUR }),
      run({ id: 'fin', endedAt: NOW - HOUR }),
      run({ id: 'bad', status: 'error', endedAt: NOW - HOUR, error: 'Boom' }),
      run({ id: 'cut', endedBy: 'app', endedWhile: 'waiting', endedAt: NOW - 3 * HOUR }),
      run({ id: 'zzz', status: 'paused', pausedUntil: NOW + HOUR, autoResume: true }),
      run({ id: 'pinned-run', projectId: 'p2', endedAt: NOW - 30 * HOUR, startedAt: NOW - 31 * HOUR })
    ]
    const out = rows(summaries, { pinned: ['p2'] })
    expect(shape(out)).toEqual(['paused:zzz', 'closed:cut', 'failed:bad', 'finished:fin', 'pinned:pinned-run', 'recent:old'])
  })

  it('shows one row per chain, by its newest member, with every member id', () => {
    const a = run({ id: 'a', sessionId: 'S', startedAt: NOW - 9 * HOUR, endedAt: NOW - 8 * HOUR })
    const b = run({ id: 'b', sessionId: 'S', resumedFrom: 'a', startedAt: NOW - 5 * HOUR, endedAt: NOW - HOUR })
    const out = rows([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('b')
    expect(out[0].kind).toBe('finished')
    expect(out[0].chainIds).toEqual(['a', 'b'])
  })

  it('a chain whose newest member is paused is one paused row, not a finished one', () => {
    const a = run({ id: 'a', sessionId: 'S', startedAt: NOW - 9 * HOUR, endedAt: NOW - 8 * HOUR })
    const b = run({ id: 'b', sessionId: 'S', resumedFrom: 'a', startedAt: NOW - 5 * HOUR, status: 'paused', pauseReason: 'Usage limit reached.\nMore text' })
    const out = rows([a, b])
    expect(shape(out)).toEqual(['paused:b'])
    expect(out[0].detail).toBe('Usage limit reached.')
    expect(out[0].flavor).toBe('paused')
  })

  it('sorts finished and failed rows by when they ended, newest first', () => {
    const out = rows([run({ id: 'x', endedAt: NOW - 5 * HOUR + 4 * HOUR }), run({ id: 'y', endedAt: NOW - HOUR / 2 }), run({ id: 'z', status: 'error', endedAt: NOW - HOUR / 4 })])
    expect(shape(out)).toEqual(['failed:z', 'finished:y', 'finished:x'])
  })

  it('a run that ended before the last visit, or more than 7 days ago, is a plain recent row', () => {
    const out = rows([
      run({ id: 'seen', endedAt: LAST_SEEN - HOUR }),
      run({ id: 'seen-bad', status: 'error', endedAt: LAST_SEEN - HOUR, error: 'x' }),
      run({ id: 'week', endedAt: NOW - 8 * 24 * HOUR, startedAt: NOW - 8 * 24 * HOUR - 1 })
    ])
    expect(out.map((r) => r.kind)).toEqual(['recent', 'recent', 'recent'])
  })

  it('details: failed rows show the first line of the error, closed rows the closing sentence', () => {
    const out = rows([
      run({ id: 'bad', status: 'error', endedAt: NOW - HOUR, error: '\n  Rate limit hit \nstack trace' }),
      run({ id: 'cut', endedWithApp: true, endedWhile: 'waiting', endedAt: NOW - 3 * HOUR })
    ])
    expect(out.find((r) => r.key === 'bad')?.detail).toBe('Rate limit hit')
    expect(out.find((r) => r.key === 'cut')?.detail).toBe(CLOSED_WAITING_DETAIL)
    expect(CLOSED_WAITING_DETAIL).toBe('Was waiting on you when OrgAI closed.')
  })

  it('a run cut by OrgAI while working or idle is not a closed row', () => {
    const out = rows([run({ id: 'w', endedBy: 'app', endedWhile: 'working', endedAt: NOW - HOUR }), run({ id: 'i', endedBy: 'app', endedWhile: 'idle', endedAt: NOW - HOUR })])
    expect(out.every((r) => r.kind === 'recent' || r.kind === 'finished')).toBe(true)
    expect(out.some((r) => r.kind === 'closed')).toBe(false)
  })
})

describe('resumeRows exclusions', () => {
  it('leaves out setup, MCP-assistant and skill-assistant runs, keeps Chat work runs', () => {
    const out = rows([
      run({ id: 'setup', kind: 'setup', endedAt: NOW - HOUR }),
      run({ id: 'mcp', kind: 'mcp-assist', endedAt: NOW - HOUR }),
      run({ id: 'skill', kind: 'skill-assist', endedAt: NOW - HOUR }),
      run({ id: 'chat', projectId: 'quick', kind: 'work', endedAt: NOW - HOUR })
    ], { projectIds: ['p1'] })
    expect(shape(out)).toEqual(['finished:chat'])
  })

  it('leaves out a live chain while Working now is visible', () => {
    const live = run({ id: 'live', status: 'running' })
    const idle = run({ id: 'idle', status: 'idle', startedAt: NOW - HOUR })
    expect(rows([live, idle, run({ id: 'done', endedAt: NOW - HOUR })])).toHaveLength(1)
  })

  it('a chain whose newest member is live is not shown by its older finished member', () => {
    const a = run({ id: 'a', sessionId: 'S', startedAt: NOW - 9 * HOUR, endedAt: NOW - 8 * HOUR })
    const b = run({ id: 'b', sessionId: 'S', resumedFrom: 'a', startedAt: NOW - HOUR, status: 'running' })
    expect(rows([a, b])).toEqual([])
  })

  it('shows a live chain as a recent row when Working now is hidden', () => {
    const out = rows([run({ id: 'live', status: 'running' })], { workingHidden: true })
    expect(shape(out)).toEqual(['recent:live'])
    expect(out[0].flavor).toBe('live')
    expect(pickUpAction(out[0])).toBe('open')
  })

  it('counts a run once when the live store and history both hold it', () => {
    const r = run({ id: 'dup', endedAt: NOW - HOUR })
    expect(rows([r, { ...r }])).toHaveLength(1)
  })
})

describe('resumeRows pinned', () => {
  it('lists pinned projects in pin order with their newest thread', () => {
    const out = rows(
      [
        run({ id: 'p1-old', projectId: 'p1', startedAt: NOW - 90 * HOUR, endedAt: NOW - 89 * HOUR }),
        run({ id: 'p2-run', projectId: 'p2', startedAt: NOW - 80 * HOUR, endedAt: NOW - 79 * HOUR }),
        run({ id: 'p2-newer', projectId: 'p2', startedAt: NOW - 70 * HOUR, endedAt: NOW - 69 * HOUR })
      ],
      { pinned: ['p2', 'p1'] }
    )
    expect(shape(out)).toEqual(['pinned:p2-newer', 'pinned:p1-old', 'recent:p2-run'])
  })

  it('a pinned project without runs reads "No runs yet." and offers New run', () => {
    const out = rows([], { pinned: ['p3'] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ key: 'pin:p3', kind: 'pinned', flavor: 'empty', projectId: 'p3', run: null, detail: 'No runs yet.' })
    expect(NO_RUNS_DETAIL).toBe('No runs yet.')
  })

  it('ignores a pin of a project that does not exist and a repeated pin', () => {
    expect(rows([], { pinned: ['gone', 'p3', 'p3'] }).map((r) => r.key)).toEqual(['pin:p3'])
  })

  it('does not list a pinned project\'s thread twice when it is already a finished row', () => {
    const out = rows([run({ id: 'fin', projectId: 'p2', endedAt: NOW - HOUR })], { pinned: ['p2'] })
    expect(shape(out)).toEqual(['finished:fin'])
  })

  it('skips the pin of a project whose newest thread is live in Working now', () => {
    const out = rows([run({ id: 'live', projectId: 'p2', status: 'running' }), run({ id: 'old', projectId: 'p2', startedAt: NOW - 90 * HOUR, endedAt: NOW - 89 * HOUR })], { pinned: ['p2'] })
    expect(shape(out)).toEqual(['recent:old'])
  })
})

describe('resumeRows cap', () => {
  it('lists at most 12 rows', () => {
    const many = Array.from({ length: 20 }, (_, i) => run({ id: `r${i}`, startedAt: NOW - (30 + i) * HOUR, endedAt: NOW - (29 + i) * HOUR }))
    const out = rows(many)
    expect(out).toHaveLength(12)
    expect(out[0].key).toBe('r0')
    expect(out[11].key).toBe('r11')
    expect(rows(many, { max: 5 })).toHaveLength(5)
  })
})

describe('pickUpAction', () => {
  const mk = (flavor: ResumeRow<ResumeRun>['flavor'], continuable: boolean): Pick<ResumeRow<ResumeRun>, 'flavor' | 'continuable'> => ({ flavor, continuable })

  it('Continues a paused run and a stopped run with a session, and Opens the rest', () => {
    expect(pickUpAction(mk('paused', true))).toBe('resume')
    expect(pickUpAction(mk('paused', false))).toBe('resume')
    expect(pickUpAction(mk('closed', true))).toBe('continue')
    expect(pickUpAction(mk('failed', true))).toBe('continue')
    expect(pickUpAction(mk('done', true))).toBe('continue')
    expect(pickUpAction(mk('done', false))).toBe('open')
    expect(pickUpAction(mk('failed', false))).toBe('open')
  })

  it('marks a finished chain with a provider session continuable and one without not', () => {
    const out = rows([run({ id: 'a', endedAt: NOW - HOUR }), run({ id: 'b', sessionId: undefined, endedAt: NOW - HOUR })])
    expect(out.find((r) => r.key === 'a')?.continuable).toBe(true)
    expect(out.find((r) => r.key === 'b')?.continuable).toBe(false)
  })
})

describe('pickUpRows', () => {
  const DAY = 24 * HOUR
  it('lists paused and recently ended runs as one list, newest first', () => {
    const rs = rows([
      run({ id: 'paused', status: 'paused', startedAt: NOW - 5 * HOUR }),
      run({ id: 'done', endedAt: NOW - HOUR, startedAt: NOW - 2 * HOUR }),
      run({ id: 'failed', status: 'error', endedAt: NOW - 30 * 60_000, startedAt: NOW - 3 * HOUR, error: 'Boom' })
    ])
    const keys = pickUpRows(rs, NOW).map((r) => r.key)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toBe('failed')
  })

  it('leaves out an empty pinned project and a live chain, and an old run that cannot be continued', () => {
    const rs = rows(
      [
        run({ id: 'live', status: 'running' }),
        run({ id: 'old', endedAt: NOW - 20 * DAY, startedAt: NOW - 21 * DAY, sessionId: undefined }),
        run({ id: 'old-cont', endedAt: NOW - 20 * DAY, startedAt: NOW - 21 * DAY }),
        run({ id: 'ok', endedAt: NOW - 3 * DAY, startedAt: NOW - 3 * DAY - HOUR, projectId: 'p2' })
      ],
      { pinned: ['p3'], workingHidden: true }
    )
    const keys = pickUpRows(rs, NOW).map((r) => r.key)
    expect(keys).toEqual(['ok'])
  })

  it('knows which rows ended since the last visit', () => {
    const rs = rows([run({ id: 'new', endedAt: NOW - HOUR }), run({ id: 'before', endedAt: LAST_SEEN - HOUR, startedAt: LAST_SEEN - 2 * HOUR })])
    expect(endedSinceLastVisit(rs.find((r) => r.key === 'new')!)).toBe(true)
    expect(endedSinceLastVisit(rs.find((r) => r.key === 'before')!)).toBe(false)
  })
})

describe('showsRunCost', () => {
  it('shows a known figure or a lower bound above zero, never unknown or zero', () => {
    expect(showsRunCost({ costUsd: 0.42, costSource: 'provider' })).toBe(true)
    expect(showsRunCost({ costUsd: 0.42, costSource: 'computed', costPartial: true })).toBe(true)
    expect(showsRunCost({ costUsd: 0, costSource: 'provider' })).toBe(false)
    expect(showsRunCost({ costUsd: 0, costSource: 'none' })).toBe(false)
    expect(showsRunCost({ costUsd: null, costSource: 'unknown' })).toBe(false)
    expect(showsRunCost({ costUsd: 3, costSource: 'unknown' })).toBe(false)
  })
})

describe('strings', () => {
  it('names the actions as the spec says', () => {
    expect(resumeActionName('continue', { runName: 'Fix rounding' })).toBe('Continue Fix rounding')
    expect(resumeActionName('resume', { runName: 'Import job' })).toBe('Continue Import job now')
    expect(resumeActionName('open', { runName: 'Chat' })).toBe('Open Chat')
  })

  it('labels the actions: Continue or Open, and each name carries the run title', () => {
    expect((['resume', 'continue', 'open'] as const).map((a) => resumeActionLabel(a))).toEqual(['Continue', 'Continue', 'Open'])
  })

  it('line 2 is project and age, with the client first when there is one', () => {
    const r = { flavor: 'done' as const, run: null }
    expect(resumeCaption(r, { project: 'Billing API', age: '3 min ago' })).toBe('Billing API · 3 min ago')
    expect(resumeCaption(r, { project: 'Billing API', client: 'Acme', age: '3 min ago' })).toBe('Acme · Billing API · 3 min ago')
    expect(resumeCaption(r, { project: 'Billing API', client: '', age: '2 h ago' })).toBe('Billing API · 2 h ago')
  })

  it('a paused row says when it resumes instead of its age', () => {
    const paused = rows([run({ id: 'p', status: 'paused' })])[0]
    expect(resumeCaption(paused, { project: 'Docs', age: '1 h ago' })).toBe('Docs · waits for you to continue')
  })

  describe('pausedResumeCaption (walk 4 M1, fixed local clock)', () => {
    const clean = (s: string): string => s.replace(/\s/g, ' ')
    const at = (d: number, h: number, m: number): number => new Date(2026, 10, d, h, m).getTime()
    const now = at(19, 22, 40)
    const p = (until: number): { autoResume: boolean; pausedUntil: number } => ({ autoResume: true, pausedUntil: until })
    it('today is the time only', () => {
      expect(clean(pausedResumeCaption(p(at(19, 23, 55)), now, 'en-US'))).toBe('resumes at 11:55 PM if OrgAI stays open')
    })
    it('the next local day says tomorrow, even less than 24 hours away', () => {
      expect(clean(pausedResumeCaption(p(at(20, 22, 39)), now, 'en-US'))).toBe('resumes tomorrow at 10:39 PM if OrgAI stays open')
      expect(clean(pausedResumeCaption(p(at(20, 0, 5)), now, 'en-US'))).toBe('resumes tomorrow at 12:05 AM if OrgAI stays open')
    })
    it('later in the week names the weekday, later still the date', () => {
      expect(clean(pausedResumeCaption(p(at(22, 9, 0)), now, 'en-US'))).toBe('resumes Sunday at 9:00 AM if OrgAI stays open')
      expect(clean(pausedResumeCaption(p(at(30, 9, 0)), now, 'en-US'))).toBe('resumes Nov 30 at 9:00 AM if OrgAI stays open')
    })
    it('without an automatic resume it waits for the person', () => {
      expect(pausedResumeCaption({ autoResume: false }, now, 'en-US')).toBe('waits for you to continue')
    })
    it('the row caption uses it', () => {
      const paused = rows([run({ id: 'p', status: 'paused' })])[0]
      const row = { flavor: paused.flavor, run: { ...paused.run!, ...p(at(20, 22, 39)) } }
      expect(clean(resumeCaption(row, { project: 'Docs', age: '1 h ago', now, locale: 'en-US' }))).toBe('Docs · resumes tomorrow at 10:39 PM if OrgAI stays open')
    })
  })
})
