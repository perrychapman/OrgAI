import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArchitectureSpec, Proposal, SettingsProposalPayload } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { listRules, settingsLocalPath } from '../runtime/permissionRules'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER, SetupService, cleanAllowRules, renderArchitecture } from './service'

const full: ArchitectureSpec = {
  summary: '  A small notes API.  ',
  stack: ['Node 22', 'Express 4'],
  modules: [
    { name: 'Server', purpose: 'HTTP routes.', paths: ['src/server.js'] },
    { name: 'Docs', purpose: 'Written docs.', paths: [] }
  ],
  conventions: ['ES modules only'],
  commands: [{ name: 'Test', command: 'npm test' }],
  risks: ['No persistence']
}

describe('renderArchitecture', () => {
  it('renders every section in order', () => {
    const md = renderArchitecture('Notes', full)
    expect(md).toBe(
      [
        '# Notes architecture',
        '',
        'A small notes API.',
        '',
        '## Stack',
        '',
        '- Node 22',
        '- Express 4',
        '',
        '## Modules',
        '',
        '### Server',
        '',
        'HTTP routes.',
        '',
        '- `src/server.js`',
        '',
        '### Docs',
        '',
        'Written docs.',
        '',
        '## Conventions',
        '',
        '- ES modules only',
        '',
        '## Commands',
        '',
        '- Test: `npm test`',
        '',
        '## Risks and gaps',
        '',
        '- No persistence',
        '',
        '_Maintained by OrgAI. Approved by the project owner during setup._',
        ''
      ].join('\n')
    )
  })

  it('omits empty sections', () => {
    const md = renderArchitecture('Bare', { summary: 'Just a summary.', stack: [], modules: [], conventions: [], commands: [], risks: [] })
    expect(md).toBe('# Bare architecture\n\nJust a summary.\n\n_Maintained by OrgAI. Approved by the project owner during setup._\n')
    expect(md).not.toMatch(/^## /m)
  })

  it('exports the paths the CLAUDE.md block relies on', () => {
    expect(ARCHITECTURE_PATH).toBe('.orgai/ARCHITECTURE.md')
    expect(CLAUDE_MD_MARKER).toMatch(/^<!--.*-->$/)
  })
})

describe('applyProposal (settings)', () => {
  let dir: string
  let repo: string
  let store: ProjectStore
  let service: SetupService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-setup-'))
    repo = join(dir, 'repo')
    mkdirSync(repo)
    store = new ProjectStore(join(dir, 'data'))
    service = new SetupService(store)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const settings = (projectId: string, payload: Omit<SettingsProposalPayload, 'rationale'>): Proposal => ({
    id: 'prop-1',
    runId: 'run-1',
    agentId: 'root',
    title: 'Settings',
    createdAt: 0,
    kind: 'settings',
    payload: { rationale: 'r', ...payload }
  })

  it('applies the unattended mode and run limits, clamped to the new maxima', () => {
    const p = store.create({ name: 'X', path: repo, brief: '' })
    const next = service.applyProposal(p.id, settings(p.id, { permissionMode: 'auto', maxConcurrentSubagents: 99, maxSubagentDepth: 9 }))
    expect(next.permissionMode).toBe('auto')
    expect(next.maxConcurrentSubagents).toBe(32)
    expect(next.maxSubagentDepth).toBe(5)
    const dont = service.applyProposal(p.id, settings(p.id, { permissionMode: 'dontAsk' }))
    expect(dont.permissionMode).toBe('dontAsk')
    // An unknown mode leaves the current one alone.
    const bogus = service.applyProposal(p.id, settings(p.id, { permissionMode: 'yolo' as never }))
    expect(bogus.permissionMode).toBe('dontAsk')
  })

  it('applies the unattended-execution settings, clamping the continue limit', () => {
    const p = store.create({ name: 'X', path: repo, brief: '' })
    const next = service.applyProposal(p.id, settings(p.id, { autoContinue: false, maxAutoContinues: 12.7 }))
    expect(next.autoContinue).toBe(false)
    expect(next.maxAutoContinues).toBe(12)
    const big = service.applyProposal(p.id, settings(p.id, { autoContinue: true, maxAutoContinues: 100000 }))
    expect(big.autoContinue).toBe(true)
    expect(big.maxAutoContinues).toBe(500)
    expect(service.applyProposal(p.id, settings(p.id, { brief: 'b' })).maxAutoContinues).toBe(500)
  })

  it('merges proposed allow rules into .claude/settings.local.json without duplicates or other keys lost', () => {
    const p = store.create({ name: 'X', path: repo, brief: '' })
    mkdirSync(join(repo, '.claude'))
    writeFileSync(settingsLocalPath(repo), JSON.stringify({ env: { A: '1' }, permissions: { allow: ['Bash(npm:*)'], deny: ['Read(.env)'] } }))
    service.applyProposal(p.id, settings(p.id, { allowRules: ['Bash(npm:*)', 'Bash(git status:*)', ' Bash(git diff:*) ', 'Bash(git status:*)'] }))
    expect(listRules(repo)).toEqual(['Bash(npm:*)', 'Bash(git status:*)', 'Bash(git diff:*)'])
    const file = JSON.parse(readFileSync(settingsLocalPath(repo), 'utf8'))
    expect(file.env).toEqual({ A: '1' })
    expect(file.permissions.deny).toEqual(['Read(.env)'])
  })

  it('creates the settings file when the project has none, and drops destructive rules', () => {
    const p = store.create({ name: 'X', path: repo, brief: '' })
    service.applyProposal(p.id, settings(p.id, { allowRules: ['Bash(npx:*)', 'Bash(rm:*)', 'Bash(git push:*)', 'Bash', 'Bash(sudo apt:*)', 'Bash(git reset --hard:*)'] }))
    expect(listRules(repo)).toEqual(['Bash(npx:*)'])
  })

  it('writes nothing when no rules are proposed', () => {
    const p = store.create({ name: 'X', path: repo, brief: '' })
    service.applyProposal(p.id, settings(p.id, { brief: 'New brief' }))
    expect(listRules(repo)).toEqual([])
    expect(store.get(p.id)?.brief).toBe('New brief')
  })
})

describe('cleanAllowRules', () => {
  it('keeps safe rule strings and drops junk', () => {
    expect(cleanAllowRules(undefined)).toEqual([])
    expect(cleanAllowRules(['Bash(node:*)', 3, '', '  ', 'WebSearch', 'Bash(*)', 'Bash(git log:*)'])).toEqual(['Bash(node:*)', 'WebSearch', 'Bash(git log:*)'])
  })
})
