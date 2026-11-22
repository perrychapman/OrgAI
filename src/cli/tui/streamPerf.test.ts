import { describe, expect, it } from 'vitest'
import type { RunSummary, TranscriptEntry } from '../../shared/types'
import { mergeChainFeed } from '../../shared/view/transcriptRows'
import { record, summary } from '../testing/fakeContext'
import { withTeamMilestones } from './collaboration'
import { DEFAULT_TUI_ENV } from './context'
import { orgTreeRows, partialRows, planView, selectorStats, statusSummary, trayCards, transcriptRows, worktreeRows } from './selectors'
import { applyEvent, applyRecord, applySnapshot, createInitialState, createPartialTracker, setActiveRun } from './state'
import { build, groupToolRows, type RowCache } from './TranscriptPane'
import type { TuiState } from './types'

// Streaming cost properties, checked by identity and call counts (never by wall-clock time). The timing test at the end
// only prints numbers.

const entries = (prefix: string, n: number): TranscriptEntry[] =>
  Array.from({ length: n }, (_, i): TranscriptEntry => {
    const at = 1000 + i
    if (i % 3 === 0) return { id: `${prefix}${i}`, agentId: i % 2 ? 'root' : 'w1', at, block: { kind: 'text', text: `Some **markdown** reply number ${i} with enough words to wrap across a narrow pane a couple of times over.` } }
    if (i % 3 === 1) return { id: `${prefix}${i}`, agentId: 'w1', at, block: { kind: 'tool_use', id: `t${prefix}${i}`, name: 'Bash', input: { command: `ls -la dir${i}` } } }
    return { id: `${prefix}${i}`, agentId: 'w1', at, block: { kind: 'tool_result', toolUseId: `t${prefix}${i - 1}`, content: 'file1\nfile2', isError: false } }
  })

function streamingState(chain: boolean, perRun: number): TuiState {
  const r1 = summary('r1', { status: chain ? 'finished' : 'running', startedAt: 100 })
  const r2 = summary('r2', { status: 'running', startedAt: 200, resumedFrom: 'r1' } as Partial<RunSummary>)
  const active = chain ? r2 : r1
  let s = applySnapshot(
    createInitialState('/work'),
    { mode: 'snapshot', hostInstanceId: 'aaaaaaaaaaaa', seq: 1, filterKey: 'f', snapshot: { liveRuns: chain ? [r1, r2] : [r1], recentEndedRuns: [], pendingCards: {}, activeRun: record(active, { transcript: entries(active.id, perRun) }) } } as never,
    { activeRunId: active.id }
  )
  if (chain) {
    s = applyRecord(s, record(r1, { transcript: entries('r1', perRun) }))
    s = setActiveRun(s, 'r2', ['r1', 'r2'])
  }
  return s
}

const partial = (s: TuiState, runId: string, text: string, t = createPartialTracker()): TuiState =>
  applyEvent(s, { atSeq: 0, event: { type: 'agent.partial', runId, agentId: 'root', text } } as never, { partials: t })

describe('a streamed delta', () => {
  it('leaves the runs, chain and every transcript array as they were (the App memo inputs)', () => {
    const s0 = streamingState(false, 300)
    const tracker = createPartialTracker()
    const s1 = partial(s0, 'r1', 'hello ', tracker)
    const s2 = partial(s1, 'r1', 'hello world', tracker)
    for (const s of [s1, s2]) {
      expect(s.runs).toBe(s0.runs)
      expect(s.runs.r1).toBe(s0.runs.r1)
      expect(s.runs.r1.transcript).toBe(s0.runs.r1.transcript)
      expect(s.activeChain).toBe(s0.activeChain)
      expect(s.project).toBe(s0.project)
    }
    expect(s2.partials?.r1.root).toBe('hello world')
    expect(partialRows(s2).map((p) => p.text)).toEqual(['hello world'])
  })

  it('does not rebuild any transcript row when the selector runs again for the next frame', () => {
    const s0 = streamingState(true, 200)
    transcriptRows(s0)
    const before = selectorStats.entryRowBuilds
    const s1 = partial(s0, 'r2', 'streaming')
    transcriptRows(s1)
    transcriptRows(s0)
    expect(selectorStats.entryRowBuilds).toBe(before)
  })

  it('a finished entry clears that agent stream, and the run ending clears the rest', () => {
    const tracker = createPartialTracker()
    let s = partial(streamingState(false, 3), 'r1', 'typing', tracker)
    s = applyEvent(s, { seq: 5, event: { type: 'transcript', runId: 'r1', entry: { id: 'n1', agentId: 'root', at: 1, block: { kind: 'text', text: 'done' } } } } as never, { partials: tracker })
    expect(s.partials?.r1).toBeUndefined()
    s = partial(s, 'r1', 'again', tracker)
    s = applyEvent(s, { seq: 6, event: { type: 'run.status', runId: 'r1', status: 'finished' } } as never, { partials: tracker })
    expect(s.partials?.r1).toBeUndefined()
  })
})

describe('mergeChainFeed', () => {
  it('returns the same copy of an earlier member entry on every call, so row caches keep hitting', () => {
    const members = [
      { summary: summary('r1', { status: 'finished' }), entries: entries('a', 20) },
      { summary: summary('r2', { startedAt: 2000, resumedFrom: 'r1' } as Partial<RunSummary>), entries: entries('b', 5) }
    ]
    const entriesOf = (feed: ReturnType<typeof mergeChainFeed>): TranscriptEntry[] => feed.flatMap((x) => (x.kind === 'entry' ? [x.entry] : []))
    const one = entriesOf(mergeChainFeed(members))
    const two = entriesOf(mergeChainFeed(members))
    expect(two.length).toBe(25)
    for (let i = 0; i < one.length; i++) expect(two[i]).toBe(one[i])
    expect(one[0].id).toBe('r1:a0')
    // The newest member's own entries are not copies at all.
    expect(one[one.length - 1]).toBe(members[1].entries[4])
  })
})

describe('build', () => {
  it('hands out the same pane line objects for unchanged rows when a row is appended', () => {
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, runId: 'r1', kind: 'text' as const, text: `row ${i} `.repeat(20) }))
    const cache: RowCache = { width: 60, env: DEFAULT_TUI_ENV, rows: new Map() }
    const first = build(rowsOf(50), 0, 60, DEFAULT_TUI_ENV, cache)
    const second = build(rowsOf(51), 0, 60, DEFAULT_TUI_ENV, cache)
    expect(second.lines.length).toBeGreaterThan(first.lines.length)
    for (let i = 0; i < first.lines.length; i++) expect(second.lines[i]).toBe(first.lines[i])
  })
})

describe('per-delta cost (printed, not asserted)', () => {
  for (const chain of [false, true]) {
    it(`300 deltas against ${chain ? '2 x 2500' : '5000'} entries${chain ? ' (continued chain)' : ''}`, () => {
      const run = (memoised: boolean): number => {
        let s = streamingState(chain, chain ? 2500 : 5000)
        const id = s.activeRunId!
        const tracker = createPartialTracker()
        const cache: RowCache = { width: 100, env: DEFAULT_TUI_ENV, rows: new Map() }
        let seenRuns: unknown
        let text = ''
        const t0 = performance.now()
        for (let i = 0; i < 300; i++) {
          text += 'streamed words '
          s = partial(s, id, text, tracker)
          // What App recomputes: the memos are keyed on state.runs and friends; the partial rows on state.partials too.
          if (!memoised || seenRuns !== s.runs) {
            seenRuns = s.runs
            trayCards(s)
            planView(s)
            worktreeRows(s)
            orgTreeRows(s, { includeRoles: true, collapse: true, expanded: {}, now: 1 })
            statusSummary(s)
            const t = transcriptRows(s)
            build(groupToolRows(withTeamMilestones(s, t.rows), false), t.omitted, 100, DEFAULT_TUI_ENV, cache, true, false)
          }
          partialRows(s)
        }
        return performance.now() - t0
      }
      run(false)
      const all = run(false)
      const memo = run(true)
      console.log(`PERF chain=${chain} recompute-everything=${(all / 300).toFixed(2)}ms/delta memoised=${(memo / 300).toFixed(3)}ms/delta`)
      expect(true).toBe(true)
    })
  }
})
