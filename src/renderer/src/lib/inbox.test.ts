import { describe, expect, it } from 'vitest'
import { waitingItems } from './needsYou'
import {
  ENTER_DWELL_MS,
  FRESH_GUARD,
  INBOX_READ_CAP,
  NO_FILTERS,
  afterAnswerText,
  applyFilters,
  askTitle,
  buildFinished,
  buildWaiting,
  filterCounts,
  guardArrive,
  guardPress,
  guardRelease,
  guardReset,
  guardSwallows,
  nextSelection,
  openTeamCount,
  projectOptions,
  readReadIds,
  readSeenAt,
  relativeAgo,
  rowName,
  stepSelection,
  summaryText,
  writeReadIds,
  writeSeenAt,
  type InboxFinishedIn,
  type InboxRunIn
} from './inbox'

const run = (id: string, projectId: string, startedAt: number, extra: Partial<InboxRunIn> = {}): InboxRunIn => ({
  summary: { id, projectId, startedAt, status: 'idle', kind: 'work' },
  agents: { a1: { name: 'Implementer 2' }, a2: { name: 'Lead analyst' } },
  ...extra
})

const names = (r: InboxRunIn): string => (r.summary.projectId === 'p1' ? 'Notes API' : 'Acme')

describe('buildWaiting', () => {
  const runs = [
    run('r2', 'p2', 2000, { questions: [{ id: 'q1', agentId: 'a2', question: 'Which office should be the pilot?' }] }),
    run('r1', 'p1', 1000, {
      permissions: [{ id: 'perm1', agentId: 'a1', toolName: 'Bash', input: { command: 'npm test' } }],
      mergeReviews: [{ id: 'm1', agentName: 'Implementer 1' }]
    })
  ]
  const team = [{ key: 'team:p1', projectId: 'p1', projectName: 'Notes API', state: 'pending' as const, label: 'Team files: 2 changes need your approval' }]
  const list = buildWaiting({ runs, teamItems: team, projectName: names })

  it('is oldest first by run start, then card order, team items last', () => {
    expect(list.map((i) => i.id)).toEqual(['w:r1/m1', 'w:r1/perm1', 'w:r2/q1', 't:team:p1'])
  })

  it('has the same length as the sidebar badge: decisions of every waiting run plus team items', () => {
    const badge = runs.flatMap((r) => waitingItems(r)).length + team.length
    expect(list).toHaveLength(badge)
  })

  it('names the kind, the agent and the project', () => {
    const perm = list.find((i) => i.kind === 'permission')
    expect(perm).toMatchObject({ kindLabel: 'Permission', who: 'Implementer 2', projectName: 'Notes API', filter: 'permission', group: 'waiting' })
    expect(list.find((i) => i.kind === 'question')).toMatchObject({ who: 'Lead analyst', filter: 'question', projectName: 'Acme' })
    expect(list.find((i) => i.kind === 'merge')).toMatchObject({ who: 'Implementer 1', filter: 'review' })
    expect(list.find((i) => i.kind === 'team')).toMatchObject({ filter: 'proposal', projectId: 'p1', who: 'Team files' })
  })

  it('drops the kind prefix the pill already says', () => {
    expect(askTitle('permission', 'Allow: Run npm test')).toBe('Run npm test')
    expect(askTitle('question', 'Question: Which?')).toBe('Which?')
    expect(askTitle('merge', "Merge: review A's changes")).toBe("Merge: review A's changes")
  })

  it('is empty when nothing waits', () => {
    expect(buildWaiting({ runs: [], teamItems: [], projectName: names })).toEqual([])
    // A run with no open card is not waiting.
    expect(buildWaiting({ runs: [run('r9', 'p1', 1)], teamItems: [], projectName: names })).toEqual([])
  })

  it('calls the setup run its Architect', () => {
    const setup = run('s1', 'p1', 5, { questions: [{ id: 'sq', agentId: 'a1', question: 'Tabs or spaces?' }] })
    setup.summary.kind = 'setup'
    expect(buildWaiting({ runs: [setup], teamItems: [], projectName: names })[0].who).toBe('The Architect')
  })
})

describe('buildFinished', () => {
  const NOW = 10_000_000
  const done = (id: string, endedAt: number, extra: Partial<InboxFinishedIn> = {}): InboxFinishedIn => ({
    id,
    projectId: 'p1',
    status: 'finished',
    startedAt: endedAt - 1000,
    endedAt,
    kind: 'work',
    ...extra
  })
  const base = { now: NOW, projectName: () => 'Notes API', runName: (s: InboxFinishedIn) => `run ${s.id}`, read: new Set<string>() }

  it('lists runs that ended after the last-seen time, newest first', () => {
    const out = buildFinished({ ...base, seenAt: 5000, summaries: [done('old', 4000), done('a', 7000), done('b', 9000)] })
    expect(out.map((i) => i.id)).toEqual(['f:b', 'f:a'])
    expect(out[0]).toMatchObject({ group: 'finished', filter: 'finished', kindLabel: 'Finished', projectName: 'Notes API', runId: 'b', at: 9000 })
  })

  it('marks a failed run and names why on one line', () => {
    const out = buildFinished({ ...base, seenAt: 0, summaries: [done('x', 9000, { status: 'error', error: 'Rate limit hit\nsecond line' })] })
    expect(out[0]).toMatchObject({ kind: 'failed', kindLabel: 'Failed', who: 'Rate limit hit' })
  })

  it('skips runs the user stopped, paused runs, live runs and setup runs', () => {
    const out = buildFinished({
      ...base,
      seenAt: 0,
      summaries: [done('u', 9000, { endedBy: 'user' }), done('p', 9000, { status: 'paused' }), done('l', 9000, { status: 'running' }), done('s', 9000, { kind: 'setup' })]
    })
    expect(out).toEqual([])
  })

  it('keeps an unread run until it is read, then drops it', () => {
    const summaries = [done('a', 7000), done('b', 9000)]
    expect(buildFinished({ ...base, seenAt: 5000, summaries }).map((i) => i.runId)).toEqual(['b', 'a'])
    expect(buildFinished({ ...base, seenAt: 5000, summaries, read: new Set(['b']) }).map((i) => i.runId)).toEqual(['a'])
    // Marking all read moves the seen time past both.
    expect(buildFinished({ ...base, seenAt: 9500, summaries })).toEqual([])
  })

  it('names a scheduled run by its schedule', () => {
    expect(buildFinished({ ...base, seenAt: 0, summaries: [done('c', 9000, { scheduleName: 'Daily check' })] })[0].who).toBe('Scheduled: Daily check')
  })

  it('honours the cap', () => {
    const many = Array.from({ length: 5 }, (_, i) => done(`r${i}`, 6000 + i))
    expect(buildFinished({ ...base, seenAt: 0, summaries: many, cap: 2 })).toHaveLength(2)
  })
})

describe('filters', () => {
  const items = buildWaiting({
    runs: [
      run('r1', 'p1', 1, { permissions: [{ id: 'x', agentId: 'a1', toolName: 'Bash', input: { command: 'ls' } }] }),
      run('r2', 'p2', 2, { questions: [{ id: 'y', agentId: 'a2', question: 'Q?' }], permissions: [{ id: 'z', agentId: 'a1', toolName: 'Bash', input: { command: 'pwd' } }] })
    ],
    teamItems: [],
    projectName: names
  })

  it('filters by kind and by project together', () => {
    expect(applyFilters(items, NO_FILTERS)).toHaveLength(3)
    expect(applyFilters(items, { filter: 'permission', project: 'all' })).toHaveLength(2)
    expect(applyFilters(items, { filter: 'permission', project: 'p2' }).map((i) => i.key)).toEqual(['z'])
    expect(applyFilters(items, { filter: 'review', project: 'all' })).toEqual([])
  })

  it('counts only kinds that are present, under the project filter', () => {
    expect(filterCounts(items, 'all')).toEqual({ all: 3, kinds: [{ filter: 'permission', count: 2 }, { filter: 'question', count: 1 }] })
    expect(filterCounts(items, 'p1')).toEqual({ all: 1, kinds: [{ filter: 'permission', count: 1 }] })
  })

  it('lists projects that have items, by name', () => {
    expect(projectOptions(items)).toEqual([
      { id: 'p2', name: 'Acme', count: 2 },
      { id: 'p1', name: 'Notes API', count: 1 }
    ])
  })
})

describe('selection', () => {
  const ids = ['a', 'b', 'c', 'd']
  it('keeps the selection while it is there', () => {
    expect(nextSelection(ids, 'b', ['a', 'b', 'd'])).toBe('b')
  })
  it('moves to the next item when the selected one is answered', () => {
    expect(nextSelection(ids, 'b', ['a', 'c', 'd'])).toBe('c')
    expect(nextSelection(ids, 'a', ['b', 'c', 'd'])).toBe('b')
  })
  it('moves to the previous item at the end of the list', () => {
    expect(nextSelection(ids, 'd', ['a', 'b', 'c'])).toBe('c')
  })
  it('skips a following item that left too', () => {
    expect(nextSelection(ids, 'b', ['a', 'd'])).toBe('d')
  })
  it('selects the first when nothing was selected, and null when the list is empty', () => {
    expect(nextSelection([], null, ['x', 'y'])).toBe('x')
    expect(nextSelection(ids, 'b', [])).toBeNull()
  })
  it('steps one at a time and stops at the ends', () => {
    expect(stepSelection(ids, 'a', 1)).toBe('b')
    expect(stepSelection(ids, 'd', 1)).toBe('d')
    expect(stepSelection(ids, 'a', -1)).toBe('a')
    expect(stepSelection(ids, null, 1)).toBe('a')
    expect(stepSelection(ids, null, -1)).toBe('d')
    expect(stepSelection(ids, 'b', 'last')).toBe('d')
    expect(stepSelection(ids, 'c', 'first')).toBe('a')
    expect(stepSelection([], null, 1)).toBeNull()
  })
})

describe('activation guard', () => {
  it('never lets a repeating key press anything, even with nothing blocked', () => {
    expect(guardSwallows(FRESH_GUARD, 'Enter', true, 1000)).toBe(true)
    expect(guardSwallows(FRESH_GUARD, ' ', true, 1000)).toBe(true)
    expect(guardSwallows(FRESH_GUARD, 'Enter', false, 1000)).toBe(false)
    expect(guardSwallows(FRESH_GUARD, 'ArrowDown', true, 1000)).toBe(false)
  })
  it('tracks only a non-repeating press of a guarded key as held', () => {
    expect(guardPress(FRESH_GUARD, 'Enter', true)).toBe(FRESH_GUARD)
    expect(guardPress(FRESH_GUARD, 'j', false)).toBe(FRESH_GUARD)
    expect(guardPress(FRESH_GUARD, 'Enter', false).held).toEqual(['Enter'])
  })
  it('blocks the key that was down when focus arrived until its keyup', () => {
    const down = guardPress(FRESH_GUARD, 'Enter', false)
    const arrived = guardArrive(down, 1000)
    expect(guardSwallows(arrived, 'Enter', false, 1001)).toBe(true)
    expect(guardSwallows(arrived, ' ', false, 1001)).toBe(false)
    const up = guardRelease(arrived, 'Enter')
    expect(guardSwallows(up, 'Enter', false, 1002)).toBe(false)
  })
  it('lets a key through that went down after focus arrived (a deliberate press)', () => {
    const arrived = guardArrive(FRESH_GUARD, 1000)
    const later = guardPress(arrived, 'Enter', false)
    expect(guardSwallows(later, 'Enter', false, 1100)).toBe(false)
    expect(guardSwallows(later, 'Enter', true, 1100)).toBe(true)
  })
  it('holds a fresh press for the dwell after Enter moved focus, then lets it through', () => {
    const arrived = guardArrive(guardRelease(guardPress(FRESH_GUARD, 'Enter', false), 'Enter'), 5000, ENTER_DWELL_MS)
    expect(guardSwallows(arrived, 'Enter', false, 5000 + ENTER_DWELL_MS - 1)).toBe(true)
    expect(guardSwallows(arrived, 'Enter', false, 5000 + ENTER_DWELL_MS)).toBe(false)
  })
  it('forgets everything when the window loses focus (a keyup may never come)', () => {
    const arrived = guardArrive(guardPress(FRESH_GUARD, 'Enter', false), 1000)
    expect(guardSwallows(guardReset(), 'Enter', false, 1001)).toBe(false)
    expect(guardSwallows(arrived, 'Enter', false, 1001)).toBe(true)
  })
  it('a held then doubled Enter on a row answers nothing, a release and a fresh press does', () => {
    let g = guardPress(FRESH_GUARD, 'Enter', false)
    g = guardArrive(g, 1000, ENTER_DWELL_MS) // focus moved to the action by this Enter
    expect(guardSwallows(g, 'Enter', true, 1050)).toBe(true) // auto-repeat
    expect(guardSwallows(g, 'Enter', false, 1100)).toBe(true) // a second keydown with no keyup
    g = guardRelease(g, 'Enter')
    expect(guardSwallows(g, 'Enter', false, 1200)).toBe(true) // rapid second tap, inside the dwell
    g = guardPress(g, 'Enter', false)
    expect(guardSwallows(g, 'Enter', false, 1000 + ENTER_DWELL_MS + 1)).toBe(false) // deliberate press
  })
})

describe('words', () => {
  it('writes the summary', () => {
    expect(summaryText(4, 3)).toBe('4 waiting on you · 3 finished')
    expect(summaryText(0, 0)).toBe('0 waiting on you · 0 finished')
  })
  it('writes relative times', () => {
    const now = 1_000_000_000
    expect(relativeAgo(now - 5_000, now)).toBe('just now')
    expect(relativeAgo(now - 2 * 60_000, now)).toBe('2 min')
    expect(relativeAgo(now - 3 * 3_600_000, now)).toBe('3 h')
    expect(relativeAgo(now - 2 * 86_400_000, now)).toBe('2 d')
    expect(relativeAgo(Number.MAX_SAFE_INTEGER, now)).toBe('')
    expect(relativeAgo(now + 5_000, now)).toBe('just now')
  })
  it('announces the next item after an answer, or that nothing is left', () => {
    const next = buildWaiting({ runs: [run('r1', 'p1', 1, { questions: [{ id: 'q', agentId: 'a2', question: 'Pick one' }] })], teamItems: [], projectName: names })[0]
    expect(afterAnswerText(next, 0, 3, 3)).toBe('Answered. Next: Pick one, Notes API. 1 of 3.')
    expect(afterAnswerText(null, 0, 0, 0)).toBe('Answered. Nothing is waiting on you.')
    expect(afterAnswerText(null, 0, 0, 2, 'Cleared')).toBe('Cleared.')
  })
  it('names a row with its kind, ask, who, project and age', () => {
    const item = buildWaiting({ runs: [run('r1', 'p1', 1, { permissions: [{ id: 'p', agentId: 'a1', toolName: 'Bash', input: { command: 'npm test' } }] })], teamItems: [], projectName: names })[0]
    expect(rowName(item, '2 min')).toBe(`Permission: ${item.title}, Implementer 2, Notes API, run started 2 min ago`)
    expect(rowName(item, 'just now')).toContain('run started just now')
  })
  it('times a decision by when it was raised and says "waiting"', () => {
    const item = buildWaiting({ runs: [run('r1', 'p1', 1, { permissions: [{ id: 'p', agentId: 'a1', toolName: 'Bash', requestedAt: 5000 }] })], teamItems: [], projectName: names })[0]
    expect(item).toMatchObject({ at: 5000, atSource: 'decision' })
    expect(rowName(item, '2 min')).toBe(`Permission: ${item.title}, Implementer 2, Notes API, waiting 2 min`)
    expect(rowName(item, 'just now')).toContain('waiting just now')
  })
  it('sorts by decision time across runs, falling back to the run start, team items last', () => {
    const list = buildWaiting({
      runs: [
        // An old run whose question was only asked late.
        run('old', 'p1', 100, { questions: [{ id: 'q', agentId: 'a2', question: 'Late?', createdAt: 9000 }] }),
        // A newer run whose permission has waited longer.
        run('new', 'p2', 5000, { permissions: [{ id: 'p', agentId: 'a1', toolName: 'Bash', requestedAt: 6000 }] }),
        // No decision time: the run start (7000) is used.
        run('bare', 'p2', 7000, { mcpInstalls: [{ id: 'i', agentId: 'a1' }] })
      ],
      teamItems: [{ key: 'team:p1', projectId: 'p1', projectName: 'Notes API', state: 'pending' as const, label: 'Team files' }],
      projectName: names
    })
    expect(list.map((i) => i.id)).toEqual(['w:new/p', 'w:bare/i', 'w:old/q', 't:team:p1'])
    expect(list.map((i) => i.atSource)).toEqual(['decision', 'run', 'decision', 'none'])
    expect(rowName(list[1], '3 min')).toContain('run started 3 min ago')
  })
})

describe('what the user has seen', () => {
  const mem = (): Pick<Storage, 'getItem' | 'setItem'> & { data: Record<string, string> } => {
    const data: Record<string, string> = {}
    return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) }
  }
  it('round-trips the seen time and ignores junk', () => {
    const s = mem()
    expect(readSeenAt(s)).toBeNull()
    writeSeenAt(s, 1234.9)
    expect(readSeenAt(s)).toBe(1234)
    s.data['orgai.inboxSeenAt'] = 'nope'
    expect(readSeenAt(s)).toBeNull()
    writeSeenAt(s, -1)
    expect(s.data['orgai.inboxSeenAt']).toBe('nope')
  })
  it('round-trips the read ids, capped, and survives corrupt storage', () => {
    const s = mem()
    expect(readReadIds(s)).toEqual([])
    writeReadIds(s, Array.from({ length: INBOX_READ_CAP + 5 }, (_, i) => `r${i}`))
    const back = readReadIds(s)
    expect(back).toHaveLength(INBOX_READ_CAP)
    expect(back[back.length - 1]).toBe(`r${INBOX_READ_CAP + 4}`)
    s.data['orgai.inboxRead'] = '{"not":"a list"}'
    expect(readReadIds(s)).toEqual([])
    s.data['orgai.inboxRead'] = '[1,"a",null]'
    expect(readReadIds(s)).toEqual(['a'])
    expect(readSeenAt(null)).toBeNull()
  })
})

describe('openTeamCount (the empty Inbox and the sidebar agree)', () => {
  const statuses = ['starting', 'running', 'idle', 'stopping', 'finished', 'error', 'paused'] as const
  it('counts exactly the statuses the store treats as live', async () => {
    const { isRunLive } = await import('../store/useAppStore')
    for (const status of statuses) {
      const live = isRunLive({ summary: { status } } as Parameters<typeof isRunLive>[0])
      expect(openTeamCount([{ projectId: 'p', status }]), status).toBe(live ? 1 : 0)
    }
  })
  it('counts distinct projects, not runs', () => {
    expect(
      openTeamCount([
        { projectId: 'a', status: 'running' },
        { projectId: 'a', status: 'idle' },
        { projectId: 'b', status: 'starting' },
        { projectId: 'c', status: 'finished' }
      ])
    ).toBe(2)
    expect(openTeamCount([])).toBe(0)
  })
})
