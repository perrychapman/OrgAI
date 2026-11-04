import { describe, expect, it } from 'vitest'
import { engagementRoles, modelForTier, newProject, projectDocumentName, projectDocumentPath, projectKindLabel, projectKindOf, runMessagingOn, type TierContext } from './defaults'
import { architectPrompt, architectRole } from './setup'
import { isProjectKind } from './types'

describe('project kind helpers', () => {
  it('projectKindOf falls back to code for anything else', () => {
    expect(projectKindOf({ kind: 'engagement' })).toBe('engagement')
    expect(projectKindOf({ kind: 'code' })).toBe('code')
    expect(projectKindOf({})).toBe('code')
    expect(projectKindOf({ kind: 'junk' })).toBe('code')
    expect(projectKindOf(null)).toBe('code')
    expect(projectKindOf(undefined)).toBe('code')
    expect(isProjectKind('engagement')).toBe(true)
    expect(isProjectKind('Engagement')).toBe(false)
    expect(isProjectKind(undefined)).toBe(false)
  })

  it('labels, document paths and names follow the kind', () => {
    expect(projectKindLabel('code')).toBe('Project')
    expect(projectKindLabel('engagement')).toBe('Engagement')
    expect(projectDocumentPath('code')).toBe('.orgai/ARCHITECTURE.md')
    expect(projectDocumentPath('engagement')).toBe('.orgai/ENGAGEMENT.md')
    expect(projectDocumentName('engagement')).toBe('the engagement document')
    expect(projectDocumentName('code')).toBe('the architecture document')
  })

  it('run messaging defaults off for engagements, on for code; an explicit value wins', () => {
    expect(runMessagingOn({ kind: 'engagement' })).toBe(false)
    expect(runMessagingOn({ kind: 'engagement', runMessaging: true })).toBe(true)
    expect(runMessagingOn({})).toBe(true)
    expect(runMessagingOn({ kind: 'code', runMessaging: false })).toBe(false)
    expect(runMessagingOn(null)).toBe(true)
  })
})

describe('newProject kind', () => {
  it('stores the kind and picks the matching chart in both branches', () => {
    const code = newProject({ name: 'A', path: '/a', brief: '' })
    expect(code.kind).toBe('code')
    expect(code.roles.map((r) => r.slug)).toEqual(['orchestrator', 'implementer', 'reviewer', 'researcher'])
    const eng = newProject({ name: 'B', path: '/b', brief: '', kind: 'engagement' })
    expect(eng.kind).toBe('engagement')
    expect(eng.roles.map((r) => r.slug)).toEqual(['engagement-lead', 'specialist', 'analyst', 'writer', 'reviewer'])
    expect(newProject({ name: 'C', path: '/c', brief: '', kind: 'junk' as never }).kind).toBe('code')
  })
})

const ctx: TierContext = { connection: 'anthropic', tierModels: {} }
const BANNED = ['IGA', 'SailPoint', 'tax', 'clinical', 'legal', 'patient', 'audit firm', 'bank']
const wordsOf = (s: string): string[] => s.split(/\s+/).filter(Boolean)
const mentions = (text: string, term: string): boolean => new RegExp(`(^|[^A-Za-z0-9])${term}([^A-Za-z0-9]|$)`, 'i').test(text)

describe('engagement chart', () => {
  const roles = engagementRoles(ctx)
  const ids = new Set(roles.map((r) => r.id))

  it('has exactly one root whose spawnable list is its direct reports', () => {
    const roots = roles.filter((r) => r.reportsTo === null)
    expect(roots).toHaveLength(1)
    const root = roots[0]
    expect(root.slug).toBe('engagement-lead')
    expect(root.canSpawn).toBe(true)
    expect([...root.spawnable].sort()).toEqual(roles.filter((r) => r.reportsTo === root.id).map((r) => r.id).sort())
    for (const r of roles) {
      if (r.reportsTo !== null) expect(ids.has(r.reportsTo)).toBe(true)
      if (r !== root) expect(r.canSpawn).toBe(false)
    }
  })

  it('the lead never writes; the reviewer and specialist are read-only; writers cannot spawn', () => {
    const by = Object.fromEntries(roles.map((r) => [r.slug, r]))
    expect(by['engagement-lead'].tools).not.toContain('Edit')
    expect(by['engagement-lead'].tools).not.toContain('Write')
    expect(by['engagement-lead'].tools).not.toContain('Bash')
    for (const slug of ['specialist', 'reviewer']) {
      expect(by[slug].tools.some((t) => ['Edit', 'Write', 'Bash'].includes(t))).toBe(false)
    }
    expect(by.analyst.tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']))
    expect(by.writer.tools).toEqual(expect.arrayContaining(['Edit', 'Write']))
  })

  it('resolves models through tiers, never a vendor name', () => {
    for (const r of roles) {
      const resolved = modelForTier(r.tier ?? 'everyday', ctx)
      expect(r.model).toBe(resolved?.model ?? 'inherit')
    }
    const tiers = Object.fromEntries(roles.map((r) => [r.slug, r.tier ?? 'inherit']))
    if (modelForTier('deep', ctx)) {
      expect(tiers['engagement-lead']).toBe('deep')
      expect(tiers.specialist).toBe('deep')
      expect(tiers.writer).toBe('everyday')
    }
    // A connection that maps nothing leaves every role on 'inherit'.
    const none = engagementRoles({ connection: 'litellm', tierModels: {} })
    expect(modelForTier('deep', { connection: 'litellm', tierModels: {} })).toBeUndefined()
    expect(none.every((r) => r.model === 'inherit')).toBe(true)
  })

  it('prompts are 60 to 160 words and writing roles name read-only reference folders and file reporting', () => {
    for (const r of roles) {
      const n = wordsOf(r.prompt).length
      expect(n, r.slug).toBeGreaterThanOrEqual(60)
      expect(n, r.slug).toBeLessThanOrEqual(160)
    }
    for (const slug of ['analyst', 'writer', 'engagement-lead']) {
      const r = roles.find((x) => x.slug === slug)!
      expect(r.prompt, slug).toMatch(/reference folders are read-only/i)
    }
    for (const slug of ['analyst', 'writer']) {
      expect(roles.find((x) => x.slug === slug)!.prompt, slug).toMatch(/every file you|files you created or changed|which files/i)
    }
  })

  it('names no field of work', () => {
    const texts = [
      ...roles.flatMap((r) => [r.name, r.description, r.prompt, ...r.responsibilities]),
      architectPrompt('engagement')
    ]
    for (const term of BANNED) {
      for (const t of texts) expect(mentions(t, term), term).toBe(false)
    }
  })
})

describe('architectPrompt', () => {
  it('the code prompt is the original text', () => {
    const code = architectPrompt('code')
    expect(code.startsWith('You are the Architect for OrgAI, a desktop harness that runs an org chart of AI coding agents on a software project.')).toBe(true)
    expect(code).toContain('The harness writes the approved architecture to .orgai/ARCHITECTURE.md')
    expect(code).not.toContain('ENGAGEMENT.md')
    expect(architectRole().prompt).toBe(code)
    expect(architectRole(undefined, { kind: 'code' }).prompt).toBe(code)
  })

  it('the engagement prompt writes ENGAGEMENT.md and asks at most five questions in one batch', () => {
    const p = architectPrompt('engagement')
    expect(p).toContain('.orgai/ENGAGEMENT.md')
    expect(p).not.toContain('.orgai/ARCHITECTURE.md')
    expect(p).toMatch(/ONE message of at most five questions/)
    const interview = p.split('\n').find((l) => l.startsWith('1. Interview first'))!
    for (const topic of ['client', 'field of work', 'platforms or systems', 'phase', 'deliverables', 'coding']) expect(interview).toContain(topic)
    expect(p).toMatch(/never edit them/)
    expect(p).toMatch(/only when coding is in scope/)
    expect(p).toMatch(/only when the working folder is a git repository/)
    expect(architectRole(undefined, { kind: 'engagement' }).prompt).toBe(p)
    expect(p).not.toBe(architectPrompt('code'))
  })
})
