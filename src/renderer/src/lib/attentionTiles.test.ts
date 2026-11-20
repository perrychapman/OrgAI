import { describe, expect, it } from 'vitest'
import type { AgentInstance, Project, RunSummary, TranscriptEntry } from '@shared/types'
import {
  decisionSince,
  groupDecisionTiles,
  isAwaitingReply,
  lastAssistantText,
  orderTiles,
  plainSummary,
  replyFacts,
  tileActionName,
  tileFacts,
  waitedLong,
  waitedShort,
  type AttentionTile,
  type TileItem
} from './attentionTiles'

const ag = (id: string, over: Partial<AgentInstance> = {}): AgentInstance =>
  ({ id, name: `Role ${id}`, roleId: null, roleSlug: id, parentId: 'root', state: 'thinking', activity: `doing ${id}`, startedAt: 10, ...over }) as AgentInstance
const root = (over: Partial<AgentInstance> = {}): AgentInstance => ag('root', { parentId: null, startedAt: 0, name: 'Lead', ...over })
const summary = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({ id, projectId: 'p1', kind: 'work', status: 'idle', startedAt: 1, prompt: `prompt ${id}`, ...over }) as RunSummary
const project = (): Project => ({ id: 'p1', name: 'Alpha', roles: [] }) as unknown as Project
const text = (at: number, t: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ id: `e${at}`, agentId: 'root', at, block: { kind: 'text', text: t }, ...over })

describe('plainSummary: shaped input stays fast (Reviewer finding)', () => {
  it('runs in well under 50 ms on long separator-like lines and many brackets or stars', () => {
    const inputs = [' '.repeat(2559) + 'x', '-'.repeat(2559) + 'x', '|:- '.repeat(640) + 'x', '['.repeat(2560), '(*'.repeat(1280), `a${' -'.repeat(1279)}`]
    for (const s of inputs) {
      const t0 = performance.now()
      plainSummary(s)
      expect(performance.now() - t0).toBeLessThan(50)
    }
  })
  it('still drops table separators and thematic breaks', () => {
    expect(plainSummary('| a | b |\n|---|:--:|\n| 1 | 2 |')).toBe('a b 1 2')
    expect(plainSummary('one\n---\n* * *\n___\ntwo')).toBe('one two')
  })
})

describe('plainSummary: untrusted text becomes one plain line', () => {
  it('removes markdown marks and keeps the words', () => {
    expect(plainSummary('# Plan\n\n- **Fix** the `parser`\n- see [the docs](https://x.test/a)\n\n```ts\nconst a = 1\n```\n> done')).toBe('Plan Fix the parser see the docs const a = 1 done')
  })
  it('never produces markup: tags and links stay the characters they were', () => {
    expect(plainSummary('<img src=x onerror=alert(1)> https://evil.test/x')).toBe('<img src=x onerror=alert(1)> https://evil.test/x')
  })
  it('collapses whitespace and shows hidden characters', () => {
    expect(plainSummary('a\t\t b\n\n\n c‮d')).toBe('a b c\\u202ed')
  })
  it('clips long text with an ellipsis', () => {
    const out = plainSummary('word '.repeat(200), 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith('…')).toBe(true)
  })
  it('keeps snake_case identifiers and star math', () => {
    expect(plainSummary('call my_func_name with 2 * 3 * 4')).toBe('call my_func_name with 2 * 3 * 4')
  })
})

describe('lastAssistantText', () => {
  it('takes the newest root text block, skipping reports, user lines, tools and harness notes', () => {
    const t: TranscriptEntry[] = [
      text(1, 'first'),
      text(2, 'second answer'),
      text(3, 'a report speaking', { agentId: 'r1' }),
      { id: 'u', agentId: 'root', at: 4, block: { kind: 'user', text: 'user said' } },
      text(5, 'harness nudge', { source: 'harness' }),
      { id: 'tu', agentId: 'root', at: 6, block: { kind: 'tool_use', id: 't', name: 'Read', input: {} } }
    ]
    expect(lastAssistantText(t, 'root')).toEqual({ text: 'second answer', at: 2 })
  })
  it('is null without any text', () => {
    expect(lastAssistantText([], 'root')).toBeNull()
    expect(lastAssistantText([text(1, '   \n ')], 'root')).toBeNull()
  })
})

describe('waited', () => {
  it('is compact and empty when unknown', () => {
    const now = 10_000_000
    expect(waitedShort(undefined, now)).toBe('')
    expect(waitedShort(now - 20_000, now)).toBe('<1m')
    expect(waitedShort(now - 12 * 60_000, now)).toBe('12m')
    expect(waitedShort(now - 3 * 3_600_000, now)).toBe('3h')
    expect(waitedShort(now - 2 * 86_400_000, now)).toBe('2d')
    expect(waitedLong(now - 60_000, now)).toBe('Waiting 1 minute')
    expect(waitedLong(now - 5 * 3_600_000, now)).toBe('Waiting 5 hours')
    expect(waitedLong(undefined, now)).toBe('')
  })
})

describe('isAwaitingReply: the rule the greeting counts', () => {
  const idleRoot = (activity = 'Waiting for you'): Record<string, AgentInstance> => ({ root: root({ state: 'idle', activity }) })
  it('is true for an idle root waiting for the reply with no decision', () => {
    expect(isAwaitingReply({ summary: summary('a'), agents: idleRoot(), decisions: 0 }, [project()], {})).toBe(true)
  })
  it('is false with a decision open, for a working run and for an idle run that is simply done', () => {
    expect(isAwaitingReply({ summary: summary('a'), agents: idleRoot(), decisions: 1 }, [project()], {})).toBe(false)
    expect(isAwaitingReply({ summary: summary('a', { status: 'running' }), agents: { root: root() }, decisions: 0 }, [project()], {})).toBe(false)
    expect(isAwaitingReply({ summary: summary('a'), agents: idleRoot('Done'), decisions: 0 }, [project()], {})).toBe(false)
  })
})

describe('replyFacts', () => {
  it('summarises the root last message and keys the tile by turn', () => {
    const f = replyFacts({ summary: summary('a'), agents: { root: root({ state: 'idle' }) }, decisions: 0, transcript: [text(100, 'Old'), text(200, '**Ready** for your call.')] }, 'Plan the week')
    expect(f).toMatchObject({ key: 'reply:a:200', runId: 'a', projectId: 'p1', title: 'Plan the week', summary: 'Ready for your call.', since: 200 })
  })
  it('has an empty summary and the last entry time when the root said nothing', () => {
    const f = replyFacts({ summary: summary('a'), agents: { root: root({ state: 'idle' }) }, decisions: 0, transcript: [{ id: 'x', agentId: 'root', at: 50, block: { kind: 'user', text: 'hi' } }] }, 'T')
    expect(f.summary).toBe('')
    expect(f.since).toBe(50)
  })
  it('has no time and a plain key without a transcript', () => {
    const f = replyFacts({ summary: summary('a'), agents: {}, decisions: 0, transcript: [] }, 'T')
    expect(f.key).toBe('reply:a')
    expect(f.since).toBeUndefined()
  })
})

describe('decisionSince', () => {
  it('prefers the earliest card time, else the last transcript entry', () => {
    expect(decisionSince({ questions: [{ createdAt: 500 }], mergeReviews: [{ createdAt: 300 }], transcript: [{ at: 900 }] })).toBe(300)
    expect(decisionSince({ transcript: [{ at: 100 }, { at: 400 }] })).toBe(400)
    expect(decisionSince({})).toBeUndefined()
  })
})

interface Item extends TileItem {
  label: string
}
const item = (kind: string, key: string, runId: string | undefined, projectId = 'p1'): Item => ({ kind, key, runId, projectId, label: key })
const info = (it: Item): { startedAt: number; since?: number } => ({ startedAt: it.runId === 'old' ? 10 : 20 })

describe('groupDecisionTiles and orderTiles', () => {
  it('makes one tile per run and one per project for team-files items, keeping item order', () => {
    const tiles = groupDecisionTiles([item('question', 'q', 'a'), item('permission', 'p1', 'b'), item('permission', 'p2', 'a'), item('team', 't1', undefined, 'p9')], info)
    expect(tiles.map((t) => [t.key, t.kind, t.items.map((i) => i.key)])).toEqual([
      ['decision:a', 'decision', ['q', 'p2']],
      ['decision:b', 'decision', ['p1']],
      ['team:p9', 'team', ['t1']]
    ])
  })
  it('weighs a tile by its first item, then reply tiles by the longest wait', () => {
    const decision = groupDecisionTiles([item('permission', 'p', 'a'), item('question', 'q', 'b')], info)
    const replies = [
      { key: 'reply:new', kind: 'reply' as const, projectId: 'p1', runId: 'new', title: 'n', summary: '', startedAt: 5, since: 900 },
      { key: 'reply:old', kind: 'reply' as const, projectId: 'p1', runId: 'old', title: 'o', summary: '', startedAt: 5, since: 100 }
    ]
    const all: AttentionTile<Item>[] = [...replies, ...decision]
    expect(orderTiles(all).map((t) => t.key)).toEqual(['decision:b', 'decision:a', 'reply:old', 'reply:new'])
    expect(tileFacts(decision[1])).toEqual({ key: 'decision:b', kind: 'question', start: 20 })
  })
  it('keeps a tile where it was when another changes', () => {
    const a = groupDecisionTiles([item('permission', 'p', 'a')], info)[0]
    const b = groupDecisionTiles([item('permission', 'p', 'old')], info)[0]
    const first = orderTiles([a, b])
    expect(first.map((t) => t.key)).toEqual(['decision:old', 'decision:a'])
    const upgraded = groupDecisionTiles([item('question', 'q', 'a'), item('permission', 'p', 'a')], info)[0]
    expect(orderTiles([upgraded, b], first.map((t) => t.key)).map((t) => t.key)).toEqual(['decision:old', 'decision:a'])
  })
})

describe('tileActionName', () => {
  it('names the object', () => {
    expect(tileActionName('reply', 'Plan the week')).toBe('Reply to Plan the week')
    expect(tileActionName('decision', 'Plan the week')).toBe('Open Plan the week')
    expect(tileActionName('team', '')).toBe('Open this run')
  })
})
