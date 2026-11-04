import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@shared/defaults'
import type { ArchitectureSpec, Project } from '@shared/types'
import type { ProjectStore } from '../store/projects'
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
let stored: Project
let service: SetupService

function fakeStore(): ProjectStore {
  return { get: () => stored, save: (p: Project) => ((stored = p), p) } as unknown as ProjectStore
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-engsetup-'))
  stored = newProject({ name: 'Client work', path: dir, brief: 'b', kind: 'engagement', setupKind: 'new' })
  service = new SetupService(fakeStore())
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const arch = (): Parameters<SetupService['applyProposal']>[1] =>
  ({ id: 'x', runId: 'r', createdAt: 0, kind: 'architecture', agentId: 'root', title: 'Charter', payload: spec }) as never

describe('engagement setup', () => {
  it('writes .orgai/ENGAGEMENT.md with engagement headings and records the path', () => {
    const saved = service.applyProposal(stored.id, arch())
    expect(saved.setup?.architecturePath).toBe('.orgai/ENGAGEMENT.md')
    expect(existsSync(join(dir, '.orgai', 'ARCHITECTURE.md'))).toBe(false)
    const md = readFileSync(join(dir, '.orgai', 'ENGAGEMENT.md'), 'utf8')
    expect(md).toBe(renderEngagement('Client work', spec))
    for (const h of ['# Client work engagement', '## Summary', '## Platforms and systems', '## Workstreams', '## Working agreements and standards', '## Recurring procedures', '## Risks']) {
      expect(md).toContain(h)
    }
    expect(md).not.toMatch(/## (Stack|Modules|Commands|Conventions)/)
  })

  it('points CLAUDE.md at the engagement document with engagement wording', () => {
    service.applyProposal(stored.id, arch())
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(text).toContain(CLAUDE_MD_MARKER)
    expect(text).toContain('Read `.orgai/ENGAGEMENT.md` before starting work. It records the agreed engagement, workstreams, working agreements and deliverable standards. Keep it current when they change.')
    expect(text).not.toContain('before changing code')
  })

  it('keeps an existing CLAUDE.md and does not add the pointer twice', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Notes\n\nHand written.\n', 'utf8')
    service.applyProposal(stored.id, arch())
    service.applyProposal(stored.id, arch())
    const text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
    expect(text.startsWith('# Notes\n\nHand written.')).toBe(true)
    expect(text.split(CLAUDE_MD_MARKER)).toHaveLength(2)
  })

  it('a code project still writes ARCHITECTURE.md', () => {
    stored = newProject({ name: 'Code', path: dir, brief: 'b', setupKind: 'new' })
    const saved = service.applyProposal(stored.id, arch())
    expect(saved.setup?.architecturePath).toBe('.orgai/ARCHITECTURE.md')
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('before changing code')
  })

  it('prepare profiles the folder as an engagement and the hidden context names the kind', async () => {
    mkdirSync(join(dir, 'inputs'))
    writeFileSync(join(dir, 'inputs', 'survey.xlsx'), '')
    writeFileSync(join(dir, 'Brief.md'), 'Client brief')
    const prepared = await service.prepare(stored)
    expect(prepared.setup?.profile?.kind).toBe('engagement')
    expect(prepared.setup?.profile?.documents).toContain('inputs/survey.xlsx')
    const text = service.hiddenContext(prepared)
    expect(text).toContain('Project kind: engagement')
    expect(text).toContain('Working folder profile:')
    expect(text).toContain('Documents:')
    expect(text).not.toContain('Repository profile')
  })
})
