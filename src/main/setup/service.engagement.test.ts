import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@shared/defaults'
import type { ArchitectureSpec, Project } from '@shared/types'
import type { ProjectStore } from '../store/projects'
import { appRulesFile, engagementDocumentFile } from '../store/projectData'
import { CLAUDE_MD_MARKER, SetupService, renderEngagement } from './service'

const spec: ArchitectureSpec = {
  summary: '  A migration of the client reporting process.  ',
  stack: ['Spreadsheet workbook', 'Shared drive'],
  modules: [{ name: 'Discovery', purpose: 'Interviews and inventory.', paths: ['discovery'] }],
  conventions: ['Name files YYYY-MM-DD-topic'],
  commands: [{ name: 'Export', command: 'make export' }],
  risks: ['Late data from the client']
}

let dir: string
let data: string
let stored: Project
let service: SetupService

function fakeStore(): ProjectStore {
  return { get: () => stored, save: (p: Project) => ((stored = p), p) } as unknown as ProjectStore
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-engsetup-'))
  data = mkdtempSync(join(tmpdir(), 'orgai-engdata-'))
  stored = newProject({ name: 'Client work', path: dir, brief: 'b', kind: 'engagement', setupKind: 'new' })
  service = new SetupService(fakeStore(), { dataDir: data })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

const arch = (): Parameters<SetupService['applyProposal']>[1] =>
  ({ id: 'x', runId: 'r', createdAt: 0, kind: 'architecture', agentId: 'root', title: 'Charter', payload: spec }) as never

const settings = (payload: Record<string, unknown>): Parameters<SetupService['applyProposal']>[1] =>
  ({ id: 's', runId: 'r', createdAt: 0, kind: 'settings', agentId: 'root', title: 'Settings', payload: { brief: 'New brief', ...payload } }) as never

describe('engagement setup', () => {
  it('writes the engagement document to the data folder and leaves architecturePath unset', () => {
    const saved = service.applyProposal(stored.id, arch())
    expect(saved.setup?.architecturePath).toBeUndefined()
    expect(saved.setup?.architecture).toEqual(spec)
    const file = engagementDocumentFile(data, stored.id)
    const md = readFileSync(file, 'utf8')
    expect(md).toBe(renderEngagement('Client work', spec))
    for (const h of ['# Client work engagement', '## Summary', '## Platforms and systems', '## Workstreams', '## Working agreements and standards', '## Recurring procedures', '## Risks']) {
      expect(md).toContain(h)
    }
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('writes nothing into the working folder after architecture and settings approval', () => {
    writeFileSync(join(dir, 'Brief.docx'), 'x')
    writeFileSync(join(dir, 'CLAUDE.md'), '# Client notes\n', 'utf8')
    service.applyProposal(stored.id, arch())
    service.applyProposal(stored.id, arch())
    service.applyProposal(stored.id, settings({ allowRules: ['Bash(npm test:*)'], client: 'Northwind', isolateWriters: true, permissionMode: 'auto' }))
    expect(readdirSync(dir).sort()).toEqual(['Brief.docx', 'CLAUDE.md'])
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Client notes\n')
    expect(existsSync(join(dir, '.orgai'))).toBe(false)
    expect(existsSync(join(dir, '.claude'))).toBe(false)
  })

  it('saves allow rules in the app rules file, sets the client and leaves isolateWriters unset', () => {
    const saved = service.applyProposal(stored.id, settings({ allowRules: ['Bash(npm test:*)'], client: '  Northwind Ltd  ', isolateWriters: true }))
    const rules = JSON.parse(readFileSync(appRulesFile(data, stored.id), 'utf8')) as { permissions: { allow: string[] } }
    expect(rules.permissions.allow).toEqual(['Bash(npm test:*)'])
    expect(saved.client).toBe('Northwind Ltd')
    expect(saved.isolateWriters).toBeUndefined()
    expect(existsSync(join(dir, '.claude'))).toBe(false)
  })

  it('an empty client clears it; hidden characters and overlong names are refused', () => {
    service.applyProposal(stored.id, settings({ client: 'Northwind' }))
    expect(stored.client).toBe('Northwind')
    expect(() => service.applyProposal(stored.id, settings({ client: 'North‮wind' }))).toThrow(/invisible/)
    expect(() => service.applyProposal(stored.id, settings({ client: 'x'.repeat(121) }))).toThrow(/longer than 120/)
    expect(stored.client).toBe('Northwind')
    expect(service.applyProposal(stored.id, settings({ client: '  ' })).client).toBeUndefined()
  })

  it('refuses to save an engagement document without a data folder', () => {
    expect(() => new SetupService(fakeStore()).applyProposal(stored.id, arch())).toThrow(/data folder/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a code project still writes ARCHITECTURE.md, the CLAUDE.md pointer and settings.local.json', () => {
    stored = newProject({ name: 'Code', path: dir, brief: 'b', setupKind: 'new' })
    const saved = service.applyProposal(stored.id, arch())
    expect(saved.setup?.architecturePath).toBe('.orgai/ARCHITECTURE.md')
    expect(existsSync(join(dir, '.orgai', 'ARCHITECTURE.md'))).toBe(true)
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(text).toContain(CLAUDE_MD_MARKER)
    expect(text).toContain('before changing code')
    const after = service.applyProposal(stored.id, settings({ allowRules: ['Bash(npm test:*)'], isolateWriters: true, client: 'ignored-for-code?' }))
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(appRulesFile(data, stored.id))).toBe(false)
    expect(after.isolateWriters).toBe(true)
    expect(after.client).toBeUndefined()
  })

  it('prepare profiles the folder as an engagement without writing to it, and the hidden context names the kind', async () => {
    mkdirSync(join(dir, 'inputs'))
    writeFileSync(join(dir, 'inputs', 'survey.xlsx'), '')
    writeFileSync(join(dir, 'Brief.md'), 'Client brief')
    const prepared = await service.prepare(stored)
    expect(prepared.setup?.profile?.kind).toBe('engagement')
    expect(prepared.setup?.profile?.documents).toContain('inputs/survey.xlsx')
    const text = service.hiddenContext(prepared)
    expect(text).toContain('Project kind: engagement')
    expect(text).toContain('nothing is written to the working folder')
    expect(text).not.toContain('.orgai')
    expect(text).toContain('Working folder profile:')
    expect(text).not.toContain('Repository profile')
    expect(readdirSync(dir).sort()).toEqual(['Brief.md', 'inputs'])
  })
})
