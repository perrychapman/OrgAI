import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@shared/types'
import { appReferenceText, collapseSelfHelp } from './selfHelpRows'

let n = 0
const entry = (block: TranscriptEntry['block'], source?: 'harness'): TranscriptEntry => ({ id: `e${++n}`, agentId: 'root', at: n, block, ...(source ? { source } : {}) }) as TranscriptEntry
const call = (name: string, input: Record<string, unknown>): TranscriptEntry => entry({ kind: 'tool_use', id: `t${++n}`, name, input })
const result = (c: TranscriptEntry, content: string, isError = false): TranscriptEntry =>
  entry({ kind: 'tool_result', toolUseId: c.block.kind === 'tool_use' ? c.block.id : '', content, isError })
const harness = (text: string): TranscriptEntry => entry({ kind: 'system', text }, 'harness')

describe('appReferenceText', () => {
  it('words each action', () => {
    expect(appReferenceText({ action: 'search', query: 'dark mode' })).toBe("Looked up dark mode in OrgAI's reference")
    expect(appReferenceText({ action: 'locate', query: 'x'.repeat(100) })).toMatch(/^Looked up x{59}… in/)
    expect(appReferenceText({ action: 'read', id: 'a' })).toBe("Read a section of OrgAI's reference")
    expect(appReferenceText({ action: 'status' })).toBe("Checked OrgAI's status")
    expect(appReferenceText({ action: 'search' })).toBe("Looked up OrgAI's reference")
  })
  it('shows hidden characters instead of passing them on', () => {
    expect(appReferenceText({ action: 'search', query: 'a‮b' })).not.toContain('‮')
  })
})

describe('collapseSelfHelp', () => {
  for (const name of ['app_reference', 'mcp__orgai__app_reference']) {
    it(`folds ${name} and its result into one row`, () => {
      const c = call(name, { action: 'search', query: 'theme' })
      const r = result(c, 'Appearance: pick a theme')
      const out = collapseSelfHelp([c, r])
      expect(out.hidden.has(r.id)).toBe(true)
      expect(out.hidden.has(c.id)).toBe(false)
      expect(out.rows.get(c.id)).toEqual({ tool: 'app_reference', text: "Looked up theme in OrgAI's reference", body: 'Appearance: pick a theme' })
    })
  }
  it('folds list_projects and its result into one quiet row', () => {
    const c = call('mcp__orgai__list_projects', {})
    const r = result(c, '1 OrgAI project.')
    const out = collapseSelfHelp([c, r])
    expect(out.hidden.has(r.id)).toBe(true)
    expect(out.rows.get(c.id)).toEqual({ tool: 'list_projects', text: 'Listed your OrgAI projects', body: '1 OrgAI project.' })
  })
  it('keeps a refused app_reference result visible', () => {
    const c = call('app_reference', { action: 'read', id: 'zzz' })
    const r = result(c, 'REFUSED: unknown section')
    const out = collapseSelfHelp([c, r])
    expect(out.rows.size).toBe(0)
    expect(out.hidden.size).toBe(0)
  })
  it('shows a pending app_reference call as a row with no output', () => {
    const c = call('app_reference', { action: 'status' })
    expect(collapseSelfHelp([c]).rows.get(c.id)).toMatchObject({ text: "Checked OrgAI's status", body: undefined })
  })
  it('collapses open_in_app into the harness row', () => {
    const c = call('mcp__orgai__open_in_app', { surfaceId: 'app-settings-general-appearance' })
    const r = result(c, 'Opened.')
    const h = harness('Opened App settings › General › Appearance for you')
    const out = collapseSelfHelp([c, r, h])
    expect(out.hidden.has(c.id) && out.hidden.has(r.id)).toBe(true)
    expect(out.rows.get(h.id)).toEqual({ tool: 'open_in_app', text: 'Opened App settings › General › Appearance for you' })
  })
  it('keeps a refused open_in_app call, relabelled', () => {
    const c = call('open_in_app', { surfaceId: 'nope' })
    const r = result(c, 'REFUSED: no such place')
    const out = collapseSelfHelp([c, r])
    expect(out.hidden.size).toBe(0)
    expect(out.labels.get(c.id)).toBe('Tried to open a place in OrgAI')
  })
  it('leaves a pending open_in_app call alone', () => {
    const c = call('open_in_app', { surfaceId: 'x' })
    const out = collapseSelfHelp([c])
    expect(out.labels.size).toBe(0)
    expect(out.hidden.size).toBe(0)
  })
  it('words the propose calls', () => {
    const a = call('propose_app_settings', { changes: [] })
    const p = call('mcp__orgai__propose_project_settings', { projectId: 'p1' })
    const q = call('propose_project_settings', { projectId: 'gone' })
    const out = collapseSelfHelp([a, p, q], (id) => (id === 'p1' ? 'Notes API' : undefined))
    expect(out.labels.get(a.id)).toBe('Proposed app settings')
    expect(out.labels.get(p.id)).toBe('Proposed settings for Notes API')
    expect(out.labels.get(q.id)).toBe('Proposed settings for a project')
  })
})
