import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGAGEMENT_DOCUMENT_MAX_CHARS, ENGAGEMENT_NOTE_MAX_CHARS, type EngagementNote, type HostScope } from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, rpcError, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { NOTE_STALE_MESSAGE, resolveNote, runNotes } from './notes'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => Object.assign(manageDeps, realDeps))

const eng = project('e1', '/work', { name: 'Acme review', kind: 'engagement' } as never)
const code = project('c1', '/code', { name: 'App' })

const note = (id: string, extra: Partial<EngagementNote> = {}): EngagementNote => ({ id, title: `Note ${id}`, excerpt: 'first line', createdAt: 10, updatedAt: 100, chars: 20, ...extra })

const clients = new WeakMap<object, FakeHostClient>()
function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [eng, code], ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], ...o })
  clients.set(f, client)
  return { client, f }
}
async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  const c = clients.get(f)
  if (c) c.closed = false
  try {
    return await runNotes(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('engagements only', () => {
  it('a code project is exit 2', async () => {
    const { f } = setup({}, { cwd: '/code' })
    expect(await run(f, ['list'])).toBe(EXIT.usage)
    expect(f.err()).toContain('This is a code project')
    expect(await run(f, ['plan'])).toBe(EXIT.usage)
  })
})

describe('notes list / show', () => {
  it('hides retired notes unless --retired', async () => {
    const { f } = setup({ 'projects:listNotes': () => [note('n2', { createdAt: 20, retired: true }), note('n1', { source: 'agent', recordedBy: { role: 'Analyst' } })] })
    expect(await run(f, ['list'])).toBe(0)
    expect(f.out()).toMatch(/n1\s+Note n1\s+Analyst/)
    expect(f.out()).not.toMatch(/n2\s+Note n2/)
    expect(f.out()).toContain('1 retired not shown')
    expect(await run(f, ['list', '--retired'])).toBe(0)
    expect(f.out()).toContain('Note n2 (retired)')
  })

  it('show by id or title; sanitizes the text', async () => {
    const { f, client } = setup({ 'projects:listNotes': () => [note('n1', { title: 'Kickoff' })], 'projects:getNote': () => ({ ...note('n1', { title: 'Kickoff' }), text: 'Hello\u001b[31m red' }) })
    expect(await run(f, ['show', 'kickoff'])).toBe(0)
    expect(client.callsOf('projects:getNote')).toEqual([[{ projectId: 'e1', noteId: 'n1' }]])
    expect(f.out()).toContain('Hello')
    expect(f.out()).not.toContain('\u001b[31m')
    expect(() => resolveNote([note('a', { title: 'X' }), note('b', { title: 'x' })], 'X')).toThrow(/use the id/)
    expect(() => resolveNote([], 'none')).toThrow(CliError)
  })
})

describe('notes add / edit', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'notes-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('add with --text and --file; the cap is checked before sending', async () => {
    const { f, client } = setup({ 'projects:saveNote': (p) => note('n9', { title: (p as [{ title: string }])[0].title }) })
    expect(await run(f, ['add', '--title', 'Kickoff', '--text', 'We met.'])).toBe(0)
    expect(client.callsOf('projects:saveNote')).toEqual([[{ projectId: 'e1', title: 'Kickoff', text: 'We met.' }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    const file = join(dir, 'n.md')
    writeFileSync(file, 'From a file')
    expect(await run(f, ['add', '--title', 'File', '--file', file])).toBe(0)
    expect((client.callsOf('projects:saveNote')[1] as [{ text: string }])[0].text).toBe('From a file')
    const big = join(dir, 'big.md')
    writeFileSync(big, 'x'.repeat(ENGAGEMENT_NOTE_MAX_CHARS + 1))
    const calls = f.connectCalls.length
    expect(await run(f, ['add', '--title', 'Big', '--file', big])).toBe(EXIT.usage)
    expect(f.connectCalls.length).toBe(calls)
    expect(await run(f, ['add', '--text', 'no title'])).toBe(EXIT.usage)
    expect(await run(f, ['add', '--title', 'T', '--text', 'a', '--file', file])).toBe(EXIT.usage)
  })

  it('edit keeps what it does not change and refuses a stale revision with exit 1', async () => {
    let stored = { ...note('n1', { title: 'Kickoff', updatedAt: 100 }), text: 'old text' }
    const { f, client } = setup({
      'projects:listNotes': () => [stored],
      'projects:getNote': () => stored,
      'projects:saveNote': (p) => {
        const i = (p as [{ title: string; text: string }])[0]
        stored = { ...stored, title: i.title, text: i.text, updatedAt: stored.updatedAt + 1 }
        return stored
      }
    })
    expect(await run(f, ['edit', 'n1', '--text', 'new text'])).toBe(0)
    expect(client.callsOf('projects:saveNote')).toEqual([[{ projectId: 'e1', noteId: 'n1', title: 'Kickoff', text: 'new text', expectedUpdatedAt: 100 }]])
    // The note is now at 101: an edit based on 100 is stale.
    expect(await run(f, ['edit', 'n1', '--title', 'Renamed', '--expected-updated-at', '100'])).toBe(1)
    expect(f.err()).toContain(NOTE_STALE_MESSAGE)
    expect(client.callsOf('projects:saveNote')).toHaveLength(1)
    expect(await run(f, ['edit', 'n1', '--retire', '--expected-updated-at', '101'])).toBe(0)
    expect((client.callsOf('projects:saveNote')[1] as [{ retired?: boolean; text: string }])[0]).toMatchObject({ retired: true, text: 'new text' })
    expect(await run(f, ['edit', 'n1'])).toBe(EXIT.usage)
    expect(await run(f, ['edit', 'n1', '--retire', '--restore'])).toBe(EXIT.usage)
    expect(await run(f, ['edit', 'n1', '--text', 'x', '--expected-updated-at', 'yesterday'])).toBe(EXIT.usage)
  })

  it('edit maps the host\'s stale_revision refusal (a write between the read and the save) to exit 1', async () => {
    const stored = { ...note('n1', { title: 'Kickoff', updatedAt: 100 }), text: 'old text' }
    const { f } = setup({
      'projects:listNotes': () => [stored],
      'projects:getNote': () => stored,
      'projects:saveNote': () => Promise.reject(rpcError({ code: 'stale_revision', message: 'The note changed since it was read.' }))
    })
    expect(await run(f, ['edit', 'n1', '--text', 'new text'])).toBe(1)
    expect(f.err()).toContain(NOTE_STALE_MESSAGE)
  })

  it('remove asks unless --yes', async () => {
    const { f, client } = setup({ 'projects:listNotes': () => [note('n1')], 'projects:removeNote': () => [] })
    expect(await run(f, ['remove', 'n1'])).toBe(EXIT.usage)
    expect(await run(f, ['remove', 'n1', '--yes'])).toBe(0)
    expect(client.callsOf('projects:removeNote')).toEqual([[{ projectId: 'e1', noteId: 'n1' }]])
  })
})

describe('notes plan', () => {
  it('show prints the document', async () => {
    const { f } = setup({ 'projects:engagementDocument': () => ({ text: '# Plan\nScope', updatedAt: 5, updatedBy: 'setup' }) })
    expect(await run(f, ['plan'])).toBe(0)
    expect(f.out()).toContain('# Plan')
    expect(f.out()).toContain('by setup')
  })

  it('set from stdin sends the read revision; a stale refusal is exit 1', async () => {
    manageDeps.readStdin = async () => 'New plan\n'
    const { f, client } = setup({ 'projects:engagementDocument': () => ({ text: 'old', updatedAt: 42, updatedBy: 'user' }), 'projects:updateEngagementDocument': (p) => ({ text: (p as [{ text: string }])[0].text, updatedAt: 43, updatedBy: 'user' }) })
    expect(await run(f, ['plan', 'set', '--file', '-'])).toBe(0)
    expect(client.callsOf('projects:updateEngagementDocument')).toEqual([[{ projectId: 'e1', text: 'New plan\n', expectedUpdatedAt: 42 }]])

    const stale = setup({
      'projects:updateEngagementDocument': () => Promise.reject(rpcError({ code: 'internal', message: 'The engagement plan changed since you opened it.' } as never))
    })
    expect(await run(stale.f, ['plan', 'set', '--text', 'x', '--expected-updated-at', '1'])).toBe(1)
    expect(stale.f.err()).toContain('changed since')
    expect(stale.client.callsOf('projects:engagementDocument')).toEqual([])
  })

  it('a file over the cap is exit 2 before sending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-'))
    try {
      const big = join(dir, 'plan.md')
      writeFileSync(big, 'y'.repeat(ENGAGEMENT_DOCUMENT_MAX_CHARS + 1))
      const { f } = setup({})
      expect(await run(f, ['plan', 'set', '--file', big])).toBe(EXIT.usage)
      expect(f.err()).toContain('longer than 100,000 characters')
      expect(f.connectCalls).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
