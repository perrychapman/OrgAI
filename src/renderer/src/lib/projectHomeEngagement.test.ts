import { describe, expect, it } from 'vitest'
import type { KnowledgeNode, RunOutput } from '@shared/types'
import type { KnowledgeItem } from '@shared/view/knowledge'
import {
  PURPOSE_MAX_CHARS,
  connectionRows,
  connectionStatus,
  engagementFacts,
  folderName,
  folderRows,
  knowledgeHome,
  latestFiles,
  outputKindWord,
  purposeOf,
  recentRuns,
  type RecentRunIn
} from './projectHomeEngagement'

const NOW = new Date(2026, 10, 22, 12, 0).getTime()
const H = 3_600_000
const D = 24 * H

describe('purposeOf', () => {
  it('is null for an empty or missing document', () => {
    expect(purposeOf(null)).toBeNull()
    expect(purposeOf({ text: '  \n\n ' })).toBeNull()
  })
  it('reduces markdown to plain text and skips a title-only first block', () => {
    const p = purposeOf({ text: '# Acme onboarding\n\nWork out **how** new starters are brought in.\n\n- first\n- [a link](http://x)' })!
    expect(p.text).toBe('Work out how new starters are brought in. first a link')
    expect(p.cut).toBe(false)
  })
  it('keeps a lone heading when nothing follows', () => {
    expect(purposeOf({ text: '# Only a title' })!.text).toBe('Only a title')
  })
  it('cuts long text at a word with an ellipsis', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const p = purposeOf({ text: words })!
    expect(p.cut).toBe(true)
    expect(p.text.length).toBeLessThanOrEqual(PURPOSE_MAX_CHARS + 1)
    expect(p.text.endsWith('…')).toBe(true)
    expect(p.text.slice(0, -1).endsWith(' ')).toBe(false)
  })
})

describe('engagementFacts', () => {
  const base = { project: { client: undefined as string | undefined, createdAt: new Date(2026, 10, 3).toISOString() }, runs: [], outputs: [], now: NOW }
  it('has only the lines with data', () => {
    expect(engagementFacts(base)).toEqual([{ label: 'Started', value: '3 Nov 2026' }])
    expect(engagementFacts({ ...base, project: { client: ' ', createdAt: 'nope' } })).toEqual([])
  })
  it('adds client, runs, files, last activity and spend', () => {
    const facts = engagementFacts({
      ...base,
      project: { ...base.project, client: 'Acme Corp' },
      runs: [
        { kind: 'work', startedAt: NOW - 3 * D, endedAt: NOW - 2 * D, totalCostUsd: 1.5 },
        { kind: 'work', startedAt: NOW - 1 * D, endedAt: NOW - 5 * H, totalCostUsd: 0.5 },
        { kind: 'setup', startedAt: NOW - 4 * D, endedAt: NOW - 4 * D, totalCostUsd: 0 }
      ] as never,
      outputs: [{ createdAt: NOW - 6 * H, updatedAt: NOW - 2 * H }] as never
    })
    expect(Object.fromEntries(facts.map((f) => [f.label, f.value]))).toEqual({ For: 'Acme Corp', Started: '3 Nov 2026', Runs: '2', Files: '1', 'Last activity': '2 h ago', Spent: '$2.00 so far' })
  })
})

describe('recentRuns', () => {
  const r = (id: string, over: Record<string, unknown> = {}, extra: Partial<RecentRunIn> = {}): RecentRunIn => ({
    summary: { id, status: 'finished', kind: 'work', title: id, prompt: id, startedAt: NOW - D, endedAt: NOW - 20 * H, totalCostUsd: 0.42, ...over } as RecentRunIn['summary'],
    decisions: 0,
    ...extra
  })
  it('keeps work runs only, newest first, capped', () => {
    const rows = recentRuns([r('old', { startedAt: 1 }), r('setup', { kind: 'setup' }), r('new', { startedAt: NOW - H }), ...Array.from({ length: 6 }, (_, i) => r(`m${i}`, { startedAt: 10 + i }))], NOW)
    expect(rows).toHaveLength(4)
    expect(rows[0].id).toBe('new')
    expect(rows.some((x) => x.id === 'setup')).toBe(false)
  })
  it('words each state and tone from the summary', () => {
    const word = (over: Record<string, unknown>, extra: Partial<RecentRunIn> = {}) => recentRuns([r('x', over, extra)], NOW)[0]
    expect(word({})).toMatchObject({ result: 'Finished · $0.42', tone: 'ok', when: '20 h ago' })
    expect(word({ team: 'single' }).result).toBe('Answered · $0.42')
    expect(word({ status: 'error' })).toMatchObject({ result: 'Failed · $0.42', tone: 'bad' })
    expect(word({ endedBy: 'user' })).toMatchObject({ result: 'Stopped · $0.42', tone: 'muted' })
    expect(word({ status: 'paused' }).result).toContain('Paused')
    expect(word({ status: 'running', endedAt: undefined })).toMatchObject({ result: 'Running', tone: 'working', when: 'now' })
    expect(word({ status: 'running' }, { decisions: 2 })).toMatchObject({ result: 'Waiting on you (2)', tone: 'waiting' })
  })
  it('adds the plan step of a running run and the agent count of a live one', () => {
    const row = recentRuns(
      [
        r(
          'live',
          { status: 'running', endedAt: undefined },
          {
            plan: { status: 'active', steps: [{ id: 'p1', title: 'A', status: 'done' }, { id: 'p2', title: 'B', status: 'in_progress' }] } as never,
            agents: { root: { id: 'root', parentId: null }, a: { id: 'a', parentId: 'root' }, b: { id: 'b', parentId: 'root' } }
          }
        )
      ],
      NOW
    )[0]
    expect(row.result).toBe('Running · step 2 of 2')
    expect(row.who).toBe('3 agents')
    expect(recentRuns([r('ask', { team: 'single' })], NOW)[0].who).toBe('Ask')
  })
})

describe('latestFiles', () => {
  const o = (id: string, over: Partial<RunOutput> = {}): RunOutput => ({ id, title: id, fileName: `${id}.docx`, kind: 'docx', createdAt: NOW - 5 * D, version: 2, ...over }) as RunOutput
  it('shows the newest present files with kind and version', () => {
    const files = latestFiles([o('a', { updatedAt: NOW - 2 * H }), o('b', { missing: true, updatedAt: NOW }), o('c', { kind: 'xlsx', version: 1, updatedAt: NOW - H }), o('d', { title: '', kind: 'weird' })], NOW)
    expect(files.map((f) => f.id)).toEqual(['c', 'a', 'd'])
    expect(files[0]).toMatchObject({ kind: 'Sheet', note: 'Version 1 · 1 h ago' })
    expect(files[2]).toMatchObject({ name: 'd.docx', kind: 'Weird' })
    expect(latestFiles(Array.from({ length: 9 }, (_, i) => o(`f${i}`)), NOW)).toHaveLength(4)
    expect(outputKindWord('')).toBe('File')
  })
})

describe('knowledgeHome', () => {
  const node = (id: string, kind: string, createdAt: number, retired = false): KnowledgeItem =>
    ({ type: 'node', id, node: { id, kind, name: id, facts: [], source: { by: 'agent', at: createdAt }, createdAt, updatedAt: createdAt, ...(retired ? { retired: true } : {}) } as KnowledgeNode })
  it('is null when nothing is recorded', () => {
    expect(knowledgeHome([], NOW)).toBeNull()
    expect(knowledgeHome([node('x', 'person', NOW, true)], NOW)).toBeNull()
  })
  it('counts live items, this week, kinds and the latest three', () => {
    const k = knowledgeHome([node('old', 'person', NOW - 20 * D), node('a', 'decision', NOW - 1 * D), node('b', 'decision', NOW - 2 * H), node('c', 'risk', NOW - 3 * D), node('gone', 'risk', NOW, true)], NOW)!
    expect(k.count).toBe(4)
    expect(k.addedThisWeek).toBe(3)
    expect(k.kinds.map((x) => [x.kind, x.count]).sort()).toEqual([['decision', 2], ['person', 1], ['risk', 1]])
    expect(k.latest.map((l) => l.id)).toEqual(['b', 'a', 'c'])
    expect(k.latest[0]).toMatchObject({ kindLabel: 'Decision', when: '2 h ago' })
  })
})

describe('connections and folders', () => {
  const s = (name: string, extra: Record<string, unknown> = {}, enabled = true) => ({ spec: { id: name, name, enabled }, missingSecrets: [], auth: { state: 'notRequired' }, ...extra })
  it('never claims a live connection and says what is known', () => {
    expect(connectionStatus(s('a', {}, false))).toEqual({ status: 'Off', tone: 'muted' })
    expect(connectionStatus(s('a', { libraryMissing: true })).tone).toBe('warn')
    expect(connectionStatus(s('a', { missingSecrets: ['KEY'] })).status).toBe('Needs a key or token')
    expect(connectionStatus(s('a', { auth: { state: 'expired' } })).status).toBe('Needs you to sign in')
    expect(connectionStatus(s('a', { auth: { state: 'error' } })).status).toBe('Sign-in failed')
    expect(connectionStatus(s('a', { auth: { state: 'authorized' } }))).toEqual({ status: 'Signed in', tone: 'ok' })
    expect(connectionStatus(s('a'))).toEqual({ status: 'Ready', tone: 'ok' })
  })
  it('sorts the ones needing attention first, then ok, then off', () => {
    const rows = connectionRows([s('zeta', {}, false), s('beta'), s('alpha', { auth: { state: 'notAuthorized' } })])
    expect(rows.map((r) => [r.name, r.tone, r.initial])).toEqual([
      ['alpha', 'warn', 'A'],
      ['beta', 'ok', 'B'],
      ['zeta', 'muted', 'Z']
    ])
    expect(connectionRows(undefined)).toEqual([])
  })
  it('lists the working folder, extra folders and reference folders without duplicates', () => {
    expect(folderName('C:\\Docs\\Source documents\\')).toBe('Source documents')
    expect(folderName('/')).toBe('/')
    const rows = folderRows({ path: '/w/acme', allowedDirectories: ['/w/extra', '/w/acme'], referenceDirectories: ['/w/ref'] })
    expect(rows.map((r) => [r.name, r.mode])).toEqual([
      ['acme', 'Team writes here'],
      ['extra', 'Team writes here'],
      ['ref', 'Read only']
    ])
  })
})
