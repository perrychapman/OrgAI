import { describe, expect, it } from 'vitest'
import {
  chainOutputs,
  CLOSED_WAITING_DETAIL,
  NO_RUNS_DETAIL,
  outputProjects,
  resumeAction,
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
    expect(resumeAction(out[0], 0)).toBe('open')
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
    expect(resumeAction(out[0], 0)).toBe('new-run')
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

describe('resumeAction', () => {
  const mk = (flavor: ResumeRow<ResumeRun>['flavor'], continuable: boolean): Pick<ResumeRow<ResumeRun>, 'flavor' | 'continuable'> => ({ flavor, continuable })

  it('decides the one action from the status and the outputs', () => {
    expect(resumeAction(mk('paused', true), 0)).toBe('resume')
    expect(resumeAction(mk('closed', true), 3)).toBe('continue')
    expect(resumeAction(mk('closed', false), 0)).toBeNull()
    expect(resumeAction(mk('failed', true), 2)).toBe('continue')
    expect(resumeAction(mk('failed', false), 0)).toBeNull()
    expect(resumeAction(mk('done', true), 0)).toBe('continue')
    expect(resumeAction(mk('done', true), 1)).toBe('output')
    expect(resumeAction(mk('done', false), 2)).toBe('output')
    expect(resumeAction(mk('done', false), 0)).toBeNull()
    expect(resumeAction(mk('live', false), 0)).toBe('open')
    expect(resumeAction(mk('empty', false), 0)).toBe('new-run')
  })

  it('marks a finished chain with a provider session continuable and one without not', () => {
    const out = rows([run({ id: 'a', endedAt: NOW - HOUR }), run({ id: 'b', sessionId: undefined, endedAt: NOW - HOUR })])
    expect(out.find((r) => r.key === 'a')?.continuable).toBe(true)
    expect(out.find((r) => r.key === 'b')?.continuable).toBe(false)
  })
})

describe('outputs of a chain', () => {
  const list = [
    { id: 'o1', runId: 'a' },
    { id: 'o2', runId: 'b', missing: true as const },
    { id: 'o3', runId: 'b' },
    { id: 'o4', runId: 'other' }
  ]
  it('counts outputs of any chain member that are not missing', () => {
    expect(chainOutputs(list, ['a', 'b']).map((o) => o.id)).toEqual(['o1', 'o3'])
    expect(chainOutputs(undefined, ['a'])).toEqual([])
    expect(chainOutputs(list, [])).toEqual([])
  })

  it('loads outputs for at most six projects, only for rows that may show Open output', () => {
    const rs = Array.from({ length: 9 }, (_, i) => ({ flavor: 'done' as const, projectId: `p${i % 8}` }))
    expect(outputProjects(rs, () => true)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5'])
    expect(outputProjects([{ flavor: 'paused', projectId: 'a' }, { flavor: 'done', projectId: 'quick' }, { flavor: 'done', projectId: 'b' }], (id) => id !== 'quick')).toEqual(['b'])
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
    expect(resumeActionName('continue', { runName: 'Fix rounding', project: 'Billing' })).toBe('Continue Fix rounding')
    expect(resumeActionName('output', { runName: 'Fix rounding', project: 'Billing', outputs: 1 })).toBe('Open the output of Fix rounding')
    expect(resumeActionName('output', { runName: 'Fix rounding', project: 'Billing', outputs: 3 })).toBe('Open the outputs of Fix rounding')
    expect(resumeActionName('resume', { runName: 'Import job', project: 'Docs' })).toBe('Resume Import job now')
    expect(resumeActionName('new-run', { runName: '', project: 'Docs' })).toBe('New run in Docs')
    expect(resumeActionName('open', { runName: 'Chat', project: 'Chat' })).toBe('Open Chat')
  })

  it('labels the actions', () => {
    expect(['resume', 'continue', 'output', 'new-run', 'open'].map((a) => resumeActionLabel(a as 'resume'))).toEqual(['Resume now', 'Continue', 'Open output', 'New run', 'Open'])
    expect(resumeActionLabel('output', 2)).toBe('Open outputs')
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
})
