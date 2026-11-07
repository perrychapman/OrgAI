import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTPUT_NOTES_MAX, OUTPUT_NOTE_LABELS_MAX, OUTPUT_NOTE_LABEL_MAX_CHARS, OUTPUT_NOTE_QUOTE_MAX_CHARS, OUTPUT_NOTE_TEXT_MAX, OUTPUT_REVISIONS_MAX } from '@shared/types'
import { addNote, checkRevisionRequest, cleanAnchor, cleanNoteText, newNoteId, newRevisionId, notesFile, readNotes, readRevisions, removeNote, revisionsFile, updateNote, writeNotes, writeRevisions } from './notes'

let data: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'orgai-outnotes-'))
})
afterEach(() => rmSync(data, { recursive: true, force: true }))
const OID = 'out_0123456789abcdef'

describe('anchors', () => {
  it('rebuilds each type field by field and drops extra keys', () => {
    expect(cleanAnchor({ type: 'whole', evil: 1 })).toEqual({ type: 'whole' })
    expect(cleanAnchor({ type: 'slide', slide: 3, x: 1 })).toEqual({ type: 'slide', slide: 3 })
    expect(cleanAnchor({ type: 'text', start: 2, end: 5, quote: 'abc', z: 1 })).toEqual({ type: 'text', start: 2, end: 5, quote: 'abc' })
    expect(cleanAnchor({ type: 'block', index: 0, start: 0, end: 0, quote: '' })).toEqual({ type: 'block', index: 0, start: 0, end: 0, quote: '' })
    expect(cleanAnchor({ type: 'cells', sheet: 'S', r1: 0, c1: 1, r2: 2, c2: 3 })).toEqual({ type: 'cells', sheet: 'S', r1: 0, c1: 1, r2: 2, c2: 3 })
    expect(cleanAnchor({ type: 'region', slide: 2, shape: 'ellipse', x: 0.1, y: 0.2, w: 0.5, h: 0.5, labels: ['a'] })).toEqual({ type: 'region', slide: 2, shape: 'ellipse', x: 0.1, y: 0.2, w: 0.5, h: 0.5, labels: ['a'] })
  })
  it.each([
    [null],
    ['text'],
    [[]],
    [{}],
    [{ type: 'nope' }],
    [{ type: 'slide', slide: 0 }],
    [{ type: 'slide', slide: 1.5 }],
    [{ type: 'slide', slide: Infinity }],
    [{ type: 'text', start: 5, end: 2, quote: '' }],
    [{ type: 'text', start: -1, end: 2, quote: '' }],
    [{ type: 'text', start: NaN, end: 2, quote: '' }],
    [{ type: 'text', start: 0, end: 1e12, quote: '' }],
    [{ type: 'text', start: '1', end: 2, quote: '' }],
    [{ type: 'block', index: -1, start: 0, end: 0, quote: '' }],
    [{ type: 'cells', sheet: '', r1: 3, c1: 0, r2: 1, c2: 0 }],
    [{ type: 'cells', sheet: '', r1: 0, c1: 0.5, r2: 1, c2: 1 }],
    [{ type: 'cells', sheet: '', r1: 0, c1: 3, r2: 1, c2: 1 }],
    [{ type: 'region', shape: 'box', x: 0.6, y: 0, w: 0.6, h: 0.5 }],
    [{ type: 'region', shape: 'box', x: 0, y: 0, w: 0, h: 0.5 }],
    [{ type: 'region', shape: 'box', x: -0.1, y: 0, w: 0.5, h: 0.5 }],
    [{ type: 'region', shape: 'box', x: 0, y: 0, w: NaN, h: 0.5 }],
    [{ type: 'region', shape: 'star', x: 0, y: 0, w: 0.5, h: 0.5 }],
    [{ type: 'region', shape: 'box', slide: 0, x: 0, y: 0, w: 0.5, h: 0.5 }],
    [{ type: 'region', shape: 'box', x: 0, y: 0, w: 0.5, h: 0.5, labels: 'a' }]
  ])('refuses the hostile anchor %j', (a) => {
    expect(() => cleanAnchor(a)).toThrow(/not valid/)
  })
  it('allows a region touching the edge within tolerance', () => {
    expect(cleanAnchor({ type: 'region', shape: 'box', x: 0.5, y: 0, w: 0.5000000001, h: 1 })).toMatchObject({ type: 'region' })
  })
  it('cuts and cleans quotes and labels instead of refusing', () => {
    const q = cleanAnchor({ type: 'text', start: 0, end: 1, quote: `a‮b\u0000c${'x'.repeat(1000)}` })
    if (q.type !== 'text') throw new Error('type')
    expect(q.quote.length).toBeLessThanOrEqual(OUTPUT_NOTE_QUOTE_MAX_CHARS)
    expect(q.quote.startsWith('a b c')).toBe(true)
    const labels = Array.from({ length: 50 }, (_, i) => `L${i}\n${'y'.repeat(500)}`)
    const r = cleanAnchor({ type: 'region', shape: 'box', x: 0, y: 0, w: 1, h: 1, labels })
    if (r.type !== 'region') throw new Error('type')
    expect(r.labels).toHaveLength(OUTPUT_NOTE_LABELS_MAX)
    expect(r.labels![0].length).toBeLessThanOrEqual(OUTPUT_NOTE_LABEL_MAX_CHARS)
    expect(r.labels![0]).not.toMatch(/\n/)
    const c = cleanAnchor({ type: 'cells', sheet: 's'.repeat(300), r1: 0, c1: 0, r2: 0, c2: 0, quote: 5 })
    if (c.type !== 'cells') throw new Error('type')
    expect(c.sheet.length).toBe(OUTPUT_NOTE_LABEL_MAX_CHARS)
    expect(c.quote).toBe('')
  })
  it('does not split a surrogate pair when cutting', () => {
    const q = cleanAnchor({ type: 'text', start: 0, end: 1, quote: `${'a'.repeat(OUTPUT_NOTE_QUOTE_MAX_CHARS - 1)}😀` })
    if (q.type !== 'text') throw new Error('type')
    expect(q.quote).toBe('a'.repeat(OUTPUT_NOTE_QUOTE_MAX_CHARS - 1))
  })
})

describe('note text', () => {
  it('accepts line breaks, refuses empty, long and hidden characters', () => {
    expect(cleanNoteText('one\ntwo')).toBe('one\ntwo')
    expect(() => cleanNoteText('')).toThrow(/empty/)
    expect(() => cleanNoteText('  ')).toThrow(/empty/)
    expect(() => cleanNoteText(5)).toThrow(/text/)
    expect(() => cleanNoteText('x'.repeat(OUTPUT_NOTE_TEXT_MAX + 1))).toThrow(/longer/)
    expect(() => cleanNoteText('a‮b')).toThrow(/hidden/)
    expect(() => cleanNoteText('a​b')).toThrow(/hidden/)
  })
})

describe('notes file', () => {
  it('adds, updates, resolves, removes and caps', () => {
    const a = addNote(data, 'p1', OID, { version: 1, anchor: { type: 'whole' }, text: 'Fix this' }, 100)
    expect(a.note).toMatchObject({ status: 'open', version: 1, outputId: OID, createdAt: 100 })
    expect(a.note.id).toMatch(/^note_[0-9a-f]{16}$/)
    const u = updateNote(data, 'p1', OID, a.note.id, { status: 'resolved' }, 200)
    expect(u.note).toMatchObject({ status: 'resolved', resolvedAt: 200 })
    const re = updateNote(data, 'p1', OID, a.note.id, { status: 'open', text: 'Fix that' }, 300)
    expect(re.note.resolvedAt).toBeUndefined()
    expect(re.note.text).toBe('Fix that')
    expect(() => updateNote(data, 'p1', OID, a.note.id, { status: 'sent' }, 1)).toThrow(/open or resolved/)
    expect(() => updateNote(data, 'p1', OID, 'note_ffffffffffffffff', { text: 'x' }, 1)).toThrow(/not on this output/)
    expect(readNotes(data, 'p1', OID).items).toHaveLength(1)
    expect(removeNote(data, 'p1', OID, a.note.id)).toEqual([])
    expect(() => removeNote(data, 'p1', OID, a.note.id)).toThrow(/not on this output/)
  })
  it('refuses past the cap', () => {
    const notes = Array.from({ length: OUTPUT_NOTES_MAX }, () => ({ id: newNoteId(), outputId: OID, version: 1, anchor: { type: 'whole' as const }, text: 't', status: 'open' as const, createdAt: 1 }))
    writeNotes(data, 'p1', OID, notes)
    expect(() => addNote(data, 'p1', OID, { version: 1, anchor: { type: 'whole' }, text: 'x' }, 1)).toThrow(/already has/)
  })
  it('drops junk notes on read and refuses writes to an unreadable file without touching it', () => {
    writeNotes(data, 'p1', OID, [])
    const file = notesFile(data, 'p1', OID)
    writeFileSync(file, JSON.stringify({ version: 1, notes: [{ id: 'x' }, { id: newNoteId(), version: 1, anchor: { type: 'text', start: 5, end: 1, quote: '' }, text: 'bad anchor', status: 'open', createdAt: 1 }, { id: newNoteId(), version: 1, anchor: { type: 'whole' }, text: 'ok', status: 'open', createdAt: 1 }, 7] }))
    expect(readNotes(data, 'p1', OID).items.map((n) => n.text)).toEqual(['ok'])
    writeFileSync(file, '{ nope')
    expect(readNotes(data, 'p1', OID).state).toBe('unreadable')
    expect(() => addNote(data, 'p1', OID, { version: 1, anchor: { type: 'whole' }, text: 'x' }, 1)).toThrow(/could not be read/)
    expect(() => removeNote(data, 'p1', OID, 'note_ffffffffffffffff')).toThrow(/could not be read/)
    expect(readFileSync(file, 'utf8')).toBe('{ nope')
    writeFileSync(file, JSON.stringify({ version: 2, notes: [] }))
    expect(readNotes(data, 'p1', OID).state).toBe('unreadable')
  })
  it('a missing file reads empty', () => {
    expect(readNotes(data, 'p1', OID)).toEqual({ state: 'missing', items: [] })
  })
})

describe('revision requests', () => {
  const req = (over = {}) => ({ id: newRevisionId(), outputId: OID, version: 2, runId: 'run_a', mode: 'sent' as const, scope: 'notes' as const, noteIds: ['note_0123456789abcdef'], createdAt: 5, ...over })
  it('makes ids that fit the contract regex', () => {
    expect(newRevisionId()).toMatch(/^rev_[0-9a-f]{16}$/)
  })
  it('validates a request and strips answer fields', () => {
    const r = checkRevisionRequest({ ...req(), answeredBy: 3, endedAt: 9 } as never, OID)
    expect(r.answeredBy).toBeUndefined()
    expect(r.endedAt).toBeUndefined()
    expect(() => checkRevisionRequest(req({ id: 'rev_bad' }), OID)).toThrow(/id is not valid/)
    expect(() => checkRevisionRequest(req({ mode: 'x' }), OID)).toThrow(/not valid/)
    expect(() => checkRevisionRequest(req({ scope: 'x' }), OID)).toThrow(/not valid/)
    expect(() => checkRevisionRequest(req({ runId: '' }), OID)).toThrow(/not valid/)
    expect(() => checkRevisionRequest(req({ version: 0 }), OID)).toThrow(/not valid/)
    expect(() => checkRevisionRequest(null as never, OID)).toThrow(/not valid/)
  })
  it('keeps at most OUTPUT_REVISIONS_MAX, dropping the oldest, and refuses an unreadable file', () => {
    const all = Array.from({ length: OUTPUT_REVISIONS_MAX + 5 }, (_, i) => checkRevisionRequest(req({ createdAt: i }), OID))
    writeRevisions(data, 'p1', OID, all)
    const read = readRevisions(data, 'p1', OID).items
    expect(read).toHaveLength(OUTPUT_REVISIONS_MAX)
    expect(read[0].createdAt).toBe(5)
    writeFileSync(revisionsFile(data, 'p1', OID), 'junk')
    expect(readRevisions(data, 'p1', OID).state).toBe('unreadable')
  })
})
